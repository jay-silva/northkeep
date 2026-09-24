# ADR 0047: guided consolidation with portable recovery

Status: implemented, integrated, and accepted locally by the owner on 2026-09-10; not released. Pre-implementation adversarial review completed before code changes. Owner approved the workflow and C sidebar/A vertical queue/Source memories/Proposed memory composition. Milestones 1 and 2 accepted. Rules version 2026-09-07.1.

**Correction 2026-09-24 (release 0.22.0 doc-vs-code pass):** "not released" is stale. This work is merged on main after v0.21.0 and ships for the first time in release 0.22.0. The owner's local acceptance on 2026-09-10 is recorded in `docs/navigation-acceptance.md:46-48`.

## Decision

Add a distinct guided consolidation workflow without changing milestone-1 reports. Operate on 2-8 full, live source snapshots of the same type in one private, non-project scope. Check current sharing and source identity at both draft and apply. A focused instruction (maximum 2,000 characters) guides local-model suggestions only. No remote model fallback, tools, cross-scope writes or autonomous apply.

Suggestions use bounded source packs and treat memories and instruction text as data within a fixed proposal-only prompt. Return full original evidence, editable wording, explanation outside the editor, and honest partial coverage. Missing or invalid evidence drops a group; contradictory meaning should raise a question or remain separate. A user can exclude sources and revise wording; final preview names the exact source set and result. No model runs on apply.

New token-authenticated/unlocked local API routes are separate from existing review routes. Client sends vault identity, exact source snapshots, exact replacement wording and an operation UUID. This is an explicit user-authored consolidation request, not model authority. The server validates every field and snapshot. A valid request may be manually authored without a model draft; the same selection and confirmation boundaries apply. Suggestion drafts are RAM-only, never a new plaintext disk report.

## Vault operation and recovery

A core transaction appends one consolidated head and marks all source entries superseded by it. Never use forget: source content remains encrypted history. The caller saves once under the existing vault lock. No vault schema, encryption or key-handling change is planned.

Use versioned, hash-covered metadata on the new entry for source IDs/hashes, operation UUID and exact request fingerprint. Dates/confidence/source of the group are explicitly authored, not inherited from an arbitrary source as factual authority. Existing metadata on originals remains untouched. Export/import carries this lineage and operation identity with ordinary memory entries. Exact retries return the original operation instead of creating revisions; an altered request with the same UUID refuses. Snapshot/request fingerprinting must preserve exact text, not normalize away user edits.

Restore is a compensating transaction: append copies of original memories and supersede the consolidated head. Preserve the historical sources and consolidated result. Because the legacy schema has one successor pointer, the result points to the first restored copy, whose immutable metadata records every restored entry ID. Every restored copy links to its original and common consolidated head. This convention must be tested against old readers; it is not a claim that they expose a multi-branch history UI. Restore verifies the result and all original snapshots, private status and existing restoration identity before writes. Refuse if required source history was forgotten or changed. Do not put original content in redundant metadata fields.

Portable history/retry lookup validates metadata shape and links. Do not silently trust arbitrary imported metadata as a valid operation: validate hash, IDs, original/result relationships, source markers and consistent group membership; ambiguity refuses. Metadata on later ordinary edits is copied by the existing edit primitive, so operation lookup must distinguish the original result by recorded result ID, not count copied metadata as new operations.

If persistence fails, close the dirty vault handle. On retry, reopen disk: absent operation means retry from validated sources, persisted operation means return its exact result. HTTP failure after a successful save is recoverable from the vault itself, without a sidecar commit record. Local machine compromise and chain-aware tampering remain outside guarantees.

## UI and scope

Use the approved C sidebar form and A scrollable vertical suggestions list. Source memories and Proposed memory remain separate; explanation never enters saved text. Exact confirmation freezes content and source membership. Change history exposes consolidation and restoration. On narrow screens, hide the suggestion pane behind its back control, retain full evidence and usable navigation. The owner's subsequent navigation approval removes the Legacy chat destination, merges collection browsing into Memories, and collapses Desktop/Cloud under Connect. Preserve stored history and connection/settings access; do not remove data or expose fake Home/Projects screens.

## Verification before release

