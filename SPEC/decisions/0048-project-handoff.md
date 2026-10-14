# ADR 0048: revision-bound local project handoffs

Status: Implemented; owner accepted · Review: HOLD, then CLEAR for local implementation under binding amendments (2026-09-10); docs CLEAR, upgrade CLEAR WITH LIMITS (2026-09-11) · Ships first in 0.22.0

## Context
The owner chose Codex to Claude Desktop, both on the local MCP server, as the first pair. This proves correctness against one local vault under its file lock. Whole-vault sync and the hosted connector keep their existing conflict semantics and must not be described as coordinated multi-writer storage.

## Decision
- D1: Local Projects API and MCP `project_resume`, `project_checkpoint`, `project_wrap` return parsed sections, the current entry id as revision, file references and history. Since ADR 0052, resume omits the full document and returns prior text only with `history: true`.
- D2: Every handoff write needs the revision read and a unique operation id. Under the lock: zero heads permits only explicit creation (`expected_revision: null`, or local `project_create`), one head must match, more than one conflicts. Refusals do not mutate. Local `project_update` also requires `expected_revision`. Generic edits make outstanding handoffs stale.
- D3: One core primitive owns receipt lookup, revision check, archives, new head and receipt metadata (`northkeep_project_handoff_v1`) in one SQLite transaction, then one `save()`; failure closes the dirty vault. The receipt binds the operation id to a fingerprint of the validated logical request; exact retries return the original receipt, altered reuse refuses, invalid receipts fail closed. Forgetting a receipt removes the retry guarantee.
- D4: No model runs in checkpoint or wrap. Authored fields refuse headings and stray line breaks (since 0.22.3 local MCP normalizes CRLF and edge breaks first).
- D5: File references are descriptive data (`local_path`, `url`, `memory`; access `reported_available`, `unavailable`, `unverified`). No handler stats, opens, fetches, uploads or follows a locator.
- D6: With `NORTHKEEP_REDACT_TIER=1`, every nested textual output is Tier-1 masked and exact-write tools refuse, sending the user to the local UI.
- D7: History holds at most 20 superseded revisions and 20 log archives; ADR 0051 compaction usually keeps far fewer.
- D8 (2026-09-13): owner can set a title (max 120 characters, local tools only), edit via `POST /api/projects/<slug>/update`, and delete via `DELETE /api/projects/<slug>` (forgets every entry in the scope, not undoable from the app; sync carries the tombstones).

## Consequences
- Receipts say "saved on this device", nothing more.
- Limits: no hosted parity, delivery confirmation or distributed conflict safety. Upgrading from 0.21.0 needs a manual full shutdown of NorthKeep and assistant hosts, then a read-only Resume before writes.

## Rejected
- Reusing `Vault.editMemory` for receipts: it copies metadata unchanged.
- Automatic file or URL access.

## What leaves the machine
The original has no egress section. It states no automatic URL fetch, file open, upload or new sharing action, and no new dependency. A successful save may trigger existing opted-in automatic sync, and a scope already marked Shared may leave through that previously approved path; the receipt does not wait for or certify delivery.

## Links
Full record: docs/design/adr-0048-project-handoff.md · Amended by: ADRs 0050, 0051, 0052 · Evidence: docs/projects-acceptance.md, docs/evidence/final-upgrade-review.md
