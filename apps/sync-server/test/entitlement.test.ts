import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { InMemoryStorage } from '../src/storage.js';
import { createSyncServer } from '../src/server.js';
import { signEntitlement, verifyEntitlement } from '../src/entitlement.js';

/**
 * C3 billing bridge — the sync server mints anonymous "active subscriber"
 * attestations (ADR 0019). Proves: sign/verify round-trips; forged, expired, and
 * inactive tokens verify to null; the POST /api/entitlement endpoint 404s with no
 * secret, 401s without a token, and otherwise returns a token whose `active`
 * mirrors the subscription.
 */

const SECRET = 'test-entitlement-secret-abc123';
const nowSec = 1_800_000_000;

describe('entitlement sign/verify', () => {
  it('round-trips an active token', () => {
    const token = signEntitlement(SECRET, { active: true, periodEnd: nowSec + 99999 }, nowSec);
    const claims = verifyEntitlement(SECRET, token, nowSec + 10);
    expect(claims).not.toBeNull();
    expect(claims!.active).toBe(true);
    expect(claims!.period_end).toBe(nowSec + 99999);
  });

  it('rejects a forged signature', () => {
    const token = signEntitlement(SECRET, { active: true, periodEnd: nowSec + 99999 }, nowSec);
    expect(verifyEntitlement('wrong-secret', token, nowSec + 10)).toBeNull();
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifyEntitlement(SECRET, tampered, nowSec + 10)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signEntitlement(SECRET, { active: true, periodEnd: nowSec + 10 }, nowSec);
    // exp = nowSec + 3600; check well past that.
    expect(verifyEntitlement(SECRET, token, nowSec + 4000)).toBeNull();
  });

  it('rejects an inactive token (period_end forced to 0)', () => {
    const token = signEntitlement(SECRET, { active: false, periodEnd: nowSec + 99999 }, nowSec);
    expect(verifyEntitlement(SECRET, token, nowSec + 10)).toBeNull();
  });

  it('rejects junk', () => {
    expect(verifyEntitlement(SECRET, 'not-a-token', nowSec)).toBeNull();
    expect(verifyEntitlement(SECRET, '', nowSec)).toBeNull();
    expect(verifyEntitlement(SECRET, '.sig', nowSec)).toBeNull();
  });
});

describe('POST /api/entitlement endpoint', () => {
  const priorSecret = process.env.CONNECTOR_ENTITLEMENT_SECRET;
  let server: http.Server | undefined;

  afterEach(async () => {
    if (priorSecret === undefined) delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    else process.env.CONNECTOR_ENTITLEMENT_SECRET = priorSecret;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(): Promise<string> {
    const s = createSyncServer(new InMemoryStorage(), null);
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    const addr = s.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  it('404s when no entitlement secret is configured', async () => {
    delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    const base = await start();
    const res = await fetch(`${base}/api/entitlement`, {
      method: 'POST',
      headers: { authorization: 'Bearer sync-token-1234567890' },
    });
    expect(res.status).toBe(404);
  });

  it('401s without a bearer token, mints a verifiable token with one', async () => {
    process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
    const base = await start();

    const noAuth = await fetch(`${base}/api/entitlement`, { method: 'POST' });
    expect(noAuth.status).toBe(401);

    // A non-subscriber gets active:false — verify then rejects it (inactive).
    const res = await fetch(`${base}/api/entitlement`, {
      method: 'POST',
      headers: { authorization: 'Bearer sync-token-1234567890' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entitlement: string; active: boolean };
    expect(body.active).toBe(false);
    expect(verifyEntitlement(SECRET, body.entitlement)).toBeNull(); // inactive → null
  });

  it('mints an active token for a subscribed account', async () => {
    process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
    const storage = new InMemoryStorage();
    const s = createSyncServer(storage, null);
    server = s;
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
    const addr = s.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    const token = 'sync-token-subscriber-01';
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    await storage.upsertSubscription({
      tokenHash,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 86_400,
    });

    const res = await fetch(`${base}/api/entitlement`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entitlement: string; active: boolean };
    expect(body.active).toBe(true);
    const claims = verifyEntitlement(SECRET, body.entitlement);
    expect(claims).not.toBeNull();
    expect(claims!.active).toBe(true);
  });
});
