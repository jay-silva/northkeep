# ADR 0026: Mobile App Store distribution and licensing

Status: Accepted (shipped; TestFlight builds since), dated 2026-07-16; status corrected 2026-07-25 from a stale "Proposed" · Review: none recorded. The original also says nothing here is confirmed until an actual EAS build clears App Store review, and the licensing and privacy decisions take effect only when the app is published; it does not record that approval.

## Context
Track M ships to the iOS App Store first, Android roughly two to three weeks behind. NorthKeep is BYOK, AGPL-licensed, and sells its subscription on the web; each intersects an App Store rule, so the review posture is decided deliberately.

## Decision
- D1: Build and submit with Expo SDK 55+ (New Architecture), expo-router, and EAS Build / EAS Submit (config in apps/mobile/app.config.ts). Platform choice itself is ADR 0023's.
- D2: No in-app purchase and no in-app steering. The $10/month sync subscription is bought on northkeep.ai; the app works when the device-secret-derived sync token is entitled. This relies on guideline 3.1.3(b), provided the app never links to or advertises the external purchase.
- D3: BYOK review-risk mitigations for guidelines 4.2 and 2.1: on-device chat with no key (ADR 0025), a seeded throwaway demo vault ("Try NorthKeep"), and reviewer notes describing BYOK, optionally with a demo key.
- D4: Licensing: AGPL-3.0-only, relying on Jay being the sole copyright holder. Add an explicit App Store distribution exception to LICENSE and require a CLA or DCO from future contributors. The exact text is owned by the docs/licensing pass and is required before public distribution.
- D5: Privacy label "Data Not Collected": no telemetry (invariant #5), sync server stores ciphertext only (invariant #2), crash reports if ever enabled are opt-in and content-free. The age-rating questionnaire must disclose user-generated AI chat.

## Consequences
- Easier: no Apple commission on the subscription; a reviewer without a key or subscription still finds a working app.
- Harder: the app must stay silent about where to buy.
- Limits, needing validation before these claims count as confirmed: a real EAS build through review (3.1.3(b) posture, 4.2/2.1 mitigations, privacy label, age rating); an early external-TestFlight review with the demo vault; the LICENSE exception and CLA/DCO in place before the app is public; a non-entitled reviewer account meeting no dead-end purchase wall.

## Rejected
- In-app purchase: commission on a service sold independently; the external-purchase-link entitlement is a possible future option.
- Relicensing away from AGPL: the sole-holder exception resolves store compatibility.
- Android first or simultaneously: one store review at a time.
- TestFlight-only or sideload as the goal: public App Store presence is part of the launch thesis.

## What leaves the machine
The original has no egress section. Its privacy-label section states: "BYOK keys and the vault never leave the device except the vault ciphertext to the user's own sync account." It does not address the cloud Converse path (ADR 0025).

## Links
Full record: docs/design/adr-0026-mobile-appstore-distribution.md · Related: ADRs 0023, 0025
