// Security review 2026-10-22: the sync server's gate and per-IP limiter (F2, F2b, F3).
import { afterEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSyncServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage.js';

let server: http.Server | null = null;
const saved = { ...process.env };
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  process.env = { ...saved };
});

async function start(): Promise<string> {
  server = createSyncServer(new InMemoryStorage());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const status = (base: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${'c'.repeat(64)}`, ...headers } });

describe('security review: sync server', () => {
  it('F2: no allowlist, no billing and no explicit open flag is a private server', async () => {
    delete process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES;
    delete process.env.NORTHKEEP_SYNC_OPEN;
    expect((await status(await start())).status).toBe(403);
  });

  it('F2: NORTHKEEP_SYNC_OPEN=1 keeps a self-host server open', async () => {
    delete process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES;
    process.env.NORTHKEEP_SYNC_OPEN = '1';
    expect((await status(await start())).status).toBe(404);
  });

  it('F2b: a malformed allowlist stays private even when open is set', async () => {
    process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES = 'not-a-hash';
    process.env.NORTHKEEP_SYNC_OPEN = '1';
    expect((await status(await start())).status).toBe(403);
  });

  it('F3: rotating a client-chosen first X-Forwarded-For hop does not dodge the per-IP limit', async () => {
    process.env.NORTHKEEP_SYNC_RATE_LIMIT = '1';
    const base = await start();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${base}/api/webhook`, {
        method: 'POST',
        body: 'x',
        headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.9` },
      });
      codes.push(r.status);
    }
    expect(codes).toContain(429);
  });
});
