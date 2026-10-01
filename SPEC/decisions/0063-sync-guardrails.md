# ADR 0063: Sync guardrails: cloud project writes fast-forward only, destructive syncs preview first

Status: Accepted 2026-09-30 · Review: design CLEARED on recheck; build reviews in the design's Build notes

## Context
On 2026-09-30 one Sync now rolled five projects back 7 to 9 days. Down-sync wrote every pending cloud document over the local head. The connector served pending rows ahead of newer pushes and accepted older pushes. A diverged pull replaced the vault silently. Cloud writes recorded no base.

## Decision
- D1: Down-sync applies a cloud document only as a fast-forward: its `base_revision` must equal the local head. Anything else, including legacy rows with no base, waits for the user (view both, take theirs, keep mine); no base is inferred.
- D2: The connector orders rows by a per-scope write counter, never time. Every write gets a new revision; the `expected_revision` check is atomic.
- D3: Sync now previews and confirms any replace or forget.
- D4: "Restore this version" writes an old revision back as a new head.
- D5: Automatic push runs from an in-sync device with vault sync, or on save without it, whenever Cloud Connect's copy differs; otherwise it pauses and says why. The connector refuses pushes from older vault versions.
- D6: Every pull reports what would drop, including deletes it would undo. The automatic pull refuses a non-empty report; the manual one asks, then installs exactly the reported version.
- Founder, 2026-09-30: hosted `project_update` requires `expected_revision`; keep mine saves the cloud text as a memory; automatic push defaults on, with a switch; the phone applies only additions until it has a preview screen; new screens follow approved mocks.

## Consequences
- Easier: no cloud write can roll a project back silently. Restore works from the app, CLI and API.
- Harder: users resolve conflicts, including legacy rows. Cloud bots without `expected_revision` are refused. Old clients get no cloud project updates and cannot push once a newer device with vault sync has.
- Committed to: `base_revision` and counter columns, a `?v=2` protocol, tombstone enforcement for automatic push, connector before clients, tests on real Postgres.

## Rejected
- Newest timestamp wins: the stores stamp `created_at` differently.
- Backfilling bases from timestamps: a review reproduced a silent rollback.
- Server-only conflict detection: the connector cannot see unpushed saves.
- Automatic merge: guesswork where data was just lost.

## What leaves the machine
Content and recipient are unchanged; D5 sends it seconds after a vault push or pull. The connector learns when devices wake or pull and when any vault push happens (a manifest read follows even pushes that touched only private scopes), plus a base id per cloud write, the vault sync version and a sync-server hash. The Mac app reads the connector's pending list once per session when the Projects page opens, only when this Mac shares something or has paired. These reads send no content.

## Links
Design: docs/design/sync-guardrails.md · Review: NorthKeep/Reviews/adr-0063 · Extends: ADRs 0044, 0050, 0051
