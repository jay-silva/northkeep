/**
 * createConnectorServer(storage) -> an Express app (call `.listen(PORT)`).
 *
 * Everything the OAuth authorization server issues is persisted through
 * `storage`, so the app is stateless across instances: this same factory built
 * a second time over the SAME storage serves tokens minted by the first (the
 * C0 → C1 fix). No side effects here; index.ts wires storage + listens.
 *
 * Route surface (ADR 0016 enumerates this):
 *   SDK mcpAuthRouter (mounted at root):
 *     GET/POST /authorize        (PKCE S256; our provider RENDERS the consent page)
 *     POST     /token            (auth-code + refresh grants, PKCE-verified)
 *     POST     /register         (RFC 7591 DCR)
 *     POST     /revoke
 *     GET /.well-known/oauth-authorization-server        (RFC 8414 AS metadata)
 *     GET /.well-known/oauth-protected-resource/mcp      (RFC 9728 PRM)
 *   Ours:
 *     POST /pair/start           (Bearer connector_token -> single-use pairing code)
 *     POST /consent              (pairing code -> account binding -> auth code)
 *     POST /mcp                  (bearer-protected, stateless MCP; account-scoped tools)
 *     GET  /mcp                  (405 — stateless, no server-initiated stream)
 *     POST /debug/seed           (test-only, env-gated; seed shared rows)
 *     GET  /.well-known/oauth-protected-resource   (PRM root, compat)
 *     GET  /                     (health page)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ConnectorStorage, SharedEntry } from './storage.js';
import { ConnectorOAuthProvider } from './provider.js';
import { createMcpServer } from './mcp.js';
import { renderConsentPage } from './consent.js';
import { createRateLimiter, rateLimitFromEnv, type RateLimiter } from './rate-limit.js';
import { sha256hex, generatePairingCode } from './hash.js';

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_DEFAULT = 120;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const IP_LIMIT_MULTIPLIER = 4;
/** Paths that must be throttled (before body read / storage / Stripe). */
const THROTTLED_PREFIXES = ['/mcp', '/pair', '/consent', '/debug'];

