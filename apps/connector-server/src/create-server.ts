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
 *   (C4) CORS is added for the browser-side ChatGPT connect flow: the /.well-known
 *   discovery docs are readable by any origin; DCR/token/revoke are reflected only
 *   for the ChatGPT web origins. No credentials mode; bearer routes are excluded.
 *   Ours:
 *     POST   /pair/start         (Bearer connector_token -> single-use pairing code)
 *     POST   /consent            (pairing code -> account binding -> auth code)
 *     POST   /mcp                (bearer-protected, stateless MCP; account-scoped tools:
 *                                 memory_retrieve/list/remember/forget + search/fetch)
 *     GET    /mcp                (405 — stateless, no server-initiated stream)
 *     GET    /client/manifest    (Bearer connector_token -> [{entry_id,entry_hash,scope}])
 *     PUT    /client/entries     (Bearer; "make these scopes match" batch push)
 *     DELETE /client/scope/:scope (Bearer; unshare -> delete rows + tombstone)
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
import { connectorGateFromEnv, verifyEntitlement, ENTITLEMENT_GRACE_MS } from './entitlement.js';

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_DEFAULT = 120;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const IP_LIMIT_MULTIPLIER = 4;
/** Paths that must be throttled (before body read / storage / Stripe). */
const THROTTLED_PREFIXES = ['/mcp', '/pair', '/consent', '/client', '/debug'];

// ---- CORS for ChatGPT's browser-side connect flow (C4) -------------------
// When a user adds this connector inside ChatGPT (web), the chatgpt.com page
// fetch()es our OAuth discovery + DCR from the browser, so those cross-origin
// responses need CORS headers or the browser drops them. We do NOT use cookies
// or `Access-Control-Allow-Credentials`, so this is not a CSRF/credential
// surface. Origins: chatgpt.com is the current ChatGPT web origin; chat.openai.com
// is its legacy origin (still in redirects). Nothing else is allowed.
const CHATGPT_WEB_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
// OAuth endpoints a browser MIGHT call with fetch() during connect: DCR + the
// token/revoke exchanges. ChatGPT may do these server-side instead (no CORS
// needed then) — allowlisting is harmless either way and covers both. The
// /.well-known/* discovery docs are handled separately (public, any origin).
const OAUTH_BROWSER_PREFIXES = ['/register', '/token', '/revoke'];

// Per-account sharing caps (ADR 0019). Enforced on the push payload; a precise
// per-account TOTAL across not-pushed scopes would need an extra read (noted).
const MAX_SHARED_ENTRIES = 5000;
const MAX_CONTENT_BYTES = 8 * 1024; // 8 KB per entry
const MAX_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024; // ~4 MB of content per push
// Body parser ceiling for the push: above the 4 MB content cap so a legitimate
// max payload (JSON key/id/hash overhead per row) is measured by the real cap
// in-handler, not silently 413'd by the parser.
const CLIENT_BODY_LIMIT = '8mb';

