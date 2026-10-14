# ADR 0015: Editing a memory's scope (by supersession, not mutation)

Status: Accepted 2026-07-13 · Deciders: Jay, Claude Code · No review verdict recorded

## Context
The vault could only `remember` (append) and `forget` (tombstone). A memory filed in the wrong scope had to be forgotten and re-added, losing provenance. Jay asked to be able to edit a memory's scope (e.g. personal to work). But `scope` is part of each entry's BLAKE2b `entry_hash`, and every `prev_hash` links to the previous hash, so an in-place `UPDATE` would break `verifyChain` for that row and every later one: exactly the silent edit the chain exists to catch.

## Decision
- D1: Re-scoping appends a new entry and marks the original superseded (`Vault.rescope(idOrPrefix, newScope, allowedScopes?)`). It resolves a live, non-superseded entry by id or unambiguous prefix (same guards as `forget`, plus `superseded_at IS NULL`).
- D2: The new entry copies `content`, `type`, `source`, `source_model`, `confidence`, `valid_from`, `metadata`; gets a new `id`, `created_at`, the new `scope`, `prev_hash = chain_head` and a fresh `entry_hash`. The original gets `superseded_at` and `superseded_by`. Both writes run in one better-sqlite3 transaction.
- D3: This keeps the chain intact because `superseded_at` / `superseded_by` are excluded from the hash (like `forgotten_at`). These M0 columns had no writer until now.
- D4: `list()` hides superseded entries by default; `ListFilter.includeSuperseded` opts in. `export()` opts in, so full history and forward links stay in the canonical export.
- D5: `rescope` honours the same scope allowlist as `forget`/`list`, and a scoped connection cannot move a memory into a scope outside its grant. GUI and CLI run as the vault owner (unrestricted); the guard matters if a scoped MCP surface ever exposes editing.
- D6: Surfaces: core `Vault.rescope()`; CLI `northkeep rescope <id> <scope>`; `POST /api/memories/rescope` `{ id, scope }` (scope charset validated as for add/import); a GUI "Move scope" button with an inline picker.

## Consequences
- Easier: scope edits are first-class and provenance-preserving; `verifyChain().ok === true` after a rescope, including after reopen (tested). The same append-new-mark-old primitive can later back content or confidence edits; only scope is editable today.
- Harder: a re-scoped memory gets a new id. Anything that pinned the old id sees it as superseded (still present via `includeSuperseded` and export). The CLI states this; the GUI does not show ids.
- Invariants: #4 upheld (export keeps superseded entries and links); #3 unchanged (same `computeEntryHash`, no key handling); #1, #2, #5 untouched.

## Rejected
- In-place `UPDATE ... SET scope`: breaks the hash chain from that row to the head.
- Tail-rehash keeping the same id (the `migrate()` 0.1 to 0.2 mechanism): rewrites history, so a legitimate edit becomes indistinguishable from tampering.
- Forget and re-add: loses provenance and is clumsy.

## What leaves the machine
The original has no egress section; it states invariants #1, #2 and #5 are untouched.

## Links
Full record: docs/design/adr-0015-edit-memory-scope.md
