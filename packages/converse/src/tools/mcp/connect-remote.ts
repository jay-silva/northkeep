import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import { endpointOrigin, remoteUrlRefusal, type McpHttpServer } from './config.js';
import { guardedFetch } from '../net.js';
import {
  awaitOAuthCallback,
  KeychainOAuthProvider,
  openInBrowser,
  requireTokenStore,
  OAUTH_REDIRECT_URI,
} from './oauth.js';
import { loadCredentials, saveCredentials } from './tokens.js';

/** Drop this attempt's PKCE verifier, leaving any existing grant untouched. */
function clearVerifier(serverId: string): void {
  const cur = loadCredentials(serverId);
  if (cur === null || cur.codeVerifier === undefined) return;
  const { codeVerifier: _dropped, ...rest } = cur;
  saveCredentials(serverId, rest);
}

/**
 * The remote sign-in flow (ADR 0035 Decision 7).
 *
 * Deliberately TWO-PHASE, and the split is the security property, not an API
 * convenience. Phase one discovers where the provider wants to send the user
 * and hands that origin back to the caller. Phase two — the part that opens a
 * browser — happens only after the caller says yes.
 *
 * The reason is Decision 7's third hole: an MCP server names its own
 * authorization server, and the SDK does not constrain
 * `authorization_servers[0]` to the MCP server's own origin. A single-phase
 * connect would therefore be a primitive that makes a trusted local app open
 * the user's browser at a URL the server chose, under the banner "NorthKeep is
 * connecting your account". Splitting it means a human sees the destination
 * first, and `sameOrigin` tells the surface whether to make that quiet or loud.
 */

export class McpServerNotAuthenticatedError extends Error {
  constructor(readonly serverId: string) {
    super(
      `The server at this address asks for no credentials, so NorthKeep will not use it. ` +
        'A server that hands out its tool list to anyone is putting instructions in front of ' +
        'the model with nothing standing between them and you.',
    );
    this.name = 'McpServerNotAuthenticatedError';
  }
}

export interface PendingConnect {
  serverId: string;
  /** Where the provider wants to send the user. */
  authorizationUrl: URL;
  /** Just the origin, for display. */
  authOrigin: string;
  /** False when the authorization server is a DIFFERENT origin from the MCP server. */
  sameOrigin: boolean;
  /** The exact redirect URI the user must have registered with the provider. */
  redirectUri: string;
  /** Opens the browser and waits for the callback. Only call after a human says yes. */
  proceed: () => Promise<void>;
  /** Abandons the attempt and tears down the listener. */
  cancel: () => void;
}

