# ADR 0046: Trustworthy memory review

Status: implemented, verified, and accepted locally by the owner on 2026-09-10; release pending. Screen designs approved by the owner. Extends 0043 and 0015. This is the first curation milestone; local project coordination is implemented separately in ADR 0048.

## Boundaries

Reuse the token-authenticated, unlocked local web session. New review collection/history/action routes require the same gate as existing memory edits. No new provider, dependency, credentials, sharing change, crypto primitive or database schema is planned. Review-model text and source memories remain untrusted data and are rendered as text.

## Review input and quality

Explicit collection selection is validated on the server against actual scopes; project scopes remain excluded. A selection contains full immutable entry snapshots and a vault identity. API consent fingerprints bind those entries and the exact destination configuration, so equal counts cannot disguise changed content. Existing cloud review remains per-run opt-in and never a local fallback.

Deterministic duplicate equality preserves punctuation, symbols, case and internal whitespace; at most line-ending canonicalization is permitted. Scope and memory type participate in grouping. Semantic packs include a representative of exact groups so repeated old facts remain comparable to newer facts. Pack sizes are bounded; a single oversized entry is skipped and counted. Embedding failures, invalid output and skipped entries appear in coverage. Model confidence is not permission to write.

Replacement proposals must cite their own target, and all referenced entries must belong to the selected snapshot. Ambiguous disagreements can produce a question without a forced replacement. The user may edit a replacement or answer in their own words; it is shown before being applied. No new call to a model occurs during apply.

## Report identity and actions

Version 2 reports carry a UUID report_id, vault_id, selected snapshots, scope selection, coverage and operation receipts. Store them by vault path (hashed local filename); never serve a report associated with another vault. Old reports remain inspectable but cannot use new mutation paths without a fresh pass. Starting a new review cannot let an old UI mutate the new report: every action names its report_id and proposal fingerprint. Scope/type/content/revision checks use full snapshots, not a quoted substring alone.

Load/check/update report state while holding the same vault lock used by UI mutations. Permit one active review job per vault in the local process; completion rechecks its job ownership. Concurrent read-only/model jobs never hold a vault handle. Applying a write uses an operation_id and exact request fingerprint; retries with altered parameters fail.

## Recoverable saves

Use the existing local private report file as a write-ahead operation record. It already contains source and proposal text; it remains local, mode 0600, never a vault memory or a connector payload. Create the intended in-memory mutation, record a prepared receipt containing affected before/after IDs and snapshots to disk BEFORE saving the encrypted vault, then save the vault, then mark the receipt committed. An interrupted prepared operation is reconciled under the vault lock: exact after-revisions present means commit the receipt; original revisions still intact and no new after-revisions means no save occurred. Retain that receipt as aborted and restore the previous proposal decision. An exact retry can prepare it again, while a browser that lost its retry ID can start a new action without being stranded. Any mixed/diverged state refuses and requires inspection; it is never silently discarded. Never reapply a saved mutation to repair a report file. Atomic report writes use unique temporary paths and fsync. Failures remain visible.

After/retry reconciliation uses full entry identity and content, including type, scope and lineage. Receipts are local workflow state and are not portable history; original memory versions remain in the vault export. A new review cannot discard a prepared operation: reconcile first or refuse. Never infer success solely from matching text.

## History and restoration

Expose retained local changes across review runs with complete before/after text. Restore an accepted edit with a new superseding revision only if its recorded result is still the live head. Do not restore an entire vault or alter historical rows. For an explicitly removed duplicate, a restore creates a new memory from the retained before-snapshot, with recovery provenance; the forgotten row remains forgotten. Refuse after a later incompatible change. Restoration itself is an idempotent prepared/committed operation and keeps history. At least one duplicate member must remain live; the UI names the retained member and explicitly confirms the one removed member. No bulk write action.

## Validation

Use only isolated synthetic vaults/configuration. Test semantic-sign collisions, unrelated-target citations, snapshot staleness, vault/report mismatch, concurrent actions, changed retries, interrupted saves before and after vault persistence, recovery after restart, duplicate survivor enforcement, selection enforcement, changed consent with equal counts, and restoration after later edits. Run a synthetic real local-model pass; separately state model-quality limits. Desktop and 390px UI verification follows the approved mocks. No production data or paid provider calls are required.

## Pre-implementation review

GPT-5.6 Sol reviewed the existing review, API and vault implementations against this delta before implementation. Verdict: proceed only with the following requirements incorporated. These are design conditions, not claims that the implementation already enforces them.

- Equality and semantic packs respect scope and type; preserve all text except optional CRLF-to-LF conversion. Include exact-group representatives in semantic comparison. Report oversized/skipped entries and invalid batches.
- Replacement targets must be explicitly quoted and listed in the selected sources. Add question proposals rather than forcing a resolution. Edited content is nonempty and length-bounded, included verbatim in the operation fingerprint.
- Explicit scope selection and provider consent bind full immutable entry snapshots, vault identity, endpoint configuration and model.
- All report reads and mutations, including keep/reject/report serving/job completion/recovery, run under the vault lock. Completed jobs verify ownership. Mutations require full proposal ID, report UUID, proposal fingerprint and operation UUID. Old prefix mutation paths cannot bypass those checks.
- Duplicate removal names and checks a surviving live member. Restoration and apply both use prepared/committed receipts; original and resulting revision identities are verified. Fsync unique temporary reports and their containing directory. New runs cannot replace an unreconciled prepared operation.
- Version 2 report parsing validates all persisted fields before use. Source text never supplies an action. Show complete before/after content for restoration and removal; do not claim the local report is tamper-proof against software with access to the unlocked machine.
- A narrow `getVaultId()` accessor reads existing encrypted vault metadata without exporting content. Proposal fingerprints include target identity and all sources; operation fingerprints additionally include the exact user-edited text and removal/restore parameters.

Review author inspected code read-only, with no vault or service access.

## Implementation verification

The lead reviewed and integrated bounded GPT-5.6 Sol work in an isolated worktree without production environment files. Final independent source review accepted the implementation after correcting consent scope display and rejecting duplicate collection selections. Earlier review findings hardened bounded packing, target evidence, report parsing, recovery, and dialog behavior.

- TypeScript builds passed for core, librarian, local web and CLI.
- Full regression: 114 files passed, 1,484 tests passed, one skipped. Separate real HTTP/session curation suite: five tests passed. Temporary loopback servers required sandbox permission; the restricted run was not counted as passing.
- Crash tests inject a report-write failure after vault persistence for apply and restore, reopen, and verify reconciliation without duplicate revisions. Unsaved prepared receipts abort recoverably. Nonwrite decisions are idempotent and unresolved does not permanently suppress a proposal.
- Parent rendered desktop and 390px layouts and exercised exact wording save, before/after history, restoration, collection counts, search and narrow layout. Final narrow confirmation check verified Escape and focus return. Independent UI review was source-only, not a second rendered inspection. The style detector lacked optional parsers and is not comprehensive accessibility certification.
- A real local Ollama synthetic probe selected seven entries, fully compared five and marked two incomplete. It found the planted exact duplicate and schedule contradiction, preserved the decimal distinction, and dropped an unsupported-target finding. Review changed neither the synthetic memories nor their vault file. This small probe does not establish general model accuracy.

All new review routes require the existing session token and unlocked vault. No cloud provider call, production vault write, deployment, new dependency, or crypto change was performed. Legacy reports have a read-only library parser; the new UI requires a fresh version-2 review rather than automatically importing them. Plaintext local receipts retain source text after forgetting and are not exported or synced. Owner acceptance instructions are in `docs/curation-acceptance.md`.
