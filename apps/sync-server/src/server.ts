#!/usr/bin/env node
import { createHash } from 'node:crypto';
import http from 'node:http';
import { handleSync, MAX_BLOB_BYTES, parseAllowlist, type SyncRequest } from './handler.js';
import { createRateLimiter, rateLimitFromEnv, type RateLimiter } from './rate-limit.js';
import {
  createCheckout,
  createPortal,
  handleWebhook,
  subscriptionActive,
  type BillingDeps,
} from './billing.js';
import type { Storage } from './storage.js';

/**
 * A plain node:http wrapper around the sync + billing handlers — used for
 * self-hosting, local dev, and the e2e harness (which injects InMemoryStorage
 * and a fake Stripe gateway). Production on Vercel uses the same code via the
 * listening entry in `index.ts`. No web framework (repo convention).
 *
 * `billing` is null when Stripe isn't configured (self-host / open); then the
 * billing routes are absent and only the allowlist gates.
 */

/** Per-key request cap per 5-minute window (per warm instance). */
const RATE_LIMIT_DEFAULT = 120;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export function createSyncServer(storage: Storage, billing: BillingDeps | null = null): http.Server {
  const allowedTokenHashes = parseAllowlist(process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES);
  const rateLimit = rateLimitFromEnv(process.env.NORTHKEEP_SYNC_RATE_LIMIT, RATE_LIMIT_DEFAULT);
  const limiter: RateLimiter | null =
    rateLimit === null ? null : createRateLimiter({ limit: rateLimit, windowMs: RATE_LIMIT_WINDOW_MS });
  return http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;

    // Throttle before reading the body or touching storage/Stripe. Keyed by
    // the account (token hash) when a token is presented, else the client IP,
    // which is what gates an unauthenticated webhook flood.
    if (limiter && url.pathname.startsWith('/api/')) {
      const key = token
        ? createHash('sha256').update(token, 'utf8').digest('hex')
        : `ip:${clientIp(req)}`;
      const retryAfter = limiter.check(key);
      if (retryAfter !== null) {
        // 'connection: close' makes Node drop the socket after the response
        // flushes, so a PUT body still streaming in is discarded, not read.
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(retryAfter),
          'cache-control': 'no-store',
          connection: 'close',
        });
        res.end(JSON.stringify({ error: 'Too many requests. Slow down and retry.' }));
        return;
      }
    }

    const body = method === 'PUT' || method === 'POST' ? await readBody(req) : null;

    // Static Checkout redirect pages (Stripe returns the browser here).
    if (method === 'GET' && (url.pathname === '/billing/success' || url.pathname === '/billing/cancel')) {
      const ok = url.pathname === '/billing/success';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        `<!doctype html><meta charset=utf-8><title>NorthKeep</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1.5rem;text-align:center;color:#24221c;background:#f6f4ef">` +
          `<h1 style="font-weight:600">${ok ? 'You’re subscribed.' : 'Checkout canceled.'}</h1>` +
          `<p style="color:#8a8477">${ok ? 'Your vault can now sync. Return to NorthKeep and push.' : 'No charge was made. You can subscribe anytime from the Sync tab.'}</p>` +
          `<p style="color:#8a8477">You can close this tab.</p></body>`,
      );
      return;
    }

    // Billing API (only when Stripe is configured).
    if (billing && url.pathname.startsWith('/api/') && isBillingRoute(method, url.pathname)) {
      await handleBillingRoute(req, res, method, url.pathname, token, body, storage, billing);
      return;
    }

    // Sync (blob) API — gated by allowlist OR subscription.
    const baseHeader = req.headers['x-base-version'];
    const baseVersion = typeof baseHeader === 'string' ? Number(baseHeader) : null;
    const request: SyncRequest = {
      method,
      path: url.pathname,
      token,
      baseVersion: baseVersion === null || Number.isNaN(baseVersion) ? null : baseVersion,
      body: method === 'PUT' ? body : null,
    };
    const result = await handleSync(request, storage, {
      allowedTokenHashes,
      subscriptionActive: billing ? (h) => subscriptionActive(h, storage) : undefined,
    });
    const isBuffer = result.body instanceof Buffer;
    res.writeHead(result.status, {
      'cache-control': 'no-store',
      ...(result.headers ?? {}),
      ...(!isBuffer && result.body !== undefined ? { 'content-type': 'application/json' } : {}),
    });
    if (isBuffer) res.end(result.body as Buffer);
    else if (result.body !== undefined) res.end(JSON.stringify(result.body));
    else res.end();
  }
}

function isBillingRoute(method: string, path: string): boolean {
  return (
    (method === 'POST' && (path === '/api/checkout' || path === '/api/webhook' || path === '/api/portal')) ||
    (method === 'GET' && path === '/api/subscription')
  );
}

async function handleBillingRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  path: string,
  token: string | null,
  body: Buffer | null,
  storage: Storage,
  billing: BillingDeps,
): Promise<void> {
  const sendJson = (status: number, obj: Record<string, unknown>): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  // Webhook is authenticated by Stripe's signature, not a bearer token.
  if (path === '/api/webhook') {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string' || !body) {
      sendJson(400, { error: 'Missing signature or body.' });
      return;
    }
    try {
      await handleWebhook(body, signature, billing.gateway, storage);
      sendJson(200, { received: true });
    } catch {
      // Bad signature or unparseable event — never echo internals.
      sendJson(400, { error: 'Invalid webhook signature.' });
    }
    return;
  }

  // The rest require the account's bearer token.
  if (!token || token.length < 16) {
    sendJson(401, { error: 'Missing or malformed bearer token.' });
    return;
  }
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

  if (method === 'GET' && path === '/api/subscription') {
    const sub = await storage.getSubscription(tokenHash);
    sendJson(200, {
      active: await subscriptionActive(tokenHash, storage),
      status: sub?.status ?? null,
      current_period_end: sub?.currentPeriodEnd ?? null,
    });
    return;
  }
  if (method === 'POST' && path === '/api/checkout') {
    const { url } = await createCheckout(tokenHash, billing.gateway, billing.config);
    sendJson(200, { url });
    return;
  }
  if (method === 'POST' && path === '/api/portal') {
    const portal = await createPortal(tokenHash, storage, billing.gateway, billing.config);
    if (!portal) {
      sendJson(404, { error: 'No subscription to manage yet.' });
      return;
    }
    sendJson(200, { url: portal.url });
    return;
  }
  sendJson(404, { error: 'Not found.' });
}

/** Client IP: first hop of x-forwarded-for (set by Vercel), else the socket. */
function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BLOB_BYTES + 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
