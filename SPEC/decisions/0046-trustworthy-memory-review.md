# ADR 0046: Trustworthy memory review

Status: Accepted locally by the owner 2026-09-10; first ships in release 0.22.0 (corrected 2026-09-24) · Review: GPT-5.6 Sol pre-implementation, "proceed only with" its requirements; final source review accepted

## Context
The first curation milestone, extending ADRs 0043 and 0015. Review must not write on model confidence, mutate the wrong report, or lose a save to a crash.

## Decision
- D1: Reuse the token-authenticated, unlocked local web session; new routes need the memory-edit gate. No new provider, dependency, credential, sharing change, crypto or schema. Model text and source memories are untrusted and rendered as text.
- D2: Collection selection is validated server-side; project scopes stay excluded. Selections hold immutable snapshots and vault identity; cloud consent fingerprints bind those entries, endpoint and model. Cloud review stays per-run opt-in, never a local fallback.
- D3: Exact-duplicate equality keeps all text except optional CRLF-to-LF; scope and type take part. Semantic packs are bounded, include exact-group representatives, and report skips in coverage.
- D4: Replacements must cite their own target from the selected snapshot; ambiguity yields a question, not a forced replacement. The user may edit and sees the result first; apply makes no model call.
- D5: Version 2 reports carry `report_id`, `vault_id`, snapshots and receipts, stored by hashed vault path. Actions name report id and proposal fingerprint; writes add an `operation_id` and request fingerprint. Report state changes under the vault lock, one job per vault.
- D6: The local report file (mode 0600, never a memory or connector payload) is a write-ahead record: prepared receipt, then vault save, then committed. Interrupted operations reconcile under the lock by full entry identity; mixed states refuse, never discarded or reapplied.
- D7: History shows full before/after text. Restore adds a superseding revision only if the recorded result is still the live head; a removed duplicate returns as a new memory with recovery provenance.
- D8 (since c1954f2, owner request 2026-09-13): a duplicate group has "Remove all": one confirmation listing every member, one receipt per removal, each restorable. `survivor_id` is optional but must name another group member when given. There is still no bulk accept or apply across proposals.

## Consequences
- Limits: local receipts keep plaintext source text after a forget; they are not exported or synced, and the report is not tamper-proof against software on the unlocked machine. A small Ollama probe does not establish general model accuracy, and UI checks are not accessibility certification.

## Rejected
- Checks by quoted substring or counts alone: equal counts can hide changed content.
- Inferring success from matching text; whole-vault restore.

## What leaves the machine
The original has no egress section. It states no new provider, credential or sharing change; existing cloud review stays per-run opt-in, its consent bound to exact entries, endpoint and model. Reports and receipts stay local, never synced, exported or sent to the connector.

## Links
Extends: ADRs 0043, 0015 · Related: ADR 0048 · Acceptance: docs/curation-acceptance.md · Full record: docs/design/adr-0046-trustworthy-memory-review.md