export function createConnectorServer(storage: ConnectorStorage): express.Express {
  const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const issuerUrl = new URL(publicUrl);
  const mcpResourceUrl = `${publicUrl}/mcp`;
  const resourceServerUrl = new URL(mcpResourceUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const provider = new ConnectorOAuthProvider(storage, mcpResourceUrl);

  const app = express();
  app.disable('x-powered-by');
  // Vercel is a single proxy hop in front of the function. Trust exactly one hop
  // so express (and the SDK's internal express-rate-limit) reads the real client
  // IP from x-forwarded-for without the "trust all → trivially bypassable"
  // posture that `true` warns about.
  app.set('trust proxy', 1);

  // ---- rate limiting (headers/IP only; NEVER reads the body) -------------
  const rateLimit = rateLimitFromEnv(process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT, RATE_LIMIT_DEFAULT);
  const limiter: RateLimiter | null =
    rateLimit === null ? null : createRateLimiter({ limit: rateLimit, windowMs: RATE_LIMIT_WINDOW_MS });
  const ipLimiter: RateLimiter | null =
    rateLimit === null
      ? null
      : createRateLimiter({ limit: rateLimit * IP_LIMIT_MULTIPLIER, windowMs: RATE_LIMIT_WINDOW_MS });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!limiter || !ipLimiter) return next();
    if (!THROTTLED_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    let retryAfter = ipLimiter.check(`ip:${clientIp(req)}`);
    if (retryAfter === null && token) retryAfter = limiter.check(`tok:${sha256hex(token)}`);
    if (retryAfter !== null) {
      res.set('retry-after', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Slow down and retry.' });
      return;
    }
    next();
  });

  // ---- SDK OAuth authorization server (mounted at root) ------------------
  // No global body parser before this — each SDK sub-route parses its own body.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      resourceName: 'NorthKeep Connector',
      scopesSupported: ['mcp'],
    }),
  );

  // Compat: some clients probe the ROOT protected-resource path; the SDK only
  // serves the /mcp-suffixed one. Advertise both so discovery can't miss.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: mcpResourceUrl,
      authorization_servers: [issuerUrl.href],
      scopes_supported: ['mcp'],
      resource_name: 'NorthKeep Connector',
    });
  });

  // ---- pairing bridge: POST /pair/start ---------------------------------
  // Bearer connector_token -> account -> single-use pairing code (10-min TTL,
  // stored hashed). The desktop calls this; the code is shown to the user.
  app.post('/pair/start', express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || token.length < 16) {
      res.status(401).json({ error: 'Missing or malformed bearer connector token.' });
      return;
    }
    const accountHash = sha256hex(token);
    await storage.upsertAccount(accountHash);
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    await storage.putPairingCode(sha256hex(code), accountHash, expiresAt);
    res.status(200).json({
      pairing_code: code,
      expires_in: Math.floor(PAIRING_TTL_MS / 1000),
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  // ---- consent submission: POST /consent --------------------------------
  // Re-validate the client + redirect_uri (an unregistered redirect_uri here
  // would be an open redirect), verify the pairing code (single-use, unexpired),
  // then mint the account-bound authorization code and redirect to the client.
  app.post('/consent', express.urlencoded({ extended: false, limit: '8kb' }), async (req: Request, res: Response) => {
    const body = req.body as Record<string, string | undefined>;
    const clientId = body.client_id ?? '';
    const redirectUri = body.redirect_uri ?? '';
    const codeChallenge = body.code_challenge ?? '';
    const state = body.state;
    const scope = body.scope ?? 'mcp';
    const resource = body.resource ?? mcpResourceUrl;
    const pairingCode = (body.pairing_code ?? '').trim().toUpperCase();

    const client = await provider.clientsStore.getClient(clientId);
    if (!client || !codeChallenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Unknown client or missing PKCE challenge.' });
      return;
    }
    if (!client.redirect_uris.some((r) => redirectUriMatches(redirectUri, r))) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Unregistered redirect_uri.' });
      return;
    }

    const rerenderError = (msg: string): void => {
      res.status(200).type('html').send(
        renderConsentPage(
          { clientId, clientName: client.client_name, redirectUri, codeChallenge, state, scope, resource },
          { error: msg },
        ),
      );
    };

    if (!/^[A-Z2-9]{8}$/.test(pairingCode)) {
      rerenderError('That does not look like a valid pairing code. Enter the 8-character code from NorthKeep.');
      return;
    }
    const accountHash = await storage.consumePairingCode(sha256hex(pairingCode));
    if (!accountHash) {
      rerenderError('That pairing code is wrong, already used, or expired. Generate a fresh one in NorthKeep.');
      return;
    }

    let code: string;
    try {
      code = await provider.mintAuthorizationCode({ clientId, accountHash, codeChallenge, redirectUri, resource });
    } catch (err) {
      if (err instanceof OAuthError) {
        rerenderError('This app requested an unexpected resource and was refused.');
        return;
      }
      throw err;
    }

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state !== undefined) redirect.searchParams.set('state', state);
    res.redirect(302, redirect.href);
  });

  // ---- MCP endpoint: bearer-protected, stateless streamable HTTP ---------
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: ['mcp'], resourceMetadataUrl });

  // Minimal CORS so browser-based clients (ChatGPT web, C4) can read the 401
  // challenge and call /mcp. No dependency — set the headers directly.
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    res.set('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const accountHash = (req.auth?.extra as { accountHash?: string } | undefined)?.accountHash;
    if (!accountHash) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Token not bound to an account' }, id: null });
      return;
    }
    const server = createMcpServer(storage, accountHash);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('POST /mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', bearer, (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST for stateless MCP.' }, id: null });
  });

  // ---- test-only seed: POST /debug/seed (env-gated) ---------------------
  // Lets the lead seed shared rows against real Neon. The e2e seeds via the
  // storage method directly; this is the deploy-time equivalent. Disabled unless
  // NORTHKEEP_CONNECTOR_ENABLE_DEBUG_SEED=1.
  app.post('/debug/seed', express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    if (process.env.NORTHKEEP_CONNECTOR_ENABLE_DEBUG_SEED !== '1') {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    const body = req.body as { connector_token?: string; account_hash?: string; entries?: Array<Partial<SharedEntry>> };
    const accountHash = body.connector_token ? sha256hex(body.connector_token) : body.account_hash;
    if (!accountHash || !Array.isArray(body.entries)) {
      res.status(400).json({ error: 'Provide connector_token or account_hash, and an entries array.' });
      return;
    }
    await storage.upsertAccount(accountHash);
    let n = 0;
    for (const e of body.entries) {
      if (!e.entryId || !e.scope || !e.type || typeof e.content !== 'string') continue;
      await storage.putEntry(accountHash, {
        entryId: e.entryId,
        scope: e.scope,
        type: e.type,
        content: e.content,
        createdAt: e.createdAt ?? new Date().toISOString(),
      });
      n++;
    }
    res.status(200).json({ seeded: n, account_hash: accountHash });
  });

  // ---- health page ------------------------------------------------------
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>NorthKeep Connector</title>
<h1>NorthKeep hosted shareable-scope connector</h1>
<p>Public origin: <code>${publicUrl}</code></p>
<p>OAuth 2.1 authorization server + MCP resource server. Serves ONLY scopes the user marked Shared.</p>
<ul>
  <li><code>POST /mcp</code> — MCP streamable HTTP (bearer-protected, stateless). Tools: <code>memory_retrieve</code>, <code>memory_list</code></li>
  <li><code>POST /pair/start</code> — pairing code from a connector token</li>
  <li><code>GET /.well-known/oauth-authorization-server</code> — RFC 8414 AS metadata</li>
  <li><code>GET /.well-known/oauth-protected-resource/mcp</code> — RFC 9728 PRM</li>
</ul>`);
  });

  return app;
}

/** Client IP: first hop of x-forwarded-for (set by Vercel), else the socket. */
function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}
