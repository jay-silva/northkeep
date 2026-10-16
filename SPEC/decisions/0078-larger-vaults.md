# ADR 0078: Larger vaults: sync in parts, 32 MB cap

Status: Accepted 2026-10-16 (Jay) · Review: round 1 NOT CLEARED (compression dropped, commit redesigned); round 2 CLEARED WITH WOUNDS (fixed below)

## Context
Sync sends the whole `.nkv` in one request, capped at 4 MB by Vercel's 4.5 MB body limit (ADR 0051 D4). Jay's vault hit 4.37 MB on 2026-09-21 and, after ADR 0051, 3.44 MB on 2026-10-16, growing about 53 KB a day: past 4 MiB around 2026-10-30.

## Decision
- D1: Vaults over 4 MiB sync in parts; smaller ones keep the single `PUT`/`GET /api/blob`, which also resets the parts pointer. A push opens an upload bound to the account, sends write-once parts of at most 3 MiB, then commits. The server checks the parts' hash, then one conditional SQL statement claims the upload row and bumps the shared version counter only if the base matches; a replaced upload gets 409. Uploads under ten minutes old (at most three) stay readable, so a slow pull spanning pushes finishes on one version.
- D2: The cap becomes 32 MiB of ciphertext, set by server config, warning at 75%. Clients use the smaller of the server's cap and a compiled ceiling, so going past 32 MiB needs a client release. A fixed 4 MiB single-request limit stays. Status reads metadata only. The per-account limit rises to 300 requests per 5 minutes.
- D3: Older builds keep syncing below 4 MiB. Above it they refuse locally and stop syncing; the newer device says the vault passed 4 MB and other devices need the update.
- D4: The sync lock is refreshed after each part, so a slow transfer is never treated as abandoned.
- D5: Before shipping, a 32 MiB vault opens, edits, pushes and pulls on Jay's iPhone, timed and recorded here.

## Consequences
- Easier: 9.7 times today's vault; no format change.
- Harder: four routes and two tables on the sync server; a Postgres test harness; a 32 MiB push is 13 requests.
- Timing: Mac and phone must update before the vault passes 4 MiB, or the other device stops syncing.

## Rejected
- Compress before encrypting: size then depends on content. The review recovered secret characters from padded sizes when an attacker can inject text, such as through connector down-sync. Ruled out by invariant 2.
- Direct upload to object storage: a new networked vendor (invariant 7).
- Automatic keep of 3: breaks published five-save promises.

## What leaves the machine
The same ciphertext, to the same server. New metadata: part count, upload timing and an upload id; none reveals content beyond total size, already visible.

## Review
Round 1, against code: compression oracle; batched commit could swap after a failed check; status read the whole blob; lock stolen mid-transfer; unbound uploads; no client ceiling. Round 2: commit raced a replacing upload; parts emptied the old GET; false claims about old builds. All fixed above.

## Links
Design: docs/design/adr-0078-larger-vaults.md · Extends: ADR 0009, 0044, 0051
