# ADR 0063: Sync guardrails: cloud project writes fast-forward only, destructive syncs preview first

Status: Proposed · Review: first review NOT CLEARED 2026-09-30, revised; recheck pending (docs/design/sync-guardrails.md)

## Context
On 2026-09-30 one Sync now rolled five projects back 7 to 9 days. Down-sync writes every pending cloud document over the local head (`connector-client.ts:366-374`). The connector serves pending rows ahead of newer pushes (`mcp.ts:104-118`) and accepts an older push over a newer one. A diverged pull replaces the vault silently. A cloud write never records its base.

## Decision
- D1: Down-sync applies a cloud document only as a fast-forward: its `base_revision` must equal the local head. Anything else, and every legacy row with no recorded base, is held for the user (view both, take theirs, keep mine). No base is ever inferred.
- D2: The connector orders rows by a per-scope write counter, never time. Every write gets a new revision; the `expected_revision` check is one atomic SQL statement.
- D3: Sync now previews and confirms any replace or forget.
- D4: "Restore this version" writes an old revision back as a new head.
- D5: Automatic push runs only from a device in sync with vault sync; otherwise it pauses and says why. The connector refuses a push from an older vault version.
- D6: Every pull reports what would drop, including deletes it would undo. The automatic pull refuses a non-empty report; the manual one asks, then installs exactly the reported server version.
- Founder, 2026-09-30: hosted `project_update` requires `expected_revision`; keep mine saves the cloud text as a memory first; automatic push on by default with a switch; the phone applies only additions until it has a preview screen; the three new screens get approved mocks before build.

## Consequences
- Easier: a cloud write, old or new, can no longer roll a project back silently. Recovery takes one click.
- Harder: users resolve conflicts, including every legacy pending row. Cloud bots without `expected_revision` are refused. Old clients stop receiving cloud project updates and cannot push once a new client has.
- Committed to: `base_revision` and counter columns, a `?v=2` protocol, tombstone enforcement for automatic push, connector before clients, tests on real Postgres.

## Rejected
- Newest timestamp wins: the two stores stamp `created_at` differently.
- Backfilling legacy bases from timestamps: a review reproduced it causing a silent rollback.
- Server-side conflict detection only: the connector cannot see unpushed local saves.
- Automatic merge: guesswork on the path that just lost data.

## What leaves the machine
Content does not change: shared scopes, same connector. D5 changes when it leaves, seconds after a vault push. The connector also sees edit cadence, a base id per cloud write, the vault sync version and a sync-server hash.

## Links
Design: docs/design/sync-guardrails.md · Review: NorthKeep/Reviews/adr-0063 · Extends: ADR 0044, ADR 0050, ADR 0051
