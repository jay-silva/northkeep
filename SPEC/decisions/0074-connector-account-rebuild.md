# ADR 0074: Rebuild a connector account whose key no longer opens

Status: Proposed 2026-10-15 · Review: NOT CLEARED, fixed; recheck CLEARED WITH WOUNDS

## Context
Each connector account's data key is wrapped under a key built from the device's connector token and the server pepper (ADR 0020). If that wrap stops opening (the pepper was retired before the account re-locked, ADR 0073), every push returns 409 forever, and the old client message ("re-push") could not work. The vault still holds every shared memory.

## Decision
- D1: A push may carry `rebuild: true`. The server honors it only when the account's wrap fails under every pepper this instance has, the push comes from that account's own connector token, and the operator switch `NORTHKEEP_CONNECTOR_ALLOW_REBUILD` is on. The switch is off by default.
- D2: A rebuild resets exactly the wrap that failed. One statement nulls it only if it is still stored, and deletes the account's rows, pairing codes, OAuth codes and tokens only if that update matched. Tombstones, queued forgets and write counters stay. An audit row records the count.
- D3: Never automatic. Only `northkeep share push --rebuild` sends the flag. The 409 body says whether a rebuild is available; when it is not, every message says nothing was changed.
- D4: Auto-push recognizes the 409 by error type and pauses instead of retrying.
- D5: The switch stays off during any pepper rotation, deploy rollover or rollback, and is turned off again after the rebuild it was turned on for. With it on, an instance that cannot open a key another instance can will still honor a rebuild.

## Consequences
- An unreadable account recovers from any device holding its vault, once the operator turns the switch on.
- A rebuild loses connector-born edits not yet pulled down, and every app must pair again. The Mac app has no button yet.
- The reset happens before the push's own 428 and 412 checks. If those then refuse the push, the account is left empty under no key; that state held only unreadable data, and the next push recreates the key.
- Review (one Claude reviewer; the multi-model step is Cursor-only). Fixed: a stale instance could wipe an account another can open (hence the switch), a wrap re-read after failure, deletes gated on a snapshot, auto-push matching "(409)" text, an MCP message offering a refused rebuild, and missing tests. The recheck confirmed the statement on Postgres 16 with a concurrent open transaction; the suite covers it only sequentially (PGlite).

## Rejected
- Reset automatically on 409: a misconfigured pepper would wipe every account.
- Trust any instance that cannot open a key: during a rollover the instance asked may be the stale one.

## What leaves the machine
Nothing new. A rebuild push sends the same shared scopes a normal push sends, plus one boolean.

## Links
Extends: ADR 0020, ADR 0073