export function createConnectorServer(storage: ConnectorStorage): express.Express {
  const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const issuerUrl = new URL(publicUrl);
  const mcpResourceUrl = `${publicUrl}/mcp`;
  const resourceServerUrl = new URL(mcpResourceUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const provider = new ConnectorOAuthProvider(storage, mcpResourceUrl);

  // ---- billing gate (C3) -------------------------------------------------
  // Gate OFF (both envs unset) ⇒ every account is allowed (self-host / the
  // C1/C2 tests). Gate ON ⇒ allow an allowlisted account free, or one carrying a
  // live entitlement grace window; otherwise 402 on the gated routes.
  const gate = connectorGateFromEnv(process.env);

  /** Stamp a grace window when the desktop forwards a valid X-NB-Entitlement. */
  async function stampEntitlement(req: Request, accountHash: string): Promise<void> {
    if (!gate.entitlementSecret) return;
    const raw = req.headers['x-nb-entitlement'];
    const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : null;
    if (!token) return;
    const claims = verifyEntitlement(gate.entitlementSecret, token);
    if (claims) await storage.setEntitledUntil(accountHash, Date.now() + ENTITLEMENT_GRACE_MS);
  }

  /** True if the account may use the gated routes. */
  async function isEntitled(accountHash: string): Promise<boolean> {
    if (!gate.on) return true;
    if (gate.allowlist?.has(accountHash)) return true;
    if (gate.entitlementSecret) {
      const until = await storage.getEntitledUntil(accountHash);
      if (until !== null && until > Date.now()) return true;
    }
    return false;
  }

  function deny402(res: Response): void {
    res.status(402).json({
      error: 'An active NorthKeep subscription is required to use the connector.',
      subscribe: true,
    });
  }

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

  // ---- CORS for the ChatGPT connect flow (C4) ---------------------------
  // Runs before the SDK router so a preflight to /register|/token|/revoke and a
  // browser GET of the discovery docs get the right headers (and OPTIONS is
  // answered here, not 404'd by a route that only handles GET/POST).
  //  - /.well-known/* : public, unauthenticated RFC 8414/9728 discovery docs.
  //    They carry no secrets and are meant to be world-readable, so any origin
  //    may read them (Access-Control-Allow-Origin: *).
  //  - /register,/token,/revoke : reflected ONLY for the known ChatGPT web
  //    origins; unknown origins get no ACAO and the browser blocks the response.
  // No Allow-Credentials anywhere. Bearer routes (/mcp, /client/*) are NOT here:
  // /mcp keeps its own permissive reflect (below) because CORS never guards a
  // bearer endpoint — whoever holds the token already wins — and /client/* is a
  // desktop-to-server call with no browser origin to satisfy.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const path = req.path;
    const isMetadata = path.startsWith('/.well-known/');
    const isOAuthBrowser = OAUTH_BROWSER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
    if (!isMetadata && !isOAuthBrowser) return next();

    if (origin && CHATGPT_WEB_ORIGINS.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    } else if (isMetadata) {
      res.set('Access-Control-Allow-Origin', '*');
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version');
    res.set('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
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
    await stampEntitlement(req, accountHash);
    if (!(await isEntitled(accountHash))) {
      deny402(res);
      return;
    }
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
    if (!(await isEntitled(accountHash))) {
      res.status(402).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: 'An active NorthKeep subscription is required to use the connector.' },
        id: null,
      });
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
      // Log only the message, never the raw error object: this is the one hot
      // path that touches memory content, and content-free logs are a hard
      // guarantee (invariant #5 / ADR 0019).
      // eslint-disable-next-line no-console
      console.error('POST /mcp error:', err instanceof Error ? err.message : 'mcp error');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', bearer, (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST for stateless MCP.' }, id: null });
  });

  // ---- client push endpoints (C2) ---------------------------------------
  // Bearer connector_token -> sha256 -> account_hash (upsert), exactly like
  // /pair/start. The desktop pushes ONLY the scopes the user marked Shared.

  // GET /client/manifest -> [{ entry_id, entry_hash, scope }] so the client can
  // diff. Content-free (no `content`, no `type`), still account-scoped.
  app.get('/client/manifest', async (req: Request, res: Response) => {
    const accountHash = bearerAccount(req);
    if (!accountHash) {
      res.status(401).json({ error: 'Missing or malformed bearer connector token.' });
      return;
    }
    await storage.upsertAccount(accountHash);
    await stampEntitlement(req, accountHash);
    if (!(await isEntitled(accountHash))) {
      deny402(res);
      return;
    }
    const entries = await storage.listEntries(accountHash);
    res.status(200).json({
      entries: entries.map((e) => ({ entry_id: e.entryId, entry_hash: e.entryHash ?? '', scope: e.scope })),
    });
  });

  // PUT /client/entries -> "make these scopes match". Body:
  //   { scopes: string[], entries: [{ entry_id, entry_hash, scope, type, content }] }
  // Upserts the provided rows and deletes any server row in `scopes` not present,
  // so a forgotten/removed vault entry disappears server-side.
  app.put('/client/entries', express.json({ limit: CLIENT_BODY_LIMIT }), async (req: Request, res: Response) => {
    const accountHash = bearerAccount(req);
    if (!accountHash) {
      res.status(401).json({ error: 'Missing or malformed bearer connector token.' });
      return;
    }
    await storage.upsertAccount(accountHash);
    await stampEntitlement(req, accountHash);
    if (!(await isEntitled(accountHash))) {
      deny402(res);
      return;
    }
    const body = req.body as { scopes?: unknown; entries?: unknown };
    if (!Array.isArray(body.scopes) || !Array.isArray(body.entries)) {
      res.status(400).json({ error: 'Provide a scopes[] array and an entries[] array.' });
      return;
    }
    const scopes = body.scopes.filter((s): s is string => typeof s === 'string');
    if (body.entries.length > MAX_SHARED_ENTRIES) {
      res.status(413).json({ error: `Too many shared memories (${body.entries.length}). The cap is ${MAX_SHARED_ENTRIES} per account.` });
      return;
    }
    const entries: SharedEntry[] = [];
    let totalBytes = 0;
    const now = new Date().toISOString();
    for (const raw of body.entries) {
      const e = raw as Record<string, unknown>;
      if (
        typeof e.entry_id !== 'string' ||
        typeof e.scope !== 'string' ||
        typeof e.type !== 'string' ||
        typeof e.content !== 'string'
      ) {
        res.status(400).json({ error: 'Each entry needs string entry_id, scope, type, and content.' });
        return;
      }
      if (!scopes.includes(e.scope)) {
        res.status(400).json({ error: `Entry scope "${e.scope}" is not in the pushed scopes list.` });
        return;
      }
      const bytes = Buffer.byteLength(e.content, 'utf8');
      if (bytes > MAX_CONTENT_BYTES) {
        res.status(413).json({ error: `A memory exceeds the ${MAX_CONTENT_BYTES}-byte per-entry content cap.` });
        return;
      }
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_CONTENT_BYTES) {
        res.status(413).json({ error: `The push exceeds the ${MAX_TOTAL_CONTENT_BYTES / 1024 / 1024} MB total content cap.` });
        return;
      }
      entries.push({
        entryId: e.entry_id,
        scope: e.scope,
        type: e.type,
        content: e.content,
        entryHash: typeof e.entry_hash === 'string' ? e.entry_hash : '',
        createdAt: now,
      });
    }
    await storage.replaceScopes(accountHash, scopes, entries);
    await storage.appendAudit({
      ts: now,
      accountHash,
      tool: 'client_push',
      params: { limit: scopes.length },
      ok: true,
      resultCount: entries.length,
      resultIds: [],
    });
    res.status(200).json({ ok: true, scopes, upserted: entries.length });
  });

  // DELETE /client/scope/:scope -> unshare: delete every row in the scope and
  // write a content-free tombstone.
  app.delete('/client/scope/:scope', async (req: Request, res: Response) => {
    const accountHash = bearerAccount(req);
    if (!accountHash) {
      res.status(401).json({ error: 'Missing or malformed bearer connector token.' });
      return;
    }
    const scope = req.params.scope ?? '';
    if (!scope) {
      res.status(400).json({ error: 'Provide a scope to unshare.' });
      return;
    }
    await storage.upsertAccount(accountHash);
    await stampEntitlement(req, accountHash);
    if (!(await isEntitled(accountHash))) {
      deny402(res);
      return;
    }
    const deleted = await storage.deleteScope(accountHash, scope);
    await storage.appendAudit({
      ts: new Date().toISOString(),
      accountHash,
      tool: 'client_unshare',
      params: { limit: 1 },
      ok: true,
      resultCount: deleted,
      resultIds: [],
    });
    res.status(200).json({ ok: true, scope, deleted });
  });

  // ---- write-back down-sync (C3) ----------------------------------------
  // GET /client/pending -> the connector-born memories not yet pulled into the
  // vault, plus the queued forgets. Content-bearing but account-scoped; the
  // desktop applies these to the OPEN vault then acks.
  app.get('/client/pending', async (req: Request, res: Response) => {
    const accountHash = bearerAccount(req);
    if (!accountHash) {
      res.status(401).json({ error: 'Missing or malformed bearer connector token.' });
      return;
    }
    await storage.upsertAccount(accountHash);
    await stampEntitlement(req, accountHash);
    if (!(await isEntitled(accountHash))) {
      deny402(res);
      return;
    }
    const [pending, forgets] = await Promise.all([
      storage.listPendingEntries(accountHash),
      storage.listPendingForgets(accountHash),
    ]);
    // A pending row that already has a queued forget must NEVER be delivered as a
    // fresh entry — otherwise a forgotten-before-delivery memory would land in the
    // vault. It still rides in `forgets` so the server row is drained.
    const forgottenSet = new Set(forgets);
    res.status(200).json({
      entries: pending
        .filter((e) => !forgottenSet.has(e.entryId))
        .map((e) => ({ server_id: e.entryId, scope: e.scope, type: e.type, content: e.content })),
      forgets: forgets.map((entry_id) => ({ entry_id })),
    });
  });

  // POST /client/ack -> the desktop reports what it applied. Body:
  //   { acked: [{ server_id, local_entry_id }], forgets: [entry_id] }
  // Per acked: remap the connector row's id -> the vault-local id and clear
  // pending (so the next push rehashes it as a normal row). Per forget: delete
  // the queue row AND the shared_entries row.
  app.post('/client/ack', express.json({ limit: CLIENT_BODY_LIMIT }), async (req: Request, res: Response) => {
    const accountHash = bearerAccount(req);
    if (!accountHash) {
      res.status(401).json({ error: 'Missing or malformed bearer connector token.' });
      return;
    }
    await storage.upsertAccount(accountHash);
    await stampEntitlement(req, accountHash);
    if (!(await isEntitled(accountHash))) {
      deny402(res);
      return;
    }
    const body = req.body as { acked?: unknown; forgets?: unknown };
    const acked = Array.isArray(body.acked) ? body.acked : [];
    const forgets = Array.isArray(body.forgets) ? body.forgets : [];
    // Cap the batch: each item is a multi-statement Neon transaction run in a
    // sequential loop, so an unbounded array would amplify one authed request
    // into tens of thousands of serial round-trips (pool exhaustion / timeout).
    if (acked.length + forgets.length > MAX_SHARED_ENTRIES) {
      res.status(413).json({
        error: `Too many items in one ack (${acked.length + forgets.length}). The cap is ${MAX_SHARED_ENTRIES}.`,
      });
      return;
    }
    let ackedCount = 0;
    for (const raw of acked) {
      const a = raw as Record<string, unknown>;
      if (typeof a.server_id !== 'string' || typeof a.local_entry_id !== 'string') continue;
      await storage.ackEntry(accountHash, a.server_id, a.local_entry_id);
      ackedCount++;
    }
    let forgottenCount = 0;
    for (const raw of forgets) {
      if (typeof raw !== 'string') continue;
      await storage.applyForget(accountHash, raw);
      forgottenCount++;
    }
    await storage.appendAudit({
      ts: new Date().toISOString(),
      accountHash,
      tool: 'client_ack',
      params: { limit: ackedCount + forgottenCount },
      ok: true,
      resultCount: ackedCount + forgottenCount,
      resultIds: [],
    });
    res.status(200).json({ ok: true, acked: ackedCount, forgotten: forgottenCount });
  });

  // (Removed: the env-gated POST /debug/seed test helper. It trusted a
  // caller-supplied account_hash from the body with no OAuth or entitlement
  // check — a latent cross-account memory-poisoning write if the env flag were
  // ever set in production. Real seeding goes through the authenticated C2 push
  // (PUT /client/entries); the e2e seeds via the storage method directly.)

  // ---- health page ------------------------------------------------------
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>NorthKeep Connector</title>
<h1>NorthKeep hosted shareable-scope connector</h1>
<p>Public origin: <code>${publicUrl}</code></p>
<p>OAuth 2.1 authorization server + MCP resource server. Serves ONLY scopes the user marked Shared.</p>
<ul>
  <li><code>POST /mcp</code> — MCP streamable HTTP (bearer-protected, stateless). Tools: <code>memory_retrieve</code>, <code>memory_list</code>, <code>memory_remember</code>, <code>memory_forget</code>, and ChatGPT's <code>search</code> + <code>fetch</code></li>
  <li><code>POST /pair/start</code> — pairing code from a connector token</li>
  <li><code>GET /client/manifest</code>, <code>PUT /client/entries</code>, <code>DELETE /client/scope/:scope</code> — desktop push of shared scopes</li>
  <li><code>GET /.well-known/oauth-authorization-server</code> — RFC 8414 AS metadata</li>
  <li><code>GET /.well-known/oauth-protected-resource/mcp</code> — RFC 9728 PRM</li>
</ul>`);
  });

  return app;
}

/**
 * The account hash for a /client/* request: sha256 of the Bearer connector
 * token, mirroring /pair/start. Returns null for a missing/too-short token.
 */
function bearerAccount(req: Request): string | null {
  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token.length < 16) return null;
  return sha256hex(token);
}

/** Client IP: first hop of x-forwarded-for (set by Vercel), else the socket. */
function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}
