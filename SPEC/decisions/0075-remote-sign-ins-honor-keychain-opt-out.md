# ADR 0075: Remote MCP sign-ins honor the Keychain opt-out

Status: Proposed · Review: CLEARED WITH WOUNDS, F1 fixed, NorthKeep/Reviews/adr-0075

## Context
`NORTHKEEP_NO_KEYCHAIN=1` is meant to keep NorthKeep out of the macOS Keychain, and tests and acceptance scripts depend on it. In [tokens.ts](../../packages/converse/src/tools/mcp/tokens.ts), saving a remote server's sign-in refuses when that switch is set, but reading and deleting still run `security`. On 2026-10-15 a test run deleted the real vault key ([PR #43](https://github.com/jay-silva/northkeep/pull/43)), and while closing that class of bug we found this gap.

## Decision
- The Keychain store answers only when `keychainAvailable()` says yes: reading returns nothing, deleting does nothing, and saving refuses. We check inside the store itself rather than at each caller, so stores that tests inject keep working.
- With the switch set, a stored sign-in is ignored rather than read. That puts reading in line with saving, which already refuses.
- On a Mac with the switch set, the connect and save refusals name the switch instead of saying there is no Keychain.

## Consequences
- Easier: the switch now does what it says for every NorthKeep Keychain item: the vault key, provider API keys, and remote sign-ins. Running anything with the switch set cannot read or remove a real sign-in.
- Harder: on a Mac with the switch set, remote servers show as "not connected" even when a sign-in is stored. Jay's acceptance commands set the switch, so this is what he will see there. Before this change, such a server connected and then failed at its first token refresh, because saving was already refused.
- Committed to: if `deleteCredentials` ever gets a caller, that caller must not report "removed" while the switch is set. Today nothing calls it, so nothing can make that false claim.

## Rejected
- Checking at each caller: about a dozen call sites across five files read sign-ins. One missed check is this same bug again.
- Throwing on reads: the server status line and the tool listing read sign-ins, and an error there would break `mcp list` where "not connected" is the truthful answer.
- Leaving reads open: then the switch doesn't mean what it says.

## What leaves the machine
Nothing new. With the switch set, fewer local Keychain reads happen and no remote server is contacted.

## Links
Review: F1 (connect refusal blamed a missing Keychain) fixed in this PR; S1 is the Harder bullet · Extends: ADR 0035 Decision 8 · Related: PRs #43, #44
