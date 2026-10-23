// ADR 0081: an entitlement attestation entitles only the first account that presents it.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { pgliteAsNeon } from './adr0061-support.js';

const SECRET = 'adr0081-entitlement-secret-0123456789';
const HOUR_MS = 60 * 60 * 1000;

function attestation(nonce: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ active: true, period_end: nowSec + 86400, exp: nowSec + 3600, nonce });
  const sig = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sig}`;
}

const bearer = (): string => crypto.randomBytes(32).toString('hex');
const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

let server: Server | null = null;
const saved = { ...process.env };
afterEach(() => {
  server?.close();
  server = null;
  process.env = { ...saved };
});

async function start(storage: ConnectorStorage): Promise<string> {
  process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
  process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT = '0';
  const app = createConnectorServer(storage);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const pairStart = (base: string, token: string, entitlement?: string): Promise<Response> =>
  fetch(`${base}/pair/start`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(entitlement ? { 'x-nb-entitlement': entitlement } : {}),
    },
    body: '{}',
  });

describe('ADR 0081 entitlement binding (HTTP)', () => {
  it('the same account keeps using its attestation on every push', async () => {
    const base = await start(new InMemoryConnectorStorage());
    const token = bearer();
    const a = attestation('nonce-same-account');
    for (let i = 0; i < 3; i++) expect((await pairStart(base, token, a)).status).toBe(200);
  });

  it('a second account presenting a bound attestation gets 402', async () => {
    const base = await start(new InMemoryConnectorStorage());
    const a = attestation('nonce-shared');
    expect((await pairStart(base, bearer(), a)).status).toBe(200);
    expect((await pairStart(base, bearer(), a)).status).toBe(402);
  });

  it('a fault in the nonce table skips the stamp and keeps an existing grace window', async () => {
    class FaultyStorage extends InMemoryConnectorStorage {
      override async bindEntitlementNonce(): Promise<boolean> {
        throw new Error('nonce table unavailable');
      }
    }
    const storage = new FaultyStorage();
    const base = await start(storage);
    const graced = bearer();
    await storage.setEntitledUntil(sha(graced), Date.now() + HOUR_MS);
    expect((await pairStart(base, graced, attestation('nonce-fault-1'))).status).toBe(200);
    expect((await pairStart(base, bearer(), attestation('nonce-fault-2'))).status).toBe(402);
  });
});

describe('ADR 0081 bindEntitlementNonce (storage)', () => {
  const backends: Array<[string, () => ConnectorStorage]> = [
    ['memory', () => new InMemoryConnectorStorage()],
    ['pglite', () => new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite()))],
  ];

  for (const [name, make] of backends) {
    it(`${name}: concurrent first presentations bind exactly one account`, async () => {
      const storage = make();
      const now = Date.now();
      const accounts = Array.from({ length: 25 }, (_, i) => `acct-${i}`);
      const results = await Promise.all(accounts.map((a) => storage.bindEntitlementNonce('n1', a, now + HOUR_MS, now)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = accounts[results.indexOf(true)]!;
      expect(await storage.bindEntitlementNonce('n1', winner, now + HOUR_MS, now)).toBe(true);
    });

    it(`${name}: an expired binding can be taken by another account`, async () => {
      const storage = make();
      const now = Date.now();
      expect(await storage.bindEntitlementNonce('n2', 'a', now + 10, now)).toBe(true);
      expect(await storage.bindEntitlementNonce('n2', 'b', now + HOUR_MS, now)).toBe(false);
      expect(await storage.bindEntitlementNonce('n2', 'b', now + 2 * HOUR_MS, now + 11)).toBe(true);
    });
  }
});
