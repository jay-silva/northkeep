# ADR 0078: Larger vaults: sync in parts, 32 MB cap

Status: Proposed 2026-10-16 · Review: round 1 NOT CLEARED (compression dropped, commit redesigned); round 2 pending

## Context
Sync sends the whole `.nkv` in one request, capped at 4 MB by Vercel's 4.5 MB body limit (ADR 0051 D4). Jay's vault hit 4.37 MB on 2026-09-21 and, after ADR 0051, 3.44 MB on 2026-10-16, growing about 53 KB a day.

## Decision
- D1: Sync in parts. A push opens one upload bound to the account (replacing any open one), sends parts of at most 3 MiB, then commits. Parts are write-once rows keyed by upload id. Commit is one conditional SQL statement: it bumps the same version counter the single PUT uses, only if the base matches and every part is present, after the server checks the parts' hash. Downloads name the upload id, so a pull spanning a push reads one version.
- D2: The cap becomes 32 MB of ciphertext, set by server config, warning at 75%. Clients use the smaller of the server's cap and a compiled ceiling. A separate 4 MiB single-request limit stays. Status reads metadata only.
- D3: The single `PUT`/`GET /api/blob` stays for vaults up to 4 MB, so older builds sync until then. Past 4 MB they get an error code; the newer device says which devices need updating.
- D4: The sync lock is refreshed after each part, so a slow transfer is never treated as abandoned.
- D5: The size card gets "Free up space": a dry run shows what project history compaction with keep 3 would free, then a confirm runs it. The automatic default stays 5, so every "five saves" promise stays true.
- D6: Before shipping, a 32 MB vault opens, edits and pushes on Jay's iPhone, timed and recorded here.

## Consequences
- Easier: nine times today's room; a bigger cap later is config plus a phone check.
- Harder: three routes and a parts table on the sync server; a 32 MB push is 13 requests (limit 120 per 5 minutes).

## Rejected
- Compress before encrypting: size then depends on content. The review recovered secret characters from 64 KiB-padded sizes when an attacker can inject text, for example through connector down-sync. Ruled out by invariant 2's threat model.
- Direct upload to object storage: a new networked vendor (invariant 7).
- Lower the automatic keep to 3: breaks five-save promises in the app and KNOWN-LIMITS.

## What leaves the machine
The same ciphertext, to the same server. New metadata: part count, upload timing and an upload id; none reveals content beyond total size, already visible.

## Review
Round 1, against code: compression oracle (dropped); a batched transaction cannot skip the swap after a failed version check (now one conditional statement); status read the whole blob; lock stolen mid-transfer; unbound upload ids; no client cap ceiling. Older builds never overwrite their own file.

## Links
Design: docs/design/adr-0078-larger-vaults.md · Extends: ADR 0009, 0044, 0051
