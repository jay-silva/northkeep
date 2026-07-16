/**
 * A ConnectorStorage-backed OAuthServerProvider + OAuthRegisteredClientsStore
 * (SDK 1.29.0). This is THE difference from the C0 spike: every artifact the
 * SDK's authorize/token/register handlers produce — registered clients,
 * authorization codes, access tokens, refresh tokens — is persisted in the
 * storage layer, never an in-process Map. Any serverless instance can therefore
 * serve any request; a token minted on one Vercel worker validates on the next
 * (the exact C0 failure mode C1 fixes).
 *
 * Persistence discipline: raw code/token values are hashed (sha256) before they
 * touch storage. The account binding (which pairing code was accepted) is
 * carried on the authorization-code row and copied onto the token row, so it
 * survives all the way to `AuthInfo.extra.accountHash`, where the /mcp tool
 * layer uses it to scope every query. Scope isolation physically lives on that
 * thread.
 *
 * The consent step (entering the pairing code) is NOT here: the SDK strips
 * unknown params before calling `authorize`, so `authorize` only RENDERS the
 * consent page. The real account binding + code minting happens in the
 * server's own POST /consent route (see server.ts), which calls
 * `mintAuthorizationCode` below.
 */

import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ConnectorStorage } from './storage.js';
import { renderConsentPage } from './consent.js';
import { sha256hex, randomToken } from './hash.js';
import {
  ConnectorCryptoError,
  KEK_LABEL_AUTH_CODE,
  KEK_LABEL_TOKEN,
  deriveKek,
  unwrapDek,
  wrapDek,
} from './crypto.js';

const CODE_TTL_MS = 5 * 60 * 1000; // authorization codes live 5 min
const ACCESS_TTL_SEC = 60 * 60; // access tokens live 1 hour
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // refresh tokens live 30 days

class ConnectorClientsStore implements OAuthRegisteredClientsStore {
  constructor(private storage: ConnectorStorage) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.storage.getClient(clientId);
  }

  // RFC 7591 DCR. The SDK's register handler has already generated
  // client_id/client_secret and validated metadata; we persist and echo it.
  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const secretHash = client.client_secret ? sha256hex(client.client_secret) : null;
    await this.storage.registerClient(client, secretHash);
    return client;
  }
}

export class ConnectorOAuthProvider implements OAuthServerProvider {
  private _clientsStore: ConnectorClientsStore;

