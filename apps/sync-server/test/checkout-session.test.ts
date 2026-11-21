import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real gateway talks to Stripe; this fake SDK records what Checkout would
// receive, so the test sees the exact session parameters with no network.
const created: Array<Record<string, unknown>> = [];

vi.mock('stripe', () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          return { url: 'https://checkout.test/session' };
        },
      },
    };
  },
}));

const { createStripeGateway } = await import('../src/billing.js');

describe('createStripeGateway checkout session', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('states the monthly renewal and how to cancel beside the pay button', async () => {
    const gateway = createStripeGateway('sk_test_fake', 'whsec_fake');
    const result = await gateway.createCheckoutSession({
      priceId: 'price_123',
      clientReferenceId: 'hash',
      successUrl: 'https://sync.test/billing/success',
      cancelUrl: 'https://sync.test/billing/cancel',
    });

    expect(result).toEqual({ url: 'https://checkout.test/session' });
    expect(created).toHaveLength(1);
    expect(created[0]!.mode).toBe('subscription');
    expect(created[0]!.custom_text).toEqual({
      submit: {
        message:
          'Your subscription renews automatically every month at the price shown until you cancel. ' +
          'You can cancel any time in the billing portal: choose Manage billing in the NorthKeep app for Mac, ' +
          'or run northkeep sync billing.',
      },
    });
  });

  it('does not require terms-of-service consent, which fails without a terms URL in the Stripe dashboard', async () => {
    const gateway = createStripeGateway('sk_test_fake', 'whsec_fake');
    await gateway.createCheckoutSession({
      priceId: 'price_123',
      clientReferenceId: 'hash',
      customerId: 'cus_123',
      successUrl: 'https://sync.test/billing/success',
      cancelUrl: 'https://sync.test/billing/cancel',
    });

    expect(created[0]!.customer).toBe('cus_123');
    expect(created[0]!.consent_collection).toBeUndefined();
  });
});
