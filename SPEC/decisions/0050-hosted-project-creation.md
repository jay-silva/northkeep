# ADR 0050: A connected app can create a project

Status: Accepted 2026-09-19; merged (eabb35c), first ships in 0.22.0; acceptance run and connector deploy not recorded in the repo · Review: four NOT CLEARED, then CLEARED WITH WOUNDS before and after implementation

## Context
The hosted connector refused project creation (ADR 0040 Decision 5); Jay asked for it 2026-09-19. Unmarked, the scope never pushes and copies fork; this changes who decides a scope is shared.

## Decision
- D1: A dedicated `project_create` tool on both servers (local adds `title`, `draft`). Hosted `project_update` stays fail-closed on an unknown slug.
- D2: Hosted create writes one pending `working` row in the existing DEK envelope, with an id derived from the scope, so concurrent creates collapse into one. `memory_remember` needs at least one non-pending row in the scope.
- D3: Fail-closed checks, in order: slug; unshare tombstone (unconditional, ignoring `CONNECTOR_TOMBSTONE_ENFORCE`); no working row in `storage.listEntries`; `MAX_SHARED_ENTRIES`; 16384-character size. `/client/pending` reads pending rows then tombstones, sequentially, and purges pending rows in tombstoned scopes. Tombstoned scopes are hidden from and unwritable by the app; every accepted push can clear a tombstone on re-share.
- D4: The fold marks an unshared project scope Shared, without a dialog, only if it has no live local entries and the group holds exactly one `working` document; every row in that group (normally ADR 0045 archives; a review found a `semantic` row is applied too) is applied, then mark, save, ack. Every other row for an unshared project scope is held, unapplied, until the user shares it, which lets the app's document supersede the local one. This is Jay's named invariant #1 exception.
- D5: CLI `share sync`, desktop `POST /api/share/sync` and mobile `runConnectorSyncNow` fold from an empty shared list only on a device with `paired_at` (cleared on server change). With nothing shared the desktop and mobile buttons are disabled, so only `northkeep share sync` reaches that fold.
- D6: The contract says to create a project only when the user asks.

## Consequences
- Residual: pre-ADR clients fold a create unmarked, so later rows stay held. Multi-device lag (below). Flag off, a stale device can reopen an unshared scope. A sub-second re-share race can deliver a deleted row. An app can pre-create slugs. Local delete is not unshare. Replaced documents survive in history only five more revisions (ADR 0051).
- Amended by ADR 0063: hosted `project_update` requires `expected_revision`, and the fold applies a create only from a row whose base is `new`.

## Rejected
- `source` provenance as consent: forgeable and inherited through edits.

## What leaves the machine
The original has no egress section. After the no-dialog mark, the app's rows and everything later written into the scope are pushed, as for any shared scope; under multi-device lag that can include another device's private memories. Reviews report no attack moved private local content off the machine or undid a revoke with enforcement on.

## Links
Amends: ADRs 0038, 0040, 0042 · Amended by: ADRs 0063, 0065 · Full record: docs/design/adr-0050-hosted-project-creation.md
