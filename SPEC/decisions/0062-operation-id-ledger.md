# ADR 0062: Remember operation ids past compaction (an operation ledger on the live project document)

Status: Accepted 2026-09-28, built, first released in 0.22.2 · Review: design CLEARED WITH WOUNDS, recheck CLEARED; code CLEARED WITH WOUNDS, recheck CLEARED · One of 36 separate-vault perf runs breached the 2 ms gate (2.94 ms, load about 31); Jay accepted it without a re-measure

## Context
ADR 0048 binds an operation id to a checkpoint or wrap via the receipt on its revision. ADR 0051 compaction blanks that revision, so the vault forgets the id, and a resend at the current head was written again: duplicate Log line, older Status and Next Actions back (F1).

## Decision
- D1: Reserve `northkeep_operations_v1` on live project heads: an array of `{ operation_id, request_fingerprint, saved_at }`, validated strictly. The fingerprint covers `vault_id`, project, mode and `expected_revision`.
- D2: Only checkpoint and wrap saves append, keeping the last 16 by count. Updates and generic edits carry it forward; blanking strips it; `verifyChain` is unchanged. Tampering is detected afterwards by `list`, export or compaction, not at the decision.
- D3: `checkpointProject` scans live `working` heads within `allowedScopes`, checking in order: original receipt, malformed record carrying the id, ledger hit, copied receipt (D5), else write.
- D4: Ledger hit on the same project with the same fingerprint: `stale_project` with the current document. Different fingerprint or another project: `operation_conflict`. Malformed record carrying the id: `operation_conflict` "Malformed project operation record." Other malformed records are ignored and dropped on the next save.
- D5: For old-code saves, copied receipts prove the save only if every copy and its forgotten original sit in the request's scope; fingerprints then decide as in D4. Otherwise today's refusal stands.

## Consequences
- Easier: a resend of one of a project's newest 16 checkpoint or wrap ids is refused and writes nothing, when it reaches 0.22.2 or later and the connection can see the project.
- Residuals: (1) saves made by, or resends handled by, 0.22.1 or earlier are not checked, including a second un-updated Mac; (2) ids older than the newest 16 are forgotten; (3) deleting the project, or forgetting, retyping or rescoping out its live head, forgets its ids; (4) scopes outside the grant stay invisible; (5) a compacted verbatim retry gets `stale_project`, not the original receipt.
- Size: at most about 24 KB per project. Un-updated desktops still verify, export and compact.

## Rejected
- Separate table, ids on blanked rows (un-updated desktops would report CHAIN BROKEN), a time window.
- Schema bump or rollout gate: locks out un-updated devices.

## What leaves the machine
The original has no egress section; it states it does not change what leaves the machine, and that the ledger never leaves it: `pushSharedScopes` sends id, hash, scope, type and content only, and `ProjectView` exposes no metadata, so no MCP tool returns it. Sync moves it inside the encrypted file; `export()` writes it as readable JSON.

## Links
Full record: docs/design/adr-0062-operation-id-ledger.md · Extends: ADRs 0048, 0051 (its Correction 2026-09-24), 0052