export interface RemoteConnectOptions {
  /** Client secret the user pasted. Never stored in mcp.json; goes to the Keychain. */
  clientSecret?: string;
  scope?: string;
  /** Injected by tests. Production opens the user's default browser. */
  openBrowser?: (url: URL) => void;
  /** Injected by tests, so no listener is bound and no browser opens. */
  awaitCallback?: typeof awaitOAuthCallback;
  /** Injected by tests in place of a real anonymous probe. */
  probeRequiresAuth?: (server: McpHttpServer, fetchFn?: typeof fetch) => Promise<boolean>;
  /**
   * Injected by TESTS ONLY, in place of `guardedFetch`.
   *
   * Every production caller leaves this undefined, and the default is the
   * guard. It exists because the alternative — letting the OAuth tests reach
   * the real network — is worse, and because `connectServer` already takes a
   * `clientFactory` on the same reasoning. Note what it does NOT do: it is not
   * reachable from any surface, any config file, or any model turn, so there is
   * no path by which a caller can substitute a fetch that skips the guard.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Phase one: check the server demands authentication, discover the
 * authorization server, and stop.
 */
export async function startRemoteConnect(
  server: McpHttpServer,
  options: RemoteConnectOptions = {},
): Promise<PendingConnect> {
  requireTokenStore();

  // Re-check the URL here as well as at add time. The config is a file the user
  // can edit, and this is the last point before anything is contacted.
  const checked = remoteUrlRefusal(server.url);
  if (!checked.ok) throw new Error(checked.reason);
  const origin = endpointOrigin(server.url);

  // Deliberately NOT deleteCredentials() here. An earlier version wiped the
  // record before probing, which meant an abandoned sign-in — the user reads
  // the destination, does not recognize it, clicks Cancel — destroyed a working
  // grant AND the client secret behind it. The flow hides the existing tokens
  // instead (`ignoreStoredTokens`), so a fresh authorization is forced and
  // nothing is lost unless a new token actually replaces the old one.

  const fetchFn = options.fetchImpl ?? (guardedFetch as unknown as typeof fetch);
  const probe = options.probeRequiresAuth ?? probeRequiresAuth;
  if (!(await probe(server, fetchFn))) throw new McpServerNotAuthenticatedError(server.id);

  const provider = new KeychainOAuthProvider({
    serverId: server.id,
    origin,
    ignoreStoredTokens: true,
    ...(server.clientId !== undefined ? { clientId: server.clientId } : {}),
    ...(options.clientSecret !== undefined ? { clientSecret: options.clientSecret } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
  });

  // This performs discovery and, if the provider supports it, dynamic client
  // registration — all through our own guarded fetch, per Decision 5, because
  // the SDK's discovery calls would otherwise use bare `fetch` and bypass the
  // egress wall entirely.
  const result = await auth(provider, {
    serverUrl: server.url,
    fetchFn,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
  });

  if (result === 'AUTHORIZED') {
    // Already holds a usable token (a client-credentials-style provider). No
    // browser step is needed, and none should be invented.
    return {
      serverId: server.id,
      authorizationUrl: new URL(origin),
      authOrigin: origin,
      sameOrigin: true,
      redirectUri: OAUTH_REDIRECT_URI,
      proceed: async () => undefined,
      cancel: () => undefined,
    };
  }

  const authorizationUrl = provider.authorizationUrl;
  if (authorizationUrl === null) {
    throw new Error('The provider did not supply a sign-in address, so there is nothing to open.');
  }
  const authOrigin = authorizationUrl.origin;

  const listener = options.awaitCallback ?? awaitOAuthCallback;
  // The expected state comes from the PROVIDER that issued it, not from
  // re-parsing the URL: one source of truth for the value the callback must
  // echo. A redirect flow without an issued state has nothing to verify the
  // callback against, so it is refused rather than waited on.
  const state = provider.issuedState;
  if (state === null) {
    throw new Error(
      'No state value was issued for this sign-in, so its callback could not be verified. Start the sign-in again.',
    );
  }

  let started: ReturnType<typeof awaitOAuthCallback> | null = null;
  return {
    serverId: server.id,
    authorizationUrl,
    authOrigin,
    sameOrigin: authOrigin === origin,
    redirectUri: OAUTH_REDIRECT_URI,
    proceed: async () => {
      // The listener starts BEFORE the browser opens, so a fast provider
      // cannot redirect back to a port nothing is listening on.
      started = listener(state);
      try {
        // The bind must be CONFIRMED, not merely started, before any browser
        // opens: if the fixed port is already owned by another process, the
        // user would otherwise complete a real sign-in whose code is delivered
        // to whatever owns it. Port-in-use fails here, browser unopened.
        await started.ready;
        (options.openBrowser ?? openInBrowser)(authorizationUrl);
        const { code } = await started.result;
        const finished = await auth(provider, {
          serverUrl: server.url,
          authorizationCode: code,
          fetchFn,
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
        });
        if (finished !== 'AUTHORIZED') {
          throw new Error('The sign-in finished but no token was issued. Nothing was stored.');
        }
      } catch (err) {
        // Clear only the PKCE verifier, which belongs to THIS attempt. A failed
        // sign-in must not take the previous working one with it.
        clearVerifier(server.id);
        throw err;
      } finally {
        started?.cancel();
      }
    },
    cancel: () => {
      started?.cancel();
      clearVerifier(server.id);
    },
  };
}

/**
 * Does this server actually demand authentication?
 *
 * ADR 0035 Decision 7, hole 2: nothing in the protocol requires a server to ask
 * for credentials, and NorthKeep refuses a server that is credential-less in
 * fact — "sign in" to such a server means nothing, and approved arguments
 * would flow to an endpoint that answers to anyone.
 *
 * "Demands authentication" has two honest shapes (acceptance finding
 * 2026-07-27): a server may refuse the anonymous handshake outright, OR it may
 * answer the handshake — even `tools/list` — anonymously while gating every
 * `tools/call` behind a token it declares via RFC 9728 protected-resource
 * metadata. Google's Gmail server is the second shape, and judging it by its
 * open front door refused the flagship provider. So: a published metadata
 * document naming an authorization server counts as demanding auth. A server
 * that neither publishes one nor refuses the anonymous handshake is refused.
 *
 * The probe never lists tools, so even a server that answers is never given
 * the chance to have its descriptions read.
 */
export async function probeRequiresAuth(
  server: McpHttpServer,
  fetchFn: typeof fetch = guardedFetch as unknown as typeof fetch,
): Promise<boolean> {
  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(server.url, undefined, fetchFn);
    if ((metadata.authorization_servers?.length ?? 0) > 0) return true;
  } catch {
    // No declaration published; the anonymous handshake below decides.
  }
  const client = new Client({ name: 'northkeep', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: fetchFn,
  });
  try {
    await client.connect(transport);
    await client.close().catch(() => undefined);
    return false; // it let us in with nothing
  } catch {
    // Any failure here — 401, 403, a refusal from our own egress guard, a
    // network error — means we did NOT get in anonymously. Treating an
    // ambiguous failure as "requires auth" is the fail-closed direction only
    // because the real sign-in immediately follows and will surface the actual
    // problem; nothing is trusted on the strength of this probe alone.
    await client.close().catch(() => undefined);
    return true;
  }
}
