// ADR 0081: one attestation nonce per subscriber per day, keyed by a sync-only secret.
import { afterEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSyncServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage.js';
import {
  ENTITLEMENT_NONCE_WINDOW_SEC,
  entitlementNonce,
  entitlementNonceKeyFromEnv,
} from '../src/entitlement.js';

const SECRET = 'adr0081-shared-secret-0123456789abcdef';
const KEY = 'adr0081-nonce-key-0123456789abcdef-xyz';

let server: http.Server | null = null;
const saved = { ...process.env };
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  process.env = { ...saved };
});

async function start(): Promise<string> {
  process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
  server = createSyncServer(new InMemoryStorage());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const mint = (base: string, token: string): Promise<Response> =>
  fetch(`${base}/api/entitlement`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });

async function nonceOf(res: Response): Promise<string> {
  const { entitlement } = (await res.json()) as { entitlement: string };
  const body = JSON.parse(Buffer.from(entitlement.split('.')[0]!, 'base64url').toString('utf8')) as { nonce: string };
  return body.nonce;
}

describe('ADR 0081 attestation nonces', () => {
  it('one subscriber gets the same nonce on every mint within a day', async () => {
    process.env.NORTHKEEP_ENTITLEMENT_NONCE_KEY = KEY;
    const base = await start();
    const token = 'a'.repeat(64);
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) nonces.add(await nonceOf(await mint(base, token)));
    expect(nonces.size).toBe(1);
    expect(await nonceOf(await mint(base, 'b'.repeat(64)))).not.toBe([...nonces][0]);
  });

  it('the nonce changes with the day and with the key', () => {
    const t = 'c'.repeat(64);
    const day = 1_800_000_000 - (1_800_000_000 % ENTITLEMENT_NONCE_WINDOW_SEC);
    expect(entitlementNonce(KEY, t, day)).toBe(entitlementNonce(KEY, t, day + ENTITLEMENT_NONCE_WINDOW_SEC - 1));
    expect(entitlementNonce(KEY, t, day)).not.toBe(entitlementNonce(KEY, t, day + ENTITLEMENT_NONCE_WINDOW_SEC));
    expect(entitlementNonce(KEY, t, day)).not.toBe(entitlementNonce(`${KEY}-other`, t, day));
  });

  it('refuses to mint (503) without a usable nonce key', async () => {
    delete process.env.NORTHKEEP_ENTITLEMENT_NONCE_KEY;
    const base = await start();
    expect((await mint(base, 'd'.repeat(64))).status).toBe(503);
  });

  it('rejects a nonce key that is short or equal to the shared secret', () => {
    expect(entitlementNonceKeyFromEnv({ NORTHKEEP_ENTITLEMENT_NONCE_KEY: 'short' }, SECRET)).toBeNull();
    expect(entitlementNonceKeyFromEnv({ NORTHKEEP_ENTITLEMENT_NONCE_KEY: SECRET }, SECRET)).toBeNull();
    expect(entitlementNonceKeyFromEnv({ NORTHKEEP_ENTITLEMENT_NONCE_KEY: KEY }, SECRET)).toBe(KEY);
  });
});
