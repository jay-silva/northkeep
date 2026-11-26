import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectorReencryptError, pushSharedScopes } from '../src/connector-client.js';

const vault = {
  list: ({ scope }: { scope?: string }) =>
    scope === 'work' ? [{ id: 'e1', entry_hash: 'h1', scope: 'work', type: 'fact', content: 'fictional note' }] : [],
  sharedScopeRows: () => [],
} as unknown as Parameters<typeof pushSharedScopes>[0]['vault'];

let server: http.Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function connector(status: number, rebuild?: string): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ ok: true, scopes: ['work'], upserted: 1 }) : JSON.stringify({ error: 'reencrypt_required', rebuild }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, bodies };
}

describe('rebuild push', () => {
  it('sends rebuild only when asked', async () => {
    const conn = await connector(200);
    const deviceSecret = crypto.randomBytes(32);
    await pushSharedScopes({ server: conn.url, deviceSecret, scopes: ['work'], vault });
    await pushSharedScopes({ server: conn.url, deviceSecret, scopes: ['work'], vault, rebuild: true });
    expect(conn.bodies[0]).not.toHaveProperty('rebuild');
    expect(conn.bodies[1]?.rebuild).toBe(true);
  });

  it('a 409 the server can rebuild tells the user how, and what is lost', async () => {
    const conn = await connector(409, 'available');
    const err = await pushSharedScopes({ server: conn.url, deviceSecret: crypto.randomBytes(32), scopes: ['work'], vault }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorReencryptError);
    expect(err.rebuildAvailable).toBe(true);
    expect(err.message).toMatch(/share push --rebuild/);
    expect(err.message).toMatch(/not reached this device are lost/);
  });

  it('a 409 the server will not rebuild offers no rebuild', async () => {
    const conn = await connector(409, 'unavailable');
    const err = await pushSharedScopes({ server: conn.url, deviceSecret: crypto.randomBytes(32), scopes: ['work'], vault }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorReencryptError);
    expect(err.rebuildAvailable).toBe(false);
    expect(err.message).not.toMatch(/rebuild/);
    expect(err.message).toMatch(/Nothing was changed/);
  });
});
