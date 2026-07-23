# NorthKeep iOS: App Store submission-readiness checklist

> Ties together the submission artifacts. Three columns: what is done in the repo,
> what Jay sets in App Store Connect, and what still blocks a public release.
> Covers milestone M6-5 of `07-MOBILE-LAUNCH-PLAN.md`. Not legal advice.

App: NorthKeep · Bundle ID: `com.silvapeak.northkeep` · Version 0.1.0 (build 3)
Owner: Silva Peak Labs, LLC (d/b/a NorthKeep) · Expo/EAS owner `j_silva`

## 1. Done in the repo (this branch)

- **AGPL App Store additional permission** drafted: `LICENSE-APPSTORE-EXCEPTION`,
  with pointers added to `README.md` and a header note atop `LICENSE` (the
  verbatim AGPL body is unchanged). Marked DRAFT, pending counsel confirmation.
- **Reviewer notes**: `docs/appstore-review-notes.md` (what the app is, "Try a
  demo" path, full create-vault + Converse path, the 1 to 2 minute key-derivation
  wait, BYOK explanation, no-account / no-IAP statements, permission rationale).
- **Privacy nutrition label answers**: `docs/appstore-privacy-label.md`.
- **Age rating answers**: `docs/appstore-age-rating.md`.
- **In app.config.ts already (not changed here)**: `ITSAppUsesNonExemptEncryption
  = false` (open-source exemption), camera + Face ID usage strings, icon/splash
  from brand assets, portrait, tablet off, build number 3.
- Existing legal docs: `legal/PRIVACY.md`, `legal/TERMS.md`, `KNOWN-LIMITS.md`.

## 2. Jay sets in App Store Connect (portal, not repo)

- **App Privacy** answers per `docs/appstore-privacy-label.md` (disclose the
  encrypted sync blob as User Content + hashed User ID; everything else Not
  Collected; no tracking).
- **Age rating** answers per `docs/appstore-age-rating.md` (all content
  descriptors None; Unrestricted Web Access No; UGC/social/messaging No; AI chat
  disclosed Yes; let Apple compute the band).
- **App Review Information → Notes**: paste from `docs/appstore-review-notes.md`.
  Decide the demo Converse key (see blockers) and, if used, paste it here ONLY.
- **Privacy Policy URL** and, if required, a support/marketing URL (northkeep.ai).
  Confirm the hosted policy matches `legal/PRIVACY.md`.
- **Export compliance**: the "uses non-exempt encryption" answer is already false
  in the binary; confirm the App Store Connect prompt matches (no per-submission
  doc needed under the open-source exemption).
- **Screenshots + metadata**: required device screenshots, description, keywords,
  category, age-rating display, support contact. (Not produced here.)
- **App icon (marketing 1024)**: from brand assets; RGB, no alpha.

## 3. Still blocking a public release

- **External TestFlight Beta App Review.** Distributing to external testers needs
  Apple's Beta App Review first. This is Apple's clock, plan for it before the
  public link in the launch plan's M6-5 acceptance test.
- **On-device model absent → Tier-1-only disclosed.** There is no on-device
  Tier-2 (NER) redaction on the phone yet (M6-4); Converse runs BYOK cloud with
  Tier-1 masking only, and the app says so with a persistent banner. This is
  disclosed, not hidden, in the reviewer notes and KNOWN-LIMITS, but it is a known
  limitation to keep stated honestly.
- **AGPL exception needs counsel sign-off.** `LICENSE-APPSTORE-EXCEPTION` is a
  draft; Silva Peak Labs, LLC + counsel confirm wording and authority before the
  public submission relies on it.
- **Export-compliance basis needs counsel confirm for public release.** The
  app.config.ts comment already says to confirm the open-source exemption (EAR
  742.15(b) one-time BIS + NSA notification) with export counsel before the
  PUBLIC App Store release. Fine as-is for TestFlight.
- **Crypto invariant-#3 adversarial review pending.** Mobile crypto uses audited
  @noble (byte-identical to desktop libsodium), which owes an invariant-#3
  adversarial-review session before the public-launch merge to main
  (`KNOWN-LIMITS.md`).
- **Demo Converse key decision (Jay).** Read the flag in the reviewer notes:
  either provision a low-cap throwaway BYOK key for the reviewer (in ASC notes
  only, revoke after) or describe Converse without a live reply. Recommended:
  provision the capped key so the reviewer sees the AI chat work.

## 4. Not a blocker (worth noting for the reviewer)

- **No in-app purchase in this build**, so App Store Guideline 3.1.1 (in-app
  purchase for digital services) is not triggered. The $10/mo hosted sync
  subscription is arranged off-app (desktop/web, Stripe-hosted). The app only
  configures a sync server URL; it sells nothing. State this in the review notes.
- **No account/login for local use.** Nothing to test-credential for the basic app.
- **Converse output is private and on-device**, not shared to other users, so it
  is not social user-generated content (helps with Guideline 1.2 questions).
