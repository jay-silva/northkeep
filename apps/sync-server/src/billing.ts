import Stripe from 'stripe';
import type { Storage } from './storage.js';

/**
 * Billing (M5b, ADR 0010). A $10/mo Stripe subscription gates the hosted sync
 * service for accounts not on the allowlist.
 *
 * Privacy posture (bounded, honest): we store ONLY `token_hash ↔ Stripe
 * customer/subscription id + status`. The email and card live ONLY in Stripe —
 * they never touch our server or DB. Checkout is Stripe-HOSTED, so no card
 * data (and no PCI scope) ever reaches us. The link this creates is
 * "which paying customer owns which ENCRYPTED vault", never its contents.
 *
 * The Stripe operations are behind a small `StripeGateway` interface so the
 * e2e suite can inject a fake; production uses `createStripeGateway`.
 */

export interface SubscriptionInfo {
  status: string;
  /** Unix seconds. */
  currentPeriodEnd: number;
}

export interface WebhookEvent {
  type: string;
  // The Stripe object payload (session or subscription); typed loosely so the
  // fake gateway can construct one without the full SDK types.
  object: Record<string, unknown>;
}

export interface StripeGateway {
  createCheckoutSession(args: {
    priceId: string;
    clientReferenceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
  createPortalSession(args: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(subscriptionId: string): Promise<SubscriptionInfo>;
  /** Verify the signature over the RAW body; throws if invalid. */
  verifyWebhook(rawBody: Buffer, signature: string): WebhookEvent;
}

export interface BillingConfig {
  priceId: string;
  publicBaseUrl: string;
}

/** True when the account has a paid, non-expired subscription. */
export async function subscriptionActive(
  tokenHash: string,
  storage: Storage,
  now: number = Date.now(),
): Promise<boolean> {
  const sub = await storage.getSubscription(tokenHash);
  if (!sub) return false;
  const live = sub.status === 'active' || sub.status === 'trialing';
  return live && sub.currentPeriodEnd * 1000 > now;
}

/** Create a hosted Checkout session for this account; returns the URL to open. */
export async function createCheckout(
  tokenHash: string,
  gateway: StripeGateway,
  config: BillingConfig,
): Promise<{ url: string }> {
  const session = await gateway.createCheckoutSession({
    priceId: config.priceId,
    clientReferenceId: tokenHash,
    successUrl: `${config.publicBaseUrl}/billing/success`,
    cancelUrl: `${config.publicBaseUrl}/billing/cancel`,
  });
  return { url: session.url };
}

/** Create a billing-portal session (manage/cancel), or null if not subscribed. */
export async function createPortal(
  tokenHash: string,
  storage: Storage,
  gateway: StripeGateway,
  config: BillingConfig,
): Promise<{ url: string } | null> {
  const sub = await storage.getSubscription(tokenHash);
  if (!sub) return null;
  const session = await gateway.createPortalSession({
    customerId: sub.stripeCustomerId,
    returnUrl: `${config.publicBaseUrl}/billing/success`,
  });
  return { url: session.url };
}

/**
 * Handle a Stripe webhook. The signature is verified over the raw body FIRST
 * (a forged event is rejected). We map the account by:
 *  - checkout.session.completed → carries client_reference_id (= token hash),
 *    customer, subscription. Retrieve the subscription for accurate status and
 *    period, then upsert.
 *  - customer.subscription.updated | .deleted → carry the subscription id (not
 *    the token hash); update the existing row by that id.
 */
export async function handleWebhook(
  rawBody: Buffer,
  signature: string,
  gateway: StripeGateway,
  storage: Storage,
): Promise<{ handled: boolean }> {
  const event = gateway.verifyWebhook(rawBody, signature); // throws on bad signature

  if (event.type === 'checkout.session.completed') {
    const s = event.object;
    const tokenHash = typeof s.client_reference_id === 'string' ? s.client_reference_id : null;
    const customer = stringId(s.customer);
    const subscriptionId = stringId(s.subscription);
    if (!tokenHash || !customer || !subscriptionId) return { handled: false };
    const info = await gateway.retrieveSubscription(subscriptionId);
    await storage.upsertSubscription({
      tokenHash,
      stripeCustomerId: customer,
      stripeSubscriptionId: subscriptionId,
      status: info.status,
      currentPeriodEnd: info.currentPeriodEnd,
    });
    return { handled: true };
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.object;
    const subscriptionId = typeof sub.id === 'string' ? sub.id : null;
    const status = typeof sub.status === 'string' ? sub.status : null;
    const periodEnd = typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
    if (!subscriptionId || !status || periodEnd === null) return { handled: false };
    await storage.updateSubscriptionByStripeId(subscriptionId, status, periodEnd);
    return { handled: true };
  }

  return { handled: false }; // ignored event type
}

/** A Stripe id field may be a bare id string or an expanded object with `.id`. */
function stringId(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

export interface BillingDeps {
  gateway: StripeGateway;
  config: BillingConfig;
}

/**
 * Build billing from the environment, or null when Stripe isn't configured
 * (self-host / open server — no Stripe account needed). Requires
 * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, PUBLIC_BASE_URL.
 */
export function billingFromEnv(env: NodeJS.ProcessEnv = process.env): BillingDeps | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const priceId = env.STRIPE_PRICE_ID;
  const publicBaseUrl = env.PUBLIC_BASE_URL;
  const present = [secretKey, webhookSecret, priceId, publicBaseUrl].filter(Boolean).length;
  // None set → billing is legitimately OFF (self-host / open server, ADR 0009).
  if (present === 0) return null;
  // Some but not all set → a misconfiguration. FAIL CLOSED: never silently
  // disable the paywall (adversarial review M-1). A hosted deploy that loses one
  // Stripe var should crash visibly, not degrade to a free-for-all.
  if (present < 4) {
    throw new Error(
      'Incomplete Stripe billing configuration. Set ALL of STRIPE_SECRET_KEY, ' +
        'STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, PUBLIC_BASE_URL — or NONE (to run without billing).',
    );
  }
  return {
    gateway: createStripeGateway(secretKey!, webhookSecret!),
    config: { priceId: priceId!, publicBaseUrl: publicBaseUrl!.replace(/\/$/, '') },
  };
}

/** Production gateway backed by the Stripe SDK. */
export function createStripeGateway(secretKey: string, webhookSecret: string): StripeGateway {
  // Pin the API version to the one this SDK's types describe (adversarial review
  // M-2). Without a pin, the account's default API version is used at runtime,
  // which can differ from the compiled types — e.g. a newer version relocates
  // `current_period_end` off the top-level Subscription, silently breaking the
  // gate for real subscribers. A pinned version keeps runtime and types in sync;
  // a future SDK upgrade must re-verify the period fields.
  const stripe = new Stripe(secretKey, { apiVersion: '2025-02-24.acacia' });
  return {
    async createCheckoutSession({ priceId, clientReferenceId, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: clientReferenceId,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
      return { url: session.url };
    },
    async createPortalSession({ customerId, returnUrl }) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return { url: session.url };
    },
    async retrieveSubscription(subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      return { status: sub.status, currentPeriodEnd: sub.current_period_end };
    },
    verifyWebhook(rawBody, signature) {
      const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      return { type: event.type, object: event.data.object as unknown as Record<string, unknown> };
    },
  };
}
