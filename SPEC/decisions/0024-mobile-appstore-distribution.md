# ADR 0024: Mobile App Store distribution and licensing

- **Date:** 2026-07-16
- **Status:** Proposed. Requires Jay's Apple Developer account and a REAL
  submission to validate; nothing here is confirmed until an actual EAS build
  clears App Store review. The build/submit configuration is scaffolded in
  apps/mobile; the licensing and privacy decisions below take effect only when
  the app is actually published.
- **Deciders:** Jay, Claude Code

## Context

Track M ships to the iOS App Store first (Android roughly two to three weeks
behind, one store review at a time). Three things about NorthKeep make the
review posture non-obvious and worth deciding deliberately: it is BYOK (the user
brings their own model API key), it is AGPL-licensed, and its business model is a
subscription sold on the web. Each intersects an App Store rule.

## Decision

### Build and submit with Expo / EAS

Use Expo SDK 55+ with the React Native New Architecture, expo-router, and
EAS Build / EAS Submit for the store pipeline (config in
apps/mobile/app.config.ts and the EAS project). Rejected alternatives (Tauri
mobile, bare React Native, native Swift/Kotlin) were settled in ADR 0021's
platform decision; this ADR concerns only the distribution and store-compliance
layer on top.

### No in-app purchase; the subscription is bought on northkeep.ai

Ship with NO in-app purchase flow and no in-app steering toward one. The
$10/month sync subscription is purchased on northkeep.ai, and the app simply
works when the device-secret-derived sync token is entitled. This is the
multiplatform-services pattern that guideline 3.1.3(b) explicitly permits: a
service usable outside the app may be accessed in the app without IAP, as long as
the app does not link out to or advertise the external purchase. It keeps Apple's
commission off the subscription and carries essentially zero review risk,
provided the app stays silent about where to buy and never gates a purchase
screen behind itself.

### BYOK review-risk mitigations

Bring-your-own-key apps are established on the store, but two rejection vectors
apply: guideline 4.2 (minimum functionality) and 2.1 (completeness), because a
reviewer with no API key could see an app that "does nothing." Mitigations:

- **On-device chat with no key required.** The airplane-mode private-chat path
  (ADR 0023) means the app is fully functional for a reviewer who never enters a
  key, directly answering the 4.2 concern.
- **A built-in demo vault ("Try NorthKeep").** A seeded, throwaway demo vault
  lets a reviewer browse, search, and exercise the app end to end without linking
  a device or holding a subscription, answering 2.1.
- **Reviewer notes** describe the BYOK model and, if useful, provide a demo BYOK
  key so the cloud Converse path can also be exercised.

### Licensing: AGPL with an App Store exception, plus CLA/DCO

NorthKeep is AGPL-3.0-only. AGPL and the App Store are compatible here because
Jay is the SOLE copyright holder: the well-known VLC/AGPL takedowns were
third-party rights-holders objecting, which cannot happen when one party owns all
the copyright and chooses to distribute. To remove all doubt and to keep the
option open as contributors arrive:

- Add an explicit App Store distribution exception to LICENSE (the copyright
  holder granting the additional permission needed to distribute through Apple's
  terms).
- Require a CLA or DCO from any future contributor, so the sole-copyright-holder
  basis for the exception is preserved and the exception stays grantable.

The wording of the LICENSE exception and the CLA/DCO text are public-facing legal
text and are owned by the docs/licensing pass, not written here; this ADR records
the decision that they are required before public distribution.

### Privacy label: Data Not Collected

The App Store privacy nutrition label is genuinely "Data Not Collected": there is
no telemetry (invariant #5), the sync server stores ciphertext only (invariant
#2), and crash reports (if ever enabled) are opt-in and content-free. BYOK keys
and the vault never leave the device except the vault ciphertext to the user's
own sync account. The age-rating questionnaire must disclose user-generated AI
chat.

## Alternatives considered

- **In-app purchase for the subscription.** Rejected: it would hand Apple a
  commission on a service that exists and is sold independently on the web, and
  the 3.1.3(b) pattern lets us avoid it cleanly. The external-purchase-link
  entitlement is noted as a possible future option if we ever want to advertise
  the web purchase in-app, but v1 stays silent and simplest.
- **Relicense away from AGPL for the app.** Rejected: AGPL is the project's
  chosen license and the sole-copyright-holder plus App Store exception resolves
  the store-compatibility concern without relicensing.
- **Ship Android first or simultaneously.** Rejected for the launch: one store
  review at a time keeps the process debuggable; iOS leads, Android follows.
- **TestFlight-only / sideload distribution.** Rejected as the goal: public App
  Store presence is part of the launch thesis ("NorthKeep is on your phone as an
  app"). External TestFlight is used as an early policy check before the real
  submission, not as the destination.

## Needs on-device validation / adversarial review before merge

1. Jay's Apple Developer account, an App Store Connect record, and a real EAS
   build submitted through review. Every compliance claim above (3.1.3(b) posture,
   4.2/2.1 mitigations, privacy label, age rating) is only confirmed by an actual
   approval; treat the first submission as the test.
2. An early external-TestFlight review with the demo-vault stub, run weeks before
   the real submission, to surface any policy objection while it is cheap to fix.
3. The LICENSE App Store exception text and the CLA/DCO reviewed and in place
   before the app is public (owned by the docs/licensing pass).
4. Confirmation that the no-IAP entitled-token flow behaves under review: a
   reviewer account that is not entitled should still find the app fully usable
   via the demo vault and on-device chat, with no dead-end purchase wall.
