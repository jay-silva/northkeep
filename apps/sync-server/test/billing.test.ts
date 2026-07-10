import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleSync, type SyncRequest } from '../src/handler.js';
import { InMemoryStorage } from '../src/storage.js';
import {
  createCheckout,
  handleWebhook,
  subscriptionActive,
  type StripeGateway,
  type SubscriptionInfo,
} from '../src/billing.js';

const NOW = Date.now();
const nowSec = Math.floor(NOW / 1000);
const TOKEN = 'a'.repeat(64);
const HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function fakeVaultBlob(size = 200): Buffer {
  const b = Buffer.alloc(size, 0xaa);
  Buffer.from('NKV1', 'ascii').copy(b, 0);
  return b;
}

/** A fake Stripe: verifyWebhook parses the body as the event when signature is 'good'. */
function fakeGateway(subInfo: SubscriptionInfo = { status: 'active', currentPeriodEnd: nowSec + 3600 }): StripeGateway {
  return {
    async createCheckoutSession(a) {
      return { url: `https://checkout.test/${a.clientReferenceId}` };
    },
    async createPortalSession(a) {
      return { url: `https://portal.test/${a.customerId}` };
    },
    async retrieveSubscription() {
      return subInfo;
    },
    verifyWebhook(rawBody, signature) {
      if (signature !== 'good') throw new Error('bad signature');
      return JSON.parse(rawBody.toString('utf8'));
    },
  };
}

describe('subscriptionActive', () => {
  it('is false with no subscription', async () => {
    expect(await subscriptionActive(HASH, new InMemoryStorage(), NOW)).toBe(false);
  });

  it('is true for active/trialing with a future period end, false otherwise', async () => {
    const cases: Array<[string, number, boolean]> = [
      ['active', nowSec + 3600, true],
      ['trialing', nowSec + 3600, true],
      ['active', nowSec - 3600, false], // expired
      ['canceled', nowSec + 3600, false],
      ['past_due', nowSec + 3600, false],
    ];
    for (const [status, periodEnd, expected] of cases) {
      const s = new InMemoryStorage();
      await s.upsertSubscription({
        tokenHash: HASH,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status,
        currentPeriodEnd: periodEnd,
      });
      expect(await subscriptionActive(HASH, s, NOW), `${status} @ ${periodEnd}`).toBe(expected);
    }
  });
});

describe('gate: allowlist OR active subscription', () => {
  function put(): SyncRequest {
    return { method: 'PUT', path: '/api/blob', token: TOKEN, baseVersion: 0, body: fakeVaultBlob() };
  }
  const check = (s: InMemoryStorage) => (h: string) => subscriptionActive(h, s, NOW);

  it('402s an unsubscribed, non-allowlisted account', async () => {
    const s = new InMemoryStorage();
    const res = await handleSync(put(), s, { subscriptionActive: check(s) });
    expect(res.status).toBe(402);
    expect((res.body as { subscribe?: boolean }).subscribe).toBe(true);
  });

  it('allows once a subscription is active', async () => {
    const s = new InMemoryStorage();
    await s.upsertSubscription({
      tokenHash: HASH,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      currentPeriodEnd: nowSec + 3600,
    });
    const res = await handleSync(put(), s, { subscriptionActive: check(s) });
    expect(res.status).toBe(200);
  });

  it('lets an allowlisted account sync free even with billing on and no subscription', async () => {
    const s = new InMemoryStorage();
    const res = await handleSync(put(), s, {
      allowedTokenHashes: new Set([HASH]),
      subscriptionActive: check(s),
    });
    expect(res.status).toBe(200);
  });
});

describe('handleWebhook', () => {
  it('checkout.session.completed upserts a subscription keyed by the token hash', async () => {
    const s = new InMemoryStorage();
    const gw = fakeGateway({ status: 'active', currentPeriodEnd: nowSec + 3600 });
    const event = Buffer.from(
      JSON.stringify({
        type: 'checkout.session.completed',
        object: { client_reference_id: HASH, customer: 'cus_9', subscription: 'sub_9' },
      }),
    );
    const out = await handleWebhook(event, 'good', gw, s);
    expect(out.handled).toBe(true);
    const sub = await s.getSubscription(HASH);
    expect(sub).toMatchObject({ tokenHash: HASH, stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9', status: 'active' });
    // The account can now sync.
    expect(await subscriptionActive(HASH, s, NOW)).toBe(true);
  });

  it('customer.subscription.deleted flips the account inactive', async () => {
    const s = new InMemoryStorage();
    await s.upsertSubscription({
      tokenHash: HASH,
      stripeCustomerId: 'cus_9',
      stripeSubscriptionId: 'sub_9',
      status: 'active',
      currentPeriodEnd: nowSec + 3600,
    });
    const gw = fakeGateway();
    const event = Buffer.from(
      JSON.stringify({
        type: 'customer.subscription.deleted',
        object: { id: 'sub_9', status: 'canceled', current_period_end: nowSec + 3600 },
      }),
    );
    await handleWebhook(event, 'good', gw, s);
    expect(await subscriptionActive(HASH, s, NOW)).toBe(false);
  });

  it('rejects a forged event (bad signature)', async () => {
    const s = new InMemoryStorage();
    const gw = fakeGateway();
    const event = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', object: {} }));
    await expect(handleWebhook(event, 'FORGED', gw, s)).rejects.toThrow();
    // Nothing was written.
    expect(await s.getSubscription(HASH)).toBeNull();
  });

  it('stores NO email or card — only the token hash + Stripe ids + status', async () => {
    const s = new InMemoryStorage();
    const gw = fakeGateway();
    const event = Buffer.from(
      JSON.stringify({
        type: 'checkout.session.completed',
        object: {
          client_reference_id: HASH,
          customer: 'cus_9',
          subscription: 'sub_9',
          customer_email: 'jay@example.com', // present on the event; must NOT be stored
        },
      }),
    );
    await handleWebhook(event, 'good', gw, s);
    const sub = await s.getSubscription(HASH);
    expect(JSON.stringify(sub)).not.toContain('example.com');
    expect(Object.keys(sub!)).toEqual(
      expect.arrayContaining(['tokenHash', 'stripeCustomerId', 'stripeSubscriptionId', 'status', 'currentPeriodEnd']),
    );
    expect(JSON.stringify(sub)).not.toMatch(/email|card|number/i);
  });
});

describe('createCheckout', () => {
  it('passes the token hash as client_reference_id (the account key, not a secret)', async () => {
    const gw = fakeGateway();
    const { url } = await createCheckout(HASH, gw, { priceId: 'price_1', publicBaseUrl: 'https://x' });
    expect(url).toContain(HASH);
  });
});
