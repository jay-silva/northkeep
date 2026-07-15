import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSyncServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage.js';

/**
 * Wiring test: the throttle must actually gate the real node:http server,
 * before auth and storage, and key by account so one abuser can't starve
 * another.
 */

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

let server: http.Server;
let base: string;

async function start(rateLimit: string | undefined): Promise<void> {
  if (rateLimit === undefined) delete process.env.NORTHKEEP_SYNC_RATE_LIMIT;
  else process.env.NORTHKEEP_SYNC_RATE_LIMIT = rateLimit;
  server = createSyncServer(new InMemoryStorage());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}

async function status(token: string): Promise<Response> {
  return fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
}

describe('sync server rate limiting (HTTP wiring)', () => {
  beforeEach(() => {
    delete process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES;
  });
  afterEach(async () => {
    delete process.env.NORTHKEEP_SYNC_RATE_LIMIT;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('429s an account over the limit, with Retry-After, without starving others', async () => {
    await start('3');
    for (let i = 0; i < 3; i++) expect((await status(TOKEN_A)).status).toBe(404); // vault not pushed yet, but allowed through
    const blocked = await status(TOKEN_A);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // A different account is keyed independently and unaffected.
    expect((await status(TOKEN_B)).status).toBe(404);
  });

  it('throttles tokenless requests by IP at 4x the account cap (webhook flood path)', async () => {
    await start('2'); // account cap 2 → IP ceiling 8
    const hit = (): Promise<Response> =>
      fetch(`${base}/api/webhook`, { method: 'POST', body: 'x' });
    // Billing is off in this harness so the route 404s — what matters is the
    // limiter engages before dispatch and flips to 429.
    for (let i = 0; i < 8; i++) expect((await hit()).status).not.toBe(429);
    expect((await hit()).status).toBe(429);
  });

  it('rotating random bearer tokens cannot mint fresh keys past the IP ceiling', async () => {
    await start('2'); // account cap 2 → IP ceiling 8
    for (let i = 0; i < 8; i++) {
      const r = await status(String(i).repeat(64));
      expect(r.status).not.toBe(429);
    }
    expect((await status('z'.repeat(64))).status).toBe(429);
  });

  it('non-/api/ paths are throttled too — no unthrottled bypass (review H1)', async () => {
    await start('2'); // account cap 2 → IP ceiling 8
    const hit = (path: string): Promise<Response> => fetch(`${base}${path}`);
    for (let i = 0; i < 8; i++) expect((await hit('/nope')).status).not.toBe(429);
    expect((await hit('/nope')).status).toBe(429);
    // The static billing pages share the same IP ceiling.
    expect((await hit('/billing/success')).status).toBe(429);
  });

  it('NORTHKEEP_SYNC_RATE_LIMIT=0 disables the throttle', async () => {
    await start('0');
    for (let i = 0; i < 10; i++) expect((await status(TOKEN_A)).status).toBe(404);
  });
});
