import http from 'node:http';
import { execFile } from 'node:child_process';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { sanitizeServerText } from './client.js';
import { loadCredentials, saveCredentials, tokenStoreAvailable, updateCredentials } from './tokens.js';

/**
 * OAuth for remote MCP servers (ADR 0035 Decisions 7 and 8).
 *
 * Two things here are deliberately unlike a normal OAuth client.
 *
 * 1. `redirectToAuthorization` DOES NOT open a browser. It captures the URL.
 *    The SDK's contract is "send the user here", but ADR 0035 Decision 7
 *    records that the server names its own authorization server, and that the
 *    `authorization_servers[0]` entry is not constrained to the MCP server's
 *    origin. An implementation that opened it immediately would be a primitive
 *    for making a trusted local app launch the user's browser at an
 *    attacker-chosen URL, framed as "NorthKeep connecting your account". So the
 *    URL is captured, its origin is shown to the caller, and the caller decides.
 *
 * 2. The callback listener is SHORT-LIVED AND OURS. ADR 0035 Decision 8
 *    anticipated adding an unauthenticated `/oauth/callback` route to the GUI
 *    server, with a CSP carve-out. This does not do that. A dedicated loopback
 *    listener is started only while a connect is in flight, serves exactly one
 *    request, and closes — so the GUI's token gate and its
 *    `default-src 'none'` CSP are never relaxed, and there is no permanently
 *    open unauthenticated route. It is also the SAME code the CLI uses, rather
 *    than a second listening surface with its own bugs.
 */

/**
 * Fixed loopback callback. Fixed rather than ephemeral because providers
 * require an exactly pre-registered redirect URI (Google among them), and the
 * GUI server's own port is random (`port ?? 0`), so it could never be it.
 * 127.0.0.1 rather than `localhost` so the name cannot be redirected by a hosts
 * file or a resolver.
 */
