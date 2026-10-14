# ADR 0047: guided consolidation with portable recovery

Status: Implemented and accepted locally by the owner 2026-09-10; first ships in release 0.22.0 (correction 2026-09-24: the earlier "not released" was stale). Rules version 2026-09-07.1. · Review: pre-implementation (GPT-5.6 Sol) proceed with mandatory amendments; implementation review 2026-09-10 findings fixed, then no remaining material backend findings in scope.

## Context
Users need to merge overlapping memories without losing originals or trusting a model to act. Milestone-1 reports stay unchanged.

## Decision
- D1: Consolidate 2 to 8 full, live source snapshots of the same type in one private, non-project scope. Sharing state and source identity are rechecked immediately before mutation; project, shared, mixed-type and cross-scope inputs refuse.
- D2: A focused instruction (max 2,000 characters) guides local-model suggestions only. No remote model fallback, no tools, no cross-scope writes, no autonomous apply, and no model runs on apply. Inputs are data in a fixed proposal-only prompt. Every suggested member needs grounded evidence or the group drops. Drafts are RAM-only, never a plaintext disk report.
- D3: New token-authenticated, unlocked-only local API routes, separate from review routes. The client sends vault identity, ordered exact source snapshots, exact replacement wording and an operation UUID; the server reloads authoritative rows and recomputes a versioned exact request hash (exact Unicode bytes, not the NFC entry hash). Client hashes never authorize a save.
- D4: One core transaction appends the consolidated head and marks every source superseded by it, inside one `withVault` lock with a single save; any failure rolls back. Never forget: sources stay encrypted history. No vault schema, encryption or key-handling change; a new versioned, reserved, hash-covered metadata convention records lineage.
- D5: Exact retries return the original operation; an altered one with the same UUID refuses.
- D6: Restore is a compensating transaction: append copies of the originals (new IDs, recovery provenance) and supersede the consolidated head. Each restored copy records the complete ordered restore set. Restore refuses if source history was forgotten or changed, or a later edit made it stale.
- D7: Approved C sidebar and A vertical queue; explanation never enters saved text; final confirmation is read-only.

## Consequences
- Easier: merging is reversible; lineage travels with export/import.
- Harder: imported lineage is validated strictly; ambiguity refuses. Read-only history may show an original as unavailable for restoration.
- Limits: local machine compromise and chain-aware tampering are outside guarantees. Old readers were tested to open, list, export and save, not to show branch history. Verification used synthetic vaults only, not packaged desktop/mobile or live hosted sync. Sync remains whole-vault replacement.

## Rejected
- Using forget on sources: loses recoverable history.
- Remote model fallback or automatic apply: model output gets no authority.
- Forking the vault schema: unneeded here.

## What leaves the machine
The original has no egress section. It states suggestions use the local model only, with no remote model fallback and no tools, and that lineage metadata sits on vault entries and travels with export/import.

## Links
Full record: docs/design/adr-0047-guided-consolidation.md
