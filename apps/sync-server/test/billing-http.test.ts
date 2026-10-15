import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { BillingDeps, StripeGateway } from '../src/billing.js';
import { createSyncServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage.js';

/** HTTP wiring for the billing routes: the status codes Stripe and clients act on. */

const TOKEN = 'c'.repeat(64);
const HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const nowSec = Math.floor(Date.now() / 1000);

let server: http.Server;

async function start(storage: InMemoryStorage, gateway: Partial<StripeGateway> = {}): Promise<string> {
  const base: StripeGateway = {
    async createCheckoutSession() {
      return { url: 'https://checkout.test/s' };
    },
    async createPortalSession() {
      return { url: 'https://portal.test/p' };
    },
    async retrieveSubscription() {
      return { status: 'active', currentPeriodEnd: nowSec + 3600 };
    },
    verifyWebhook(rawBody, signature) {
      if (signature !== 'good') throw new Error('bad signature');
      return JSON.parse(rawBody.toString('utf8'));
    },
  };
  const billing: BillingDeps = { gateway: { ...base, ...gateway }, config: { priceId: 'price_1', publicBaseUrl: 'https://x' } };
  server = createSyncServer(storage, billing);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function withRow(status: string): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.upsertSubscription({
    tokenHash: HASH,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    status,
    currentPeriodEnd: nowSec + 3600,
  });
  return s;
}

describe('billing routes over HTTP', () => {
  it('checkout answers 409 while a subscription has not ended, and 200 once it has', async () => {
    const live = await start(await withRow('past_due'));
    const refused = await fetch(`${live}/api/checkout`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(refused.status).toBe(409);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const ended = await start(await withRow('canceled'));
    const ok = await fetch(`${ended}/api/checkout`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ url: 'https://checkout.test/s' });
  });

  it('a forged webhook gets 400; a failure after verifying gets 500 so Stripe retries', async () => {
    const url = await start(await withRow('active'), {
      async retrieveSubscription() {
        throw new Error('stripe unreachable');
      },
    });
    const body = JSON.stringify({ type: 'customer.subscription.updated', object: { id: 'sub_1' } });
    const post = (signature: string) =>
      fetch(`${url}/api/webhook`, { method: 'POST', headers: { 'stripe-signature': signature }, body });
    expect((await post('FORGED')).status).toBe(400);
    expect((await post('good')).status).toBe(500);
  });
});
