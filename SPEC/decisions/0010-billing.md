# ADR 0010: Stripe billing to gate hosted sync ($10/month)

Status: Accepted 2026-07-10 (M5b) · Review: adversarial review 2026-07-10, no CRITICAL or HIGH findings; M-1, M-2, L-1 fixed; two live self-test bugs (2026-07-11) fixed

## Context
ADR 0009 shipped zero-knowledge vault sync: the account derives from the device secret and the server holds no email or PII. M5b makes the hosted service paid, which needs a payment identity. Jay chose a bounded privacy link, subscription-or-allowlist, and $10/month with no trial.

## Decision
- D1: Our DB stores only `token_hash`, `stripe_customer_id`, `stripe_subscription_id` (UNIQUE), `status`, `current_period_end`, `updated_at` in a `subscriptions` table. Email and card live only in Stripe; Checkout is Stripe-hosted, so no card data or PCI scope reaches us.
- D2: `handleSync` allows a request if the account is on `NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES` (now the free/comp list) OR has an active subscription, else HTTP 402. `subscriptionActive` requires status in {active, trialing} AND a future `current_period_end`.
- D3: Billing is off when none of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `PUBLIC_BASE_URL` is set (self-host path as in ADR 0009); a partial set throws at boot (fail closed, review fix M-1).
- D4: One recurring $10/month price. No trials, annual plans or tiers in M5b.
- D5: Billing runs on the sync server behind a `StripeGateway` interface: `POST /api/checkout` (`client_reference_id` = the caller's token hash), `POST /api/webhook` (signature verified over the raw body first), `POST /api/portal`, `GET /api/subscription`. Billing routes match before the sync gate. All key off the caller's own token hash.
- D6: The gateway pins `apiVersion: '2025-02-24.acacia'`; `readPeriodEnd()` reads `current_period_end` at top level or under `items.data[]`, and a `deleted` event is never ignored for a missing period (canceled means blocked now).
- D7: CLI `northkeep sync subscribe` / `sync billing`; GUI buttons open only `https://` Stripe URLs, with `noopener`.

## Consequences
- Easier: self-hosting stays free and fully anonymous (no Stripe env, no Stripe account).
- Harder: the operator can correlate a paying Stripe customer with their encrypted vault, never its contents (invariant #2 unchanged). Documented in KNOWN-LIMITS.
- Limits: the gate depends on webhook delivery; a missed `subscription.deleted` leaves an account syncing until `current_period_end` passes. No dunning beyond Stripe defaults. Any Stripe SDK upgrade must re-verify period parsing. The GUI's generic 500 handler reflects `err.message` to the local page (pre-existing); no M5b error path carries a Stripe secret.

## Rejected
The original lists no alternatives. It notes that Stripe-hosted Checkout keeps card data and PCI scope off our server, and billing-off-by-default preserves the anonymous self-host path.

## What leaves the machine
The original has no egress section; it states sync stays ciphertext-only (invariant #2). The GUI and CLI call the sync server, which returns only a Stripe-hosted URL; the user's email and card go from the browser to Stripe. The sync server calls only Stripe's API (dependency `stripe`, `^17.0.0`, Jay-approved under invariant #7) and sends Stripe the token hash as `client_reference_id`. The secret key never appears in a response, log or error.

## Links
Extends: ADR 0009 · Full record: docs/design/adr-0010-billing.md