  /**
   * @param mcpResourceUrl canonical RFC 8707 resource id, e.g. https://host/mcp
   * @param kekPepper server-environment pepper mixed into every KEK (ADR 0020)
   */
  constructor(
    private storage: ConnectorStorage,
    private mcpResourceUrl: string,
    private kekPepper: Uint8Array,
  ) {
    this._clientsStore = new ConnectorClientsStore(storage);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  /**
   * RFC 8707 audience match. Exact string equality except a single optional
   * trailing slash is ignored — a spec-compliant client echoes `prm.resource`
   * verbatim (already an exact match), and this only softens the one benign
   * divergence (a client that normalizes with a trailing slash) that would
   * otherwise 401 real traffic after everything looked green. Still fail-closed
   * against a genuinely different origin/path.
   */
  private matchesAudience(resourceHref: string): boolean {
    const strip = (s: string): string => s.replace(/\/+$/, '');
    return strip(resourceHref) === strip(this.mcpResourceUrl);
  }

  // ---- authorize: RENDER the consent page only ---------------------------
  // Unlike C0 (auto-approve), a human must enter their pairing code. We can't
  // mint a code here because the SDK doesn't hand us the pairing code (it's not
  // an OAuth param). So we render an HTML form carrying every OAuth param as a
  // hidden field plus a pairing-code input; it POSTs to /consent, which does
  // the account binding + code minting. Fail-closed: no pairing code, no grant.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.type('html').send(
      renderConsentPage({
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scope: (params.scopes ?? []).join(' '),
        resource: params.resource?.href ?? this.mcpResourceUrl,
      }),
    );
  }

  /**
   * Called by /consent AFTER a pairing code has been validated, resolved to an
   * accountHash, and its DEK unwrapped (ADR 0020 chain of custody). Persists the
   * authorization code (hashed) bound to that account, with the DEK re-wrapped
   * under a KEK derived from THIS code's plaintext — the raw code exists only in
   * the redirect; the row alone can never unwrap. Returns the raw code. RFC
   * 8707: the requested resource must be our /mcp audience.
   */
  async mintAuthorizationCode(args: {
    clientId: string;
    accountHash: string;
    codeChallenge: string;
    redirectUri: string;
    resource: string;
    dek: Uint8Array;
  }): Promise<string> {
    if (!this.matchesAudience(args.resource)) {
      throw new InvalidTargetError('Resource does not match this connector (RFC 8707)');
    }
    const code = randomToken();
    const codeKek = await deriveKek(KEK_LABEL_AUTH_CODE, code, this.kekPepper);
    await this.storage.putCode(sha256hex(code), {
      clientId: args.clientId,
      accountHash: args.accountHash,
      pkceChallenge: args.codeChallenge,
      redirectUri: args.redirectUri,
      audience: this.mcpResourceUrl,
      expiresAt: Date.now() + CODE_TTL_MS,
      dekWrap: await wrapDek(args.dek, codeKek),
    });
    return code;
  }

  // ---- PKCE: non-consuming read of the stored challenge ------------------
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const rec = await this.storage.getCode(sha256hex(authorizationCode));
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return rec.pkceChallenge;
  }

  // ---- code -> access token (+ refresh) ---------------------------------
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Atomic single-use consume — a replayed code finds nothing here.
    const rec = await this.storage.consumeCode(sha256hex(authorizationCode));
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    // RFC 8707: if the token request names a resource, it must be our /mcp.
    if (resource && !this.matchesAudience(resource.href)) {
      throw new InvalidTargetError('Resource does not match this connector (RFC 8707)');
    }
    // ADR 0020: unwrap the account DEK with a KEK derived from the presented
    // code's plaintext, then re-wrap it for the new token pair. A row without a
    // working wrap cannot carry custody forward — fail the grant, never issue a
    // token that could not decrypt.
    let dek: Uint8Array;
    try {
      dek = await unwrapDek(rec.dekWrap, await deriveKek(KEK_LABEL_AUTH_CODE, authorizationCode, this.kekPepper));
    } catch (err) {
      if (err instanceof ConnectorCryptoError) {
        throw new InvalidGrantError('Invalid or expired authorization code');
      }
      throw err;
    }
    return this.issueTokenPair(client.client_id, rec.accountHash, dek);
  }

  // ---- refresh token rotation -------------------------------------------
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    // ONE atomic consume (ADR 0020): the row is deleted in the same statement
    // that reads it, so two concurrent exchanges of the same refresh token can
    // never both succeed — the loser gets invalid_grant. This replaces the
    // pre-existing get-then-delete flow (a real OAuth 2.1 rotation race).
    const rec = await this.storage.consumeToken(sha256hex(refreshToken));
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (resource && !this.matchesAudience(resource.href)) {
      throw new InvalidTargetError('Resource does not match this connector (RFC 8707)');
    }
    // Custody: unwrap the DEK with the presented refresh token's KEK, re-wrap
    // for the rotated pair. A pre-0020 row (no wrap) cannot be re-wrapped —
    // invalid_grant sends the client through a full re-authorization.
    let dek: Uint8Array;
    try {
      dek = await unwrapDek(rec.dekWrap, await deriveKek(KEK_LABEL_TOKEN, refreshToken, this.kekPepper));
    } catch (err) {
      if (err instanceof ConnectorCryptoError) {
        throw new InvalidGrantError('Invalid or expired refresh token');
      }
      throw err;
    }
    return this.issueTokenPair(client.client_id, rec.accountHash, dek);
  }

  private async issueTokenPair(clientId: string, accountHash: string, dek: Uint8Array): Promise<OAuthTokens> {
    const nowSec = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    // Each token row carries its OWN wrap of the account DEK, under a KEK
    // derived from that token's plaintext — the DB rows alone unwrap nothing.
    const accessWrap = await wrapDek(dek, await deriveKek(KEK_LABEL_TOKEN, accessToken, this.kekPepper));
    const refreshWrap = await wrapDek(dek, await deriveKek(KEK_LABEL_TOKEN, refreshToken, this.kekPepper));
    await this.storage.putToken(sha256hex(accessToken), {
      clientId,
      accountHash,
      audience: this.mcpResourceUrl,
      kind: 'access',
      expiresAt: nowSec + ACCESS_TTL_SEC,
      dekWrap: accessWrap,
    });
    await this.storage.putToken(sha256hex(refreshToken), {
      clientId,
      accountHash,
      audience: this.mcpResourceUrl,
      kind: 'refresh',
      expiresAt: nowSec + REFRESH_TTL_SEC,
      dekWrap: refreshWrap,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: 'mcp',
    };
  }

  // ---- token verification (bearer middleware) ---------------------------
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = await this.storage.getToken(sha256hex(token));
    if (!rec || rec.kind !== 'access') {
      throw new InvalidTokenError('Unknown or revoked access token');
    }
    // The SDK middleware enforces expiry + scopes but NOT audience. Enforce the
    // RFC 8707 audience binding here: this token must be for our /mcp resource.
    if (!this.matchesAudience(rec.audience)) {
      throw new InvalidTokenError('Token audience does not match this resource');
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: ['mcp'],
      expiresAt: rec.expiresAt,
      resource: new URL(rec.audience),
      // The account binding rides here → the /mcp tool layer scopes every query
      // by it. This is where cross-account isolation physically lives. The DEK
      // wrap rides alongside (ADR 0020) so the /mcp handler can unwrap with the
      // presented token's KEK without a second storage read.
      extra: { accountHash: rec.accountHash, dekWrap: rec.dekWrap },
    };
  }

  // Enabling revoke makes the SDK advertise /revoke in AS metadata.
  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    if (request?.token) await this.storage.deleteToken(sha256hex(request.token));
  }
}