export const OAUTH_CALLBACK_PORT = 8788;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/oauth/callback`;

export class OAuthNotAvailableError extends Error {}

export interface ProviderOptions {
  serverId: string;
  /** The configured origin. Stored WITH the credentials so a URL edit is detectable. */
  origin: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

/**
 * `OAuthClientProvider` over the Keychain store. One instance per connect
 * attempt; all persistence goes through tokens.ts, so nothing secret is held
 * only in memory across a restart and nothing secret reaches a file.
 */
export class KeychainOAuthProvider implements OAuthClientProvider {
  /** Set by redirectToAuthorization; read by the caller to decide whether to open it. */
  authorizationUrl: URL | null = null;

  constructor(private readonly opts: ProviderOptions) {}

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'NorthKeep',
      redirect_uris: [OAUTH_REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client with PKCE. We hold a client secret only when the user
      // pasted one from a provider that issues them; the SDK selects the auth
      // method from what it discovers, and `none` is the honest default for a
      // desktop app whose "secret" would ship inside a downloadable binary.
      token_endpoint_auth_method: 'none',
      ...(this.opts.scope !== undefined ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = loadCredentials(this.opts.serverId)?.client;
    // A pasted client id from the config wins on first connect, before anything
    // is stored. Google and Claude both require this path: their remote MCP
    // servers do not support dynamic registration, so BYO credentials is the
    // primary route, not a fallback.
    const clientId = stored?.client_id ?? this.opts.clientId;
    if (clientId === undefined) return undefined;
    const secret = stored?.client_secret ?? this.opts.clientSecret;
    return { client_id: clientId, ...(secret !== undefined ? { client_secret: secret } : {}) };
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await updateCredentials(this.opts.serverId, (cur) => ({
      ...(cur ?? { origin: this.opts.origin }),
      origin: this.opts.origin,
      client: {
        client_id: info.client_id,
        ...(info.client_secret !== undefined ? { client_secret: info.client_secret } : {}),
        ...(info.client_secret_expires_at !== undefined
          ? { client_secret_expires_at: info.client_secret_expires_at }
          : {}),
      },
    }));
  }

  tokens(): OAuthTokens | undefined {
    const rec = loadCredentials(this.opts.serverId);
    // A grant issued for a different origin is not this server's grant. This is
    // ADR 0035 Decision 6's enforcement at its narrowest point: even if the
    // config was edited to a new URL, the old token is never presented to it.
    if (rec === null || rec.origin !== this.opts.origin || rec.tokens === undefined) return undefined;
    const { obtained_at: _ignored, ...tokens } = rec.tokens;
    return tokens as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await updateCredentials(this.opts.serverId, (cur) => ({
      ...(cur ?? { origin: this.opts.origin }),
      origin: this.opts.origin,
      tokens: {
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        ...(tokens.expires_in !== undefined ? { expires_in: tokens.expires_in } : {}),
        // A refresh token is only ever REPLACED by a new one, never cleared by
        // a response that omits it — providers that do not rotate simply leave
        // it out, and dropping it there would silently end the grant.
        ...(tokens.refresh_token !== undefined
          ? { refresh_token: tokens.refresh_token }
          : cur?.tokens?.refresh_token !== undefined
            ? { refresh_token: cur.tokens.refresh_token }
            : {}),
        ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
        obtained_at: Date.now(),
      },
    }));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl; // captured, NOT opened — see the header note
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateCredentials(this.opts.serverId, (cur) => ({
      ...(cur ?? { origin: this.opts.origin }),
      origin: this.opts.origin,
      codeVerifier,
    }));
  }

  codeVerifier(): string {
    const v = loadCredentials(this.opts.serverId)?.codeVerifier;
    if (v === undefined) throw new Error('No PKCE verifier is stored for this server. Start the sign-in again.');
    return v;
  }

  /** Clear what the server told us is no longer good, so the next attempt is clean. */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const cur = loadCredentials(this.opts.serverId);
    if (cur === null) return;
    if (scope === 'discovery') return;
    const next = { ...cur };
    if (scope === 'all' || scope === 'tokens') delete next.tokens;
    if (scope === 'all' || scope === 'client') delete next.client;
    if (scope === 'all' || scope === 'verifier') delete next.codeVerifier;
    saveCredentials(this.opts.serverId, next);
  }
}

export interface CallbackResult {
  code: string;
  state: string | null;
}

/**
 * Wait for exactly one authorization callback on the fixed loopback port.
 *
 * Bound to 127.0.0.1 explicitly, so this never listens on a routable interface.
 * It answers ONE request and closes: the window in which anything can talk to
 * it is the seconds between opening the browser and the user finishing sign-in.
 *
 * `state` is compared by the caller. Note what that is and is not: state proves
 * this response belongs to the request we started, which is CSRF protection. It
 * is not authentication of the caller, and this listener does not pretend
 * otherwise — that is why it does not exist except during a connect.
 */
export function awaitOAuthCallback(
  expectedState: string | null,
  timeoutMs = 5 * 60 * 1000,
): { result: Promise<CallbackResult>; cancel: () => void } {
  let settle: ((r: CallbackResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`);
    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    // The page is a fixed string with no scripts, no styles from anywhere, and
    // nothing interpolated from the query — the provider controls those values
    // and this page is rendered by the user's browser.
    const page = (heading: string, detail: string): string =>
      `<!doctype html><meta charset="utf-8"><title>NorthKeep</title>` +
      `<body style="font:16px -apple-system,system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${heading}</h1><p>${detail}</p></body>`;

    if (error !== null || code === null) {
      res
        .writeHead(400, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        })
        .end(page('Sign-in did not complete.', 'Return to NorthKeep and try again.'));
      close();
      fail?.(new Error(error !== null ? `The provider refused the sign-in (${sanitizeServerText(error, 120)}).` : 'The provider returned no authorization code.'));
      return;
    }
    if (expectedState !== null && state !== expectedState) {
      res
        .writeHead(400, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        })
        .end(page('That sign-in did not match.', 'Return to NorthKeep and start again.'));
      close();
      fail?.(new Error('The sign-in response did not match the request NorthKeep started. Nothing was stored.'));
      return;
    }
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      .end(page('Signed in.', 'You can close this tab and return to NorthKeep.'));
    close();
    settle?.({ code, state });
  });

  const timer = setTimeout(() => {
    close();
    fail?.(new Error('Timed out waiting for the sign-in to finish.'));
  }, timeoutMs);
  timer.unref?.();

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    close();
    fail?.(
      err.code === 'EADDRINUSE'
        ? new Error(
            `Port ${OAUTH_CALLBACK_PORT} is already in use, so NorthKeep cannot receive the sign-in. Close whatever is using it and try again.`,
          )
        : err,
    );
  });
  server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1');

  return { result, cancel: close };
}

/** Open a URL in the user's default browser. Only ever called after the caller confirms the origin. */
export function openInBrowser(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new Error('NorthKeep will only open an https sign-in page.');
  }
  // execFile, not a shell: the URL is a value, never a command fragment.
  execFile('open', [url.toString()], () => undefined);
}

export function requireTokenStore(): void {
  if (!tokenStoreAvailable()) {
    throw new OAuthNotAvailableError(
      'Remote MCP servers need the macOS Keychain to hold their sign-in, and none is available here. NorthKeep will not write OAuth tokens to a file.',
    );
  }
}

