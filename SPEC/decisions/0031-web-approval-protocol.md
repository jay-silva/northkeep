# ADR 0031: The web GUI agent-loop approval protocol

Status: Accepted 2026-07-25 · Review: no verdict recorded; the security properties were written for the G4 review · Deciders: Jay, Claude Code

## Context
M10a to M10d ran the tool-using agent loop from the CLI, with a blocking readline approval. M10e brings it to the web GUI, whose converse route is one NDJSON response, yet `requestApproval` must pause mid-stream for a decision the browser sends in a separate request.

## Decision
- D1: Down-channel is the NDJSON stream; up-channel is a new authenticated POST. With `tools: true` the handler runs `runTask` and streams `tool_step`, `tool_call`, `approval_request`, `permission`, `tool_result`. Events are content-free except two carrying restored plaintext so the user sees what they approve: `approval_request` (`query` / `args_plain`, never the Brave token or fenced page content) and the D6 `tool_egress` proof. Both are streamed once over authenticated localhost, never persisted; the audit log stores only hashes (ADR 0029). `approval_id` is a random single-use UUID.
- D2: `POST /api/converse/approve {session_id, approval_id, decision}`, decision one of `allow | allow-session | allow-always | deny | deny-never`. Same auth as every /api call (loopback Host check, constant-time `x-northkeep-token`). Missing id or `session_id` mismatch returns 404, shown as expired.
- D3: Exactly one of approve POST, 5-min timeout or stream abort settles an approval; deleting the `pendingApprovals` entry is the guard. On `'close'` an AbortController aborts `runTask` (denying pending approvals) and the entries are deleted. Every `send()` checks `!res.writableEnded`.
- D4: One `createPermissionEngine({persist:true})` per conversation, never shared, so a session grant cannot leak across conversations.
- D5: `reserveDailySpend(tool, now)`, a synchronous read-check-increment-write at execute time, closes the M10d daily-cap TOCTOU. The pre-gate check stays advisory.
- D6: The `done` event gains `tool_egress`: per executed call, tool name, host and the restored query/URL as the gate showed it, never the token.

## Consequences
- Easier: approvals, grants, screens and budget work in the browser with the CLI's guarantees; the harness flag can default on after G4.
- Harder: two concurrent prompts for a cap-1 tool can both appear; the second budget-denies after consent.
- Claimed properties: the exfiltration secret hard-block runs before `requestApproval`, so a forged allow cannot land on a hard-blocked secret. CSRF: the custom header forces a preflight, no `access-control-allow-*` headers are sent, approve is POST-only, connect-src is self. The ADR 0027 Tier-1 floor runs on arguments bound for bounded tool egress at every model tier, including Tier 0.

## Rejected
- Shared permission engine: grants would cross conversations.
- Reserve at prompt with release: one missed release drifts the count until midnight.

## What leaves the machine
The original has no egress section. It states: "Nothing here is a disclosure to a third party; it is a disclosure to the user": restored plaintext in `approval_request` and `tool_egress` is streamed once over authenticated localhost and never persisted. Arguments bound for bounded tool egress still pass the ADR 0027 Tier-1 floor.

## Links
Full record: docs/design/adr-0031-web-approval-protocol.md · Parent: ADRs 0027, 0029, 0030
