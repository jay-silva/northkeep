// Security review 2026-10-22: each test asserts the safe behavior; all failed on main 356285b.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { isBlockedAddress } from '../src/cimd.js';

let server: Server | null = null;
const saved = { ...process.env };
afterEach(() => {
  server?.close();
  server = null;
  process.env = { ...saved };
});

async function start(): Promise<string> {
  const app = createConnectorServer(new InMemoryConnectorStorage());
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('security review: connector', () => {
  it('F2: with no gate env set, an unknown bearer must not get a paid route', async () => {
    delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    delete process.env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES;
    delete process.env.NORTHKEEP_CONNECTOR_OPEN;
    const base = await start();
    const r = await fetch(`${base}/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('hex')}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).not.toBe(200);
  });

  it('F3: the per-IP limiter must not trust a client-chosen X-Forwarded-For first hop', async () => {
    process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT = '1';
    const base = await start();
    const control: number[] = [];
    for (let i = 0; i < 6; i++) control.push((await fetch(`${base}/client/manifest`, { headers: { 'x-forwarded-for': '198.51.100.7' } })).status);
    expect(control).toContain(429);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${base}/client/manifest`, { headers: { 'x-forwarded-for': `203.0.113.${i}, 10.0.0.1` } });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });

  it('F2b: a malformed allowlist (operator typo) must not open the paid routes', async () => {
    delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    process.env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES = 'not-a-hash';
    const base = await start();
    const r = await fetch(`${base}/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('hex')}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).not.toBe(200);
  });

  it('F3b: the general per-IP limiter must group one IPv6 /64 (ADR 0061 F1 applied only to /token)', async () => {
    process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT = '1';
    const base = await start();
    const statuses: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const r = await fetch(`${base}/client/manifest`, { headers: { 'x-forwarded-for': `2001:db8:1:1::${i.toString(16)}` } });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });

  it('F4: the consent page must refuse framing', async () => {
    const base = await start();
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://attacker.example/cb'], client_name: 'ChatGPT', token_endpoint_auth_method: 'none' }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({
      client_id, response_type: 'code', redirect_uri: 'https://attacker.example/cb',
      code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
    });
    const r = await fetch(`${base}/authorize?${q}`);
    expect(r.status).toBe(200);
    const framing = `${r.headers.get('x-frame-options') ?? ''} ${r.headers.get('content-security-policy') ?? ''}`;
    expect(framing).toMatch(/DENY|frame-ancestors/i);
    expect(await r.text()).toContain('attacker.example');
  });

  it('F5: CIMD SSRF guard must refuse IPv4-compatible, NAT64 and 6to4 forms of private addresses', () => {
    expect(isBlockedAddress('::7f00:1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isBlockedAddress('2002:a9fe:a9fe::1')).toBe(true);
  });
});
