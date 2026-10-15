# ADR 0067: Embeddings out of the synced vault, and a sync size warning

Status: Accepted 2026-10-15 (Jay) · Review: two rounds, both CLEARED WITH WOUNDS

## Context
Sync uploads the whole `.nkv` file, capped at 4 MB (4,194,304 bytes). `SCHEMA_DDL` creates an `embeddings` table in every vault. Measured: content costs about 707 bytes per memory (cap near 5,900 memories); stored 768-dimension vectors add about 4,170 (cap at 853). Shipped searches never save, so vectors are discarded today; a save after a search would persist them. Nothing warns until a push fails.

## Decision
- D1: Vectors are cached in RAM per vault handle; `SCHEMA_DDL` stops creating `embeddings`.
- D2: No schema bump, so older builds still open the vault. `save()` drops the table and runs `VACUUM`; opening saves only when it migrates an older schema. `pushVault`'s one no-save branch (a stamped, unlanded retry) saves inside the locked step before reading the bytes.
- D3: `save()` runs `VACUUM` when over a quarter of the image is free pages, read with `prepare('PRAGMA ...').get()`. Invariant: core never calls `save()` inside a transaction; on Node it throws.
- D4: A `@northkeep/sync` helper reports `{ bytes, cap_bytes, percent, warning, over_cap }`, warning at or over 75% (3,145,728 bytes), in `sync status`, `sync push` and their `/api/sync` JSON. 
- D5: The phone gets D1 to D3 through core and the D4 words in its push error. Before the phone build ships, a build 34 vault is opened by the new build on a device (write, reopen, push) and the result is recorded here.

## Consequences
- A cold process re-embeds (about 20 s for 859 memories).
- Forgetting short memories leaves in-page slack D3 does not reclaim.

## Rejected
- Encrypted sidecar cache: derived data at rest and new key handling, to skip a cold start.
- Strip at push time: uploaded bytes would differ from the local file, breaking every sha comparison.
- Raising the cap: a new upload path is its own decision.

## What leaves the machine
Less. After upgrade no code path writes vectors to disk, so the sync blob cannot carry them. Pre-upgrade `.bak`, `.auto-pull.bak` and pull hold files keep their image until rotated. The server sees a smaller ciphertext size. The size report sends nothing.

## Review
Design round:
- Phone `pragma()` returns nothing and has no `inTransaction`: pragmas read via `prepare()`, invariant stated and tested, sql.js test added.
- Scope understated: D2 covers every vault; push saves only in the retry branch.
- "Never written to disk" needed the pre-upgrade file caveat: added above.
- `VACUUM` may renumber rowids: chain, order and export tested after it on Node and sql.js.

Implementation round:
- Findings lived only in the design doc: this section.
- Mixed MB and MiB, "over 75%" at exactly 75%: one binary MB unit, "at or over 75%".
- sql.js does not prove the device memdb: D5's device result is recorded before shipping.

Device result (build 34 vault, new build): not yet run.

## Links
Design: docs/design/embeddings-out-of-vault.md · Measurement: scripts/size-measure.mjs · Extends: ADR 0044, 0051
