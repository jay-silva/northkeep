# ADR 0010 — Stripe billing to gate hosted sync ($10/month)

- **Date:** 2026-07-10
- **Status:** Accepted (M5b)
- **Deciders:** Jay (product owner; chose the bounded privacy link, subscription-OR-allowlist, and monthly $10 no-trial), Claude Code

## Context

ADR 0009 shipped encrypted vault sync as an open service kept private by an
optional token allowlist. M5b turns the hosted service into a paid product: a
**$10/month Stripe subscription** gates sync for anyone not on the allowlist —
the blueprint's "10+ pay $10/mo to follow them to a second machine."

The tension: M5 sync is **zero-knowledge** (the account is derived from the
device secret; no email/PII on the server — ADR 0009), but billing needs a
payment identity. Three decisions locked with Jay resolve it.

## Decision 1: A bounded privacy link — status only, email and card live only in Stripe

Our DB stores exactly one new fact per paying account: `token_hash ↔ Stripe
customer id + subscription id + status + current_period_end`. The **email and
card never touch our server or DB** — they live only in Stripe. Checkout is
**Stripe-hosted**, so no card data (and no PCI scope) ever reaches us; this also
honors the product rule against entering financial credentials into our own
fields.

The honest consequence, documented in KNOWN-LIMITS: the operator *can* now
correlate "which paying Stripe customer owns which **encrypted** vault" — never
its contents (still ciphertext-only, invariant #2), but the anonymity of ADR
0009's hosted path is reduced to a bounded payer↔ciphertext link. **Self-hosting
stays fully anonymous**: a self-hosted server sets no Stripe env, so billing is
off and only the allowlist gates — no Stripe account required to run Northkeep.

## Decision 2: Subscription OR allowlist — the allowlist becomes the free/comp list

The gate in `handleSync` allows a request if the account is **on the allowlist
OR has an active subscription**, else returns **HTTP 402** with a subscribe
hint. The existing `NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES` allowlist becomes the
**free/comp list**: Jay's own account and anyone he comps sync free, and
self-hosters run entirely free. Only non-listed hosted users must subscribe.
`subscriptionActive(tokenHash)` is `status ∈ {active, trialing}` AND
`current_period_end` in the future.

Billing is **off unless Stripe is configured** (`billingFromEnv` returns null
without all of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`,
`PUBLIC_BASE_URL`), so the server falls back to allowlist/open exactly as ADR
0009 — preserving the OSS self-host path.

## Decision 3: Monthly $10, no trial — one Stripe price

One recurring Stripe price, subscribe-or-not. Free trials, annual plans, and
multiple tiers are out of scope for M5b.

## Architecture

Billing runs **on the sync server** (it already holds the Neon DB and is the
public HTTPS endpoint). The Stripe operations sit behind a small
`StripeGateway` interface (`billing.ts`) so the e2e suite injects a fake Stripe
(no real keys, no network); production uses `createStripeGateway` over the
`stripe` SDK.

- **`subscriptions` table** (Neon): `token_hash text PK, stripe_customer_id,
  stripe_subscription_id text UNIQUE, status, current_period_end bigint,
  updated_at`. Keyed by `token_hash` for the gate; `stripe_subscription_id` is
  UNIQUE so webhook `subscription.updated/deleted` events (which carry only the
  subscription id, not the token hash) can find the row.
- **Checkout** `POST /api/checkout` (bearer token → `token_hash`): creates a
  Stripe Checkout Session (`mode: subscription`, `client_reference_id =
  token_hash`, success/cancel URLs on the sync server) → returns `{url}`. The
  client opens it in a browser. No card data on us.
- **Webhook** `POST /api/webhook`: verifies the Stripe signature over the **raw**
  body FIRST (never JSON-parse before verifying). `checkout.session.completed`
  carries `client_reference_id` (= token hash) → retrieve the subscription →
  upsert. `customer.subscription.updated|deleted` → look up by
  `stripe_subscription_id`, update status/period.
- **Portal** `POST /api/portal`: look up the customer → Stripe billing-portal
  session → `{url}` (manage/cancel). 404 if no subscription.
- **Status** `GET /api/subscription` (bearer): `{active, status,
  current_period_end}`.
- **The gate**: `handler.ts` allows on allowlist OR active sub, else 402. Billing
  routes are matched BEFORE the sync gate so checkout/subscription are reachable
  without a subscription.

Client surfaces (`packages/sync`): `subscriptionStatus`, `checkoutUrl`,
`portalUrl`, and a `SubscriptionRequiredError` that push/pull raise on a 402.
CLI: `northkeep sync subscribe` / `northkeep sync billing`, and `sync status`
shows subscription state. GUI Sync tab: a "Subscribe — $10/month" button (opens
Stripe Checkout in a new tab) and "Manage billing" when subscribed; the web
server calls the sync server in Node and returns only the Stripe-hosted URL.

## Dependencies introduced (invariant #7 — Jay approved via the M5b plan)

- `stripe` (server-side only, `apps/sync-server`), pinned `^17.0.0` (installed
  17.7.0). Outbound calls go only to Stripe's API; the secret key is read from
  env and never appears in a response, log, or error. **Pin note:** this SDK
  version's `Subscription` type exposes `current_period_end` at the top level;
  a future major Stripe API bump relocates that field to
  `subscription.items.data[].current_period_end`, so a SDK upgrade must
  re-verify `retrieveSubscription` and the webhook period parsing.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`,
  `PUBLIC_BASE_URL`. None are committed; test-mode keys first, then live with Jay.

## Consequences & honest limits (KNOWN-LIMITS.md)

- **Bounded payer↔ciphertext link on the hosted service.** The operator can
  correlate a paying Stripe customer to their encrypted vault — never its
  contents (invariant #2 unchanged). Self-hosting stays fully anonymous.
- **The gate depends on webhook delivery.** A missed `subscription.deleted`
  webhook leaves an account able to sync until `current_period_end` passes (then
  the time check fails closed). Stripe retries webhooks; the period check is the
  backstop.
- **No dunning/failed-payment flows** beyond Stripe defaults; a lapsed card
  flips the account inactive via the subscription-status webhook.

## Adversarial review (2026-07-10)

A high-bar review (money + network + privacy + key hygiene) against the built
code, with both test suites green. **No CRITICAL or HIGH findings.** The
load-bearing properties were verified empirically:

1. **Invariant #2 holds — no plaintext, and now no PII either.** The
   `subscriptions` schema has exactly `token_hash, stripe_customer_id,
   stripe_subscription_id, status, current_period_end, updated_at` — no
   email/card column. `handleWebhook` extracts only those fields even when the
   event carries `customer_email` (asserted by unit + e2e: the stored row
   matches no `/email|card|number|@/i`). Checkout is Stripe-hosted; no card data
   ever reaches us.
2. **The gate has no bypass.** Allow on allowlist OR active subscription, else
   402; `subscriptionActive` requires status ∈ {active, trialing} AND a future
   `current_period_end` (canceled/past_due/expired/missing-period all fail). All
   four (allowlist × billing) combinations are tested.
3. **Webhooks are unforgeable.** The signature is verified over the RAW body as
   the first statement, before any field access; a forged event throws → generic
   400, nothing written. `client_reference_id` is hard-set to the authenticated
   caller's own token hash, so no cross-account grant; knowing a victim's token
   *hash* grants nothing (syncing needs the token preimage).
4. **No cross-account read** via `/api/subscription|checkout|portal` — all key
   off the caller's own token hash; no account id is accepted from the client.
5. **Secret hygiene** — no `console.*` in the server or sync client; no
   response/error emits the Stripe secret, webhook secret, `DATABASE_URL`,
   tokens, or blob bytes. New SQL is fully parameterized. GUI renders
   sync-server-supplied text via `textContent`, never `innerHTML`.

**Fixed from the review:**
- **M-1 — paywall fail-open on partial Stripe config.** `billingFromEnv` used to
  return null (billing off) if *any* Stripe var was missing, so a hosted deploy
  that lost one var silently became a free-for-all. Now: none set → off
  (legit self-host); some-but-not-all set → **throws at boot** (fail closed).
  Unit-tested.
- **M-2 — Stripe API version drift.** The gateway now pins
  `apiVersion: '2025-02-24.acacia'` (the version this SDK's types describe) so
  runtime and compiled types agree on `current_period_end` at the top level; a
  newer default API version would relocate that field and silently deny real
  subscribers. Flagged for re-verification on any SDK upgrade.
- **GUI subscribe button never surfaced.** A new user on a billing server has
  `status: null`, indistinguishable from a self-hosted no-billing server from the
  status payload alone. Added a `billing` flag (a 200 vs 404 from the
  subscription endpoint is the discriminator); the GUI/CLI now show the Subscribe
  prompt correctly.
- **L-1 — untrusted `window.open` URL.** The GUI now opens the Stripe URL only if
  it is an `https://` URL (rejects `javascript:`/`data:`), with `noopener`.
- **e2e faithfulness** — the fake Stripe webhook now uses Stripe's real
  `{type, data:{object}}` wire envelope (mirroring `createStripeGateway`), and the
  test uses `createRequire` instead of a bare `require` in the ES module.

**Accepted, documented, not fixed (within stated limits):**
- **The bounded payer↔ciphertext link** (Decision 1) is the deliberate privacy
  cost of hosted billing; self-hosting stays anonymous.
- **Gate depends on webhook delivery**; the `current_period_end` time check is the
  fail-closed backstop for a missed `subscription.deleted`.
- **The web GUI's generic 500 handler reflects `err.message`** to the same-origin
  localhost page (pre-existing across all routes since ADR 0009; the audience is
  the local vault owner). No M5b error path carries a Stripe secret.
