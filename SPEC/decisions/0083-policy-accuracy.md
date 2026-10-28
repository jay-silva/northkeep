# ADR 0083: Privacy policy and terms state only what the code does today

Status: Proposed 2026-10-28 · Review: CLEARED on recheck; findings and fixes in the design record

## Context
A 2026-10-28 audit read PRIVACY.md and TERMS.md against the code. Several published claims promised more than the system enforces: a stored record of auto-renewal consent, contributor terms that do not exist, "Self-hosting is fully anonymous" while the iPhone app defaults to hosted servers, a GDPR sentence merging the 72-hour regulator rule with user notice, a visible-fields list missing connector metadata, an update check that did not name GitHub, and "the Privacy Policy lists all of it". Under the review gate, a false claim is a defect.

## Decision
- D1: Every published claim is narrowed to what the code does now. Where a promise is not kept, the promise is narrowed or removed; no feature is built to meet it.
- D2: No new commitments: no new deadlines, notice periods, retention periods or absolutes. Lists of recipients and stored fields read "such as", never "all".
- D3: Checkout states the renewal terms. `checkout.sessions.create` adds `custom_text.submit.message`: the subscription renews monthly at the shown price until cancelled, and can be cancelled in the billing portal. `consent_collection` is not set, because it fails when the Stripe dashboard has no terms URL.
- D4: The contributor-terms sentence becomes "you confirm you have the right to do so; we may ask you to agree to separate terms". No outside contribution is merged before a contributor agreement exists.
- D5: The site pages and the sync server deploy together, because the new renewal wording is true only once checkout shows the notice.
- Founder, 2026-10-28: minimize liability; cut promises rather than build to them.

## Consequences
- Easier: every sentence in both documents has a file:line source in the design record.
- Harder: four terms promises still depend on Stripe dashboard settings (renewal reminders, no retention step, access to period end, price-change email). The founder checks them; code cannot.
- Committed to: a test pinning the checkout notice; the doc-versus-code pass before each release.

## Rejected
- Building a consent store: adds a schema and a stored record for a promise the law does not require us to word that way.
- `consent_collection.terms_of_service`: breaks checkout if the dashboard lacks a terms URL.
- Replacing vendor names with categories only: the stack is public in this repo; accuracy is the exposure, not naming.

## What leaves the machine
No new recipient and no new data. Stripe receives a fixed two-sentence checkout notice. The policy now discloses the existing GitHub update check (click only) and existing connector metadata.

## Links
Design and review findings: docs/design/adr-0083-policy-accuracy.md · Extends: ADR 0060