Before release, test atomic group failure/rollback, full snapshot staleness, share-state changes, nonproject/private/same-type bounds, malformed lineage, duplicate/altered operation retries before and after restart, repeated restoration, changed/forgotten sources, copied metadata from later edits, export/import, old-version open/read/export and isolated sync. Use only disposable vaults. Test model instructions/unsupported sources and preserve exceptions/numeric meaning. Inspect desktop/390px and light/dark contrast. The local milestone was accepted on 2026-09-10; release remains separately authorized.

## Review record

GPT-5.6 Sol reviewed the existing core/session/report/API source read-only before implementation, under RULES 2026-09-07.1. Proceed with these mandatory amendments:

- Look up encrypted operation UUIDs across consolidate and restore before live-source validation; compare server-recomputed, versioned exact request hashes. A retry may encounter already-superseded sources. Validate the full persisted result set, never just the first restored head.
- Preserve source order as explicit request semantics. Hash action, vault identity, full ordered source snapshots and exact output text; unknown client hashes never authorize a save. REST preview binds the same exact payload the caller confirms.
- In one core transaction check every source UPDATE affected one live row, and roll back inserts, supersession and chain head on failure. Preserve original content, type, scope, confidence and validity start on restoration, but create new IDs/recorded timestamps and mark recovery provenance.
- Use reserved namespaced metadata, source/result IDs, full snapshot fingerprints and ordered restored IDs on every restored copy. Prevent reserved-key collision and disambiguate copied metadata on later edits with original result IDs. Bound content, instruction, source count and payload size.
- Recheck current private status immediately before mutation and reject project, shared, mixed-type/cross-scope inputs. No provider override or automatic apply can come from instruction or model output.
- Require every suggested group member to have grounded evidence. All text is rendered as text, the final confirmation is read-only, and existing token/unlocked routes gate new endpoints.

The pre-implementation reviewer identified no reason to fork the vault schema for this bounded design. Implementation evidence follows below, separately from that conditional design review.

The final preflight also requires: client snapshots are only stale-check material, while the server reloads authoritative rows; comparison, transaction and the single save share one `withVault` callback/file lock. Full snapshot fingerprints include mutable fields and preserve exact Unicode bytes rather than using the NFC-normalizing entry hash as an equality check. Source order is request semantics. Restore checks originals against their expected post-consolidation supersession, not their pre-save live form. Every restored copy records the complete ordered restore set, so no branch is inferred solely from the first pointer. A forgotten/partial marker set refuses replay. Later ordinary edits make restoration stale; do not chase descendants. This is a new versioned metadata convention, despite unchanged SQLite/vault format versions. These amendments bind implementation and final tests.

## Implementation verification, 2026-09-10

A fresh GPT-5.6 Sol adversarial reviewer identified imported-result semantics and restore-membership weaknesses. These were fixed with shared persisted-operation validation, exact request recomputation, full source/copy checks and distinct ordered source IDs. Chain-valid malformed-import regression cases now cover these boundaries. The reviewer subsequently reported no remaining material backend findings in this assigned scope.

Read-only history permits a legitimately forgotten original or an edited restored copy to remain visible as unavailable for restoration. Write/retry validation stays strict. A two-operation regression checks that an unavailable receipt does not hide an unrelated restorable one; the reviewer separately checked this display-only exception.

Verification used only isolated synthetic vaults: 1,525 full-suite tests passed with one existing skip; the final scoped light-contrast change passed all 21 UI checks. Eight real HTTP tests cover both curation milestones. Core, librarian, web and CLI TypeScript builds passed. A real installed qwen2.5:14b call made zero vault writes; its invalid singleton was rejected and coverage remained incomplete. The observed synthetic response is mirrored in the librarian regression test.

The v0.21.0 core created a vault that the new version consolidated; the old core then opened, listed, exported and saved it. New exact retry, restoration, old-reader restored-head editing, and new restoration retry passed. Full JSON export/rebuild and complete encrypted-file replication are separately tested. These are not packaged desktop/mobile or live hosted-sync certification. Sync remains whole-vault replacement, not entry merging.

The independent visual reviewer scored the approved sidebar/vertical-queue blend faithful and the three requested mobile, history-reassurance and keyboard fixes resolved. Dark desktop and 390px states were exercised through the browser, including save, restore and Escape/focus return. A scoped light contrast correction was implemented. This paragraph records the evidence available before the later acceptance pass; the owner accepted the completed local functionality and visual revision on 2026-09-10. Release remains separate.
