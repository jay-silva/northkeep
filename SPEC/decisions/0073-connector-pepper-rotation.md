# ADR 0073: Rotate the connector pepper on the server, without a wipe

Status: Proposed 2026-10-15 · Review: CLEARED WITH WOUNDS (one Claude reviewer against the code; the multi-model step is Cursor-only)

## Context
Every connector account key is wrapped under a KEK derived from a credential plus `CONNECTOR_KEK_PEPPER`. The pepper lives only in Vercel, marked sensitive, so nobody can read it back, and no copy exists: the 1Password candidate did not match. Losing it makes every connector account unreadable. The server keeps only hashes of the credentials, so it cannot re-wrap keys in bulk; until now a new pepper meant wiping every account.

## Decision
- D1: A new env var, `CONNECTOR_KEK_PEPPER_NEXT`, turns rotation on. Set, it becomes the current pepper and `CONNECTOR_KEK_PEPPER` becomes the previous one, so the old value never has to be read. Unset, nothing changes. A malformed value refuses to boot.
- D2: Every unwrap (account key, pairing code, auth code, access and refresh token, reviewer seed) tries the current pepper, then the previous one. All new wraps use the current pepper only.
- D3: An account key opened with the previous pepper is re-wrapped under the current one on that use, through a compare-and-swap UPDATE so two requests cannot overwrite each other.
- D4: After 30 days, or once every app has reconnected, the new value moves into `CONNECTOR_KEK_PEPPER` and `_NEXT` is deleted.
- Founder, 2026-10-15: rotate on the server rather than wipe; save the new pepper in 1Password before it is set.

## Consequences
- Easier: the pepper gets a backup without a wipe or re-pairing, and future rotations use the same switch.
- Harder: migration happens only as accounts are used and nothing measures it. Refresh tokens last up to 30 days, so retiring the old pepper early strands idle apps. Rolling back to a build without this code strands re-wrapped accounts.
- Committed to: two peppers live at once during rotation; KNOWN-LIMITS carries the operator caveats.

## Review findings
Crypto (libsodium only, no new primitive) and concurrency were found sound. Fixed before merge: the first-time wrap path lacked the fallback; the `_NEXT` boot error was unclear; no refresh-token test; no runbook. Left open: the auth-code fallback has no test of its own (codes live 5 minutes), and migration progress is not measured. Tests: 7 in pepper-rotation.test.ts; turning the fallback off fails 3 of them.

## Rejected
- Wipe and re-push every account: loses connector state for every user.
- Bulk re-wrap: impossible, the server holds only credential hashes.
- Reading the old pepper out of Vercel: sensitive values cannot be read back.

## What leaves the machine
Nothing new. No content, recipient or redaction changes; the connector stores the same ciphertext under a different KEK.

## Links
PR 40 · Extends: ADR 0020
