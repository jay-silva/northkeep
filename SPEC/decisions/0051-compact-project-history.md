# ADR 0051: Compact project history; the sync cap stays at 4 MB

Status: Accepted by Jay 2026-09-21 ("Do option 1 and raise the cap to 8 MB", then "make it automatic"). Compaction shipped; the cap raise proved impossible on the current transport (D4). Amended by ADR 0052, corrected 2026-09-24 for 0.22.0, retry gaps fixed in 0.22.2 by ADR 0062. No adversarial review required (retention plus a server cap); the 0.22.0 fixes were reviewed.

## Context
On 2026-09-21 Jay's vault hit 4.37 MB against the 4 MB sync cap and sync stopped. Superseded project documents held 2.7 MB; live memories 0.58 MB. Every `project_update` keeps the prior document (ADR 0039).

## Decision
- D1: `compactProjectHistory` considers only superseded, unforgotten `working` rows in slug-valid `project:*` scopes. It keeps the newest 5 by `created_at`, plus any revision named (`base_revision` or `result_id`) by a handoff receipt on a row that survives this pass. Receipts on rows beyond the newest five protect nothing. The rest are blanked like `forget`: `content = ''`, `forgotten_at` stamped, row kept, then `VACUUM`. Bound: newest five plus at most two more.
- D2: Compaction is automatic. Every supersede of a project `working` row (project tools, `memory_edit`, hosted fold) compacts that project with keep 5. Manual: `northkeep projects compact [--project <slug>] [--keep <n>]` (dry run unless `--yes`) and `POST /api/projects/compact`.
- D3 (ADR 0052 addendum): a blanked revision keeps only its `northkeep_provenance_v1` writer block; all other metadata, receipts included, is removed. `verifyChain` requires a forgotten row's `metadata` to be null or exactly that one well-formed block.
- D4: `MAX_BLOB_BYTES` stays 4 MB. Vercel refuses bodies over 4.5 MB (`FUNCTION_PAYLOAD_TOO_LARGE`) before our handler, so 8 MB would be false. A bigger ceiling needs a new transport with its own ADR and adversarial review.

## Consequences
- Easier: bounded history; Log archives and live documents untouched.
- Harder: project revision text older than the newest five is gone, automatically. The automatic path does not verify the chain on each write (the manual command checks before and after).
- Limits: after blanking, a writer block is structurally checked, not hash-verified; swapping one well-formed host or session id for another on a blanked row is undetectable. A verbatim retry of a blanked save is refused as `stale_project`, never applied twice. Since ADR 0062 (0.22.2), the newest 16 checkpoint or wrap operation ids per project live on the live document, so a resend with the same id is recognised; saves made, or resends handled, by older versions are not covered (ADR 0062 Residuals).

## Rejected
- A size-threshold trigger: unpredictable, lets history pile up.
- Keeping every receipt-named revision: protection chained through all history.

## What leaves the machine
The original states it does not touch the connector, redaction, crypto, key handling, the row envelope or what leaves the machine; it is a retention change inside the vault plus a server cap.

## Links
Extends: ADR 0039, ADR 0045, ADR 0048 · Amended by: ADR 0052, ADR 0062 · Related: ADR 0009

Full record: docs/design/adr-0051-compact-project-history.md
