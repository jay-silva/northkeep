# ADR 0031: The web GUI agent-loop approval protocol

- **Date:** 2026-07-25
- **Status:** Accepted
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0027 (harness umbrella), ADR 0029 (security model), ADR 0030

## Context

M10a–M10d built the tool-using agent loop and ran it from the CLI, where
approval is a blocking readline. M10e brings it to the web GUI. The hard part
is that the GUI's converse route is a single NDJSON response (start → token* →
done), but the agent loop's `requestApproval` must PAUSE mid-stream and wait
for a human decision the browser can only deliver via a SEPARATE HTTP request.

## Decision 1: NDJSON down-channel + a separate authed POST up-channel

The server→browser channel is the existing NDJSON stream; the browser→server
answer is a new authenticated POST. Not WebSockets — the loopback token +
one-shot request model is simpler and already the app's security posture.

When a request sets `tools: true`, the converse handler runs `runTask` (not
`runTurn`) with hooks. New NDJSON event types, mirroring the CLI's TaskEvent
fields.

**On "content-free":** every event below is content-free in the sense the audit
log means it — names, hosts, counts, decisions, never vault text or fetched page
content — with **two deliberate exceptions that carry restored plaintext**:
`approval_request` (`query` / `args_plain`) and the `tool_egress` proof of
Decision 6. Both must, because a gate that hides what it is approving is not a
gate. They are ephemeral and loopback-only: streamed once over the authenticated
localhost response, rendered, and never persisted. The audit log written from the
same events stores only hashes (ADR 0029 Decision 4). Nothing here is a
disclosure to a third party; it is a disclosure to the user, about their own
machine, which is the entire point of the surface.

- `{type:'tool_step', n}` — a new agent-loop step began.
- `{type:'tool_call', name, host?, egress_tier?}` — the model asked for a tool.
- `{type:'approval_request', approval_id, tool, query?, args_plain?, egress:{host,tier}|null, risk, warnings:[], offer_scopes}` — a decision is needed. `query` for web_search, `args_plain` otherwise; NEVER the Brave token or fenced page content.
- `{type:'permission', name, decision, via?, reasons?}` — how a call resolved.
- `{type:'tool_result', name, ok, bytes, truncated, host?, error?}` — outcome.

`approval_id` is a random UUID, single-use.

## Decision 2: the approve endpoint

`POST /api/converse/approve {session_id, approval_id, decision}` where
`decision ∈ allow | allow-session | allow-always | deny | deny-never`.

- Authed identically to every /api call: loopback Host check + the per-session
  `x-northkeep-token` (constant-time). No new auth surface.
- Looks up a module `pendingApprovals: Map<approval_id, entry>`; a missing id
  → 404 (already answered, timed out, aborted, or never existed). The frontend
  treats 404 as "expired — re-ask", never a spinning button.
- The entry records the `session_id` it was issued for; a mismatch → 404. One
  conversation can never resolve another's pending call.
- On success: resolve the loop's promise with the decision, delete the entry,
  return `{ok:true}`.

## Decision 3: three lifecycle invariants (the map's real risk)

- **Single-settle.** Exactly one of {approve POST, 5-min timeout, stream abort}
  settles an approval; ENTRY DELETION is the guard. Whoever fires first deletes
  it; the others find it gone and no-op. A second approve POST 404s.
- **Abort sweeps the map.** On the response `'close'` event (browser navigated
  away / reload), an AbortController aborts `runTask` — which denies pending
  approvals via the signal path — AND the converse layer deletes that task's
  map entries, so a disconnected stream leaks no pending resolver.
- **No send after end.** `runTask` keeps running until it next checks the
  abort signal, so every NDJSON `send()` is guarded on `!res.writableEnded`
  (a write-after-end would throw and crash the handler).

## Decision 4: one permission engine per conversation

Per ADR 0029's documented requirement, each conversation gets its OWN
`createPermissionEngine({persist:true})`, stored beside its session in the
`conversations` map — NOT a shared singleton. A shared engine would let a
"this session" grant in conversation A silently auto-allow in conversation B.

## Decision 5: the budget reservation closes the M10d TOCTOU

The GUI makes concurrent conversations real, so the daily-cap
check→execute→record race (KNOWN-LIMITS, M10d G5) is now reachable. The fix is
an ATOMIC, synchronous reserve at EXECUTE time:

- `reserveDailySpend(tool, now): boolean` in budget.ts — one synchronous
  read-check-increment-write (readFileSync/writeFileSync, no await). Two
  concurrent `runTask` calls cannot interleave it in single-threaded Node: the
  first runs to completion (returns true, count now at cap), the second reads
  the incremented count and returns false.
- The loop's pre-gate budget check stays ADVISORY (don't prompt when clearly
  over). The atomic reserve at execute is the AUTHORITY. Chosen over
  reserve-at-prompt-with-release because release-exhaustiveness is a footgun:
  every non-execute exit (deny, timeout, abort, step-limit, setup throw) would
  have to release, and one miss drifts the count up permanently until midnight.
  Reserve-at-execute has no release paths. The accepted tradeoff: two
  concurrent prompts for a cap-1 tool can both appear, and the second approval
  budget-denies AFTER consent — rare and correct.

## Decision 6: the "what left this device" proof includes tool egress

The transparency strip is fed by `sentWire` (the model wire). A tool turn's
NEW egress is the URL/query that hits Brave or a fetched site, which is NOT in
the model wire. The `done` event therefore gains a `tool_egress` list — one
content-free line per executed tool call (tool name, host, and the restored
query/URL as the gate showed it, never the token) — so the proof never
under-reports what left, exactly when the most leaves (M10a review rule).

## Security properties (for G4)

- **Approve cannot bypass the screens.** The exfiltration secret hard-block
  runs BEFORE `requestApproval` in the loop, so a forged or replayed "allow"
  can only ever land on a call that was already screen-clean or identity/
  memory-warned — never on a hard-blocked secret.
- **CSRF.** A cross-origin page cannot forge the `x-northkeep-token` header:
  the custom header forces a CORS preflight, the server sends NO
  `access-control-allow-*` headers (preflight fails closed), and approve is
  POST-only, so no form/img GET can carry the token. connect-src is self.
- **Tool-egress redaction holds at every model tier.** Even a tools-enabled
  conversation on a private endpoint at Tier 0 (model wire legitimately
  plaintext to a LOCAL model) still runs the ADR-0027 Tier-1 floor on the
  arguments bound for a BOUNDED tool egress — the egress seam is independent
  of the model-wire tier.

## Consequences

- The full agent loop — approvals, grants, screens, budget — works in the
  browser with the same guarantees as the CLI.
- The harness feature flag can default on after the G4 review, since every
  driving surface (CLI, GUI) now enforces the same security model.
