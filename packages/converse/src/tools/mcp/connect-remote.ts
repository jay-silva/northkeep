import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { endpointOrigin, remoteUrlRefusal, type McpHttpServer } from './config.js';
import { guardedFetch } from '../net.js';
import {
  awaitOAuthCallback,
  KeychainOAuthProvider,
  openInBrowser,
  requireTokenStore,
  OAUTH_REDIRECT_URI,
} from './oauth.js';
import { deleteCredentials } from './tokens.js';

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
  probeRequiresAuth?: (server: McpHttpServer) => Promise<boolean>;
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

  // A previous half-finished attempt leaves a PKCE verifier and possibly a
  // stale client registration. Start clean, so a failure never leaves state
  // that makes the NEXT attempt behave in a way nobody can explain.
  deleteCredentials(server.id);

  const probe = options.probeRequiresAuth ?? probeRequiresAuth;
  if (!(await probe(server))) throw new McpServerNotAuthenticatedError(server.id);

  const provider = new KeychainOAuthProvider({
    serverId: server.id,
    origin,
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
    fetchFn: guardedFetch as unknown as typeof fetch,
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
  const state = authorizationUrl.searchParams.get('state');

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
        (options.openBrowser ?? openInBrowser)(authorizationUrl);
        const { code } = await started.result;
        const finished = await auth(provider, {
          serverUrl: server.url,
          authorizationCode: code,
          fetchFn: guardedFetch as unknown as typeof fetch,
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
        });
        if (finished !== 'AUTHORIZED') {
          throw new Error('The sign-in finished but no token was issued. Nothing was stored.');
        }
      } catch (err) {
        // Never leave a usable-looking half-state behind.
        deleteCredentials(server.id);
        throw err;
      } finally {
        started?.cancel();
      }
    },
    cancel: () => {
      started?.cancel();
      deleteCredentials(server.id);
    },
  };
}

/**
 * Does this server actually demand authentication?
 *
 * ADR 0035 Decision 7, hole 2: nothing in the protocol requires a server to ask
 * for credentials, and a server that serves `tools/list` to anyone has put its
 * descriptions in front of the model with no gate at all. So probe ANONYMOUSLY
 * — no auth provider, no stored token — and refuse the server if that works.
 *
 * The probe connects and immediately closes. It never lists tools, so even a
 * server that answers is never given the chance to have its descriptions read.
 */
async function probeRequiresAuth(server: McpHttpServer): Promise<boolean> {
  const client = new Client({ name: 'northkeep', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: guardedFetch as unknown as typeof fetch,
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
