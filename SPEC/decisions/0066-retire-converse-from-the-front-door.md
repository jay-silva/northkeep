# ADR 0066: Retire Converse from the front door, keep its code this quarter

Status: Proposed (awaiting Jay), 2026-10-15 · Review: not yet run. The README edits in the same branch are a published claim and need the review gate before merge.

## Context
Converse is NorthKeep's own chat: it masks a message before it leaves and restores details in the reply (ADR 0007, tools in ADRs 0027 to 0037). The site marked it legacy on 2026-09-28 in site commit f486f30, with no ADR. The README still sold it as "Mode 2: the firewall", the CLI home screen lists `converse` first and starts it when you press Enter, and `northkeep connect` ends by pointing at it. Agents read the README, not the site, so they keep extending it. The site's reason is a judgment, not a usage count: NorthKeep has no telemetry.

The code cannot simply go. `packages/converse/src/turn.ts` holds the order "redact, then call the provider" for every chat turn, tested in `packages/converse/test/`. `apps/web` (`src/api.ts`, `src/converse.ts`) and six files in `apps/mobile/src/lib/` import the package, and the iPhone app ships Converse screens (`apps/mobile/app/converse.tsx`, `converse-audit.tsx`).

## Decision
- D1: Converse stops being presented as a product mode. The README describes Connect, Projects and memory; Converse moves to a short "Legacy: Converse" section that links here. The site already says this (f486f30).
- D2: The CLI front door follows once Jay accepts this ADR: the `northkeep` home screen stops listing `converse` first and stops starting it on Enter, and `northkeep connect` stops recommending it. `northkeep converse` itself keeps working. Not built in this branch.
- D3: The code stays this quarter: `packages/converse`, its tests, its imports in `apps/web` and `apps/mobile`, and the redaction ordering in `turn.ts`. Removing it is its own later ADR.
- D4: Hiding the iPhone Converse screens is proposed for a later milestone, mock first, built only after Jay approves the mock. Nothing changes on the phone now.
- D5: After Jay accepts, ADRs 0027 to 0037 each get one line: "Superseded in part by 0066 (proposed)", updated to "(accepted)" with the date. Until then they are not edited.

## Consequences
- Easier: one product story across site, README and agent docs. Agents stop treating Converse as a place to add features.
- Harder: Converse users find less about it up front; the README's legacy section and KNOWN-LIMITS still cover it.
- Committed to: keeping Converse's privacy behaviour and its KNOWN-LIMITS sections true while the code ships.

## Rejected
- Deleting `packages/converse` now: the web API and the phone import it, and the redaction ordering would have to move first.
- Hiding the phone screens tonight: a mobile change with no mock and no device test.

## What leaves the machine
Nothing new. No egress path, recipient, redaction tier or grant changes; only what the README, and later the CLI and phone, show.

## Links
Site commit: f486f30 · Extends: ADR 0007 · Affects: ADRs 0027 to 0037 (after acceptance) · Reviews: app-review-2026-10 (founder, project manager, senior engineer)
