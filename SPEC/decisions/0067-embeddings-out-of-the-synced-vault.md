# ADR 0067: Embeddings out of the synced vault, and a sync size warning

Status: Proposed 2026-10-15 · Review: CLEARED WITH WOUNDS 2026-10-15; its four findings are addressed in D2, D3, D5 and below

## Context
Sync uploads the whole `.nkv` file, capped at 4 MiB. `SCHEMA_DDL` creates an `embeddings` table in every vault. Measured by `scripts/size-measure.mjs`:
- Content costs about 707 bytes per memory: the cap is near 5,900 memories.
- One model's 768-dimension vectors add about 4,170 bytes per memory: the cap falls to 853 memories.
- Shipped searches never save, so vectors are discarded today; a save after a search would persist them. Without `VACUUM`, dropped and forgotten data keep their pages.
- Nothing warns until a push fails.

## Decision
- D1: The vector cache is RAM only: a per-handle map in core, plus the existing process cache. `SCHEMA_DDL` stops creating `embeddings`.
- D2: No schema bump, so older builds still open the vault. Every vault has the table; `save()` drops it and runs `VACUUM` before serializing. Opening never saves by itself. `pushVault` already saves on nearly every push; its one branch that does not (a stamped, unlanded retry) saves inside the locked step before reading the bytes. The phone drops the table on its next ordinary save.
- D3: `save()` runs `VACUUM` when over a quarter of the image is free pages. Both counts are read with `prepare('PRAGMA ...').get()`; the phone's `pragma()` returns nothing. Invariant: core never calls `save()` inside a transaction; on Node, `save()` throws if one is open, and a test pins it.
- D4: One `@northkeep/sync` helper reports `{ bytes, cap_bytes, percent, warning, over_cap }`, warning at 75% (3,145,728 bytes). `syncState` and `pushVault` return it; `northkeep sync status` and `sync push` print it; `GET /api/sync/status` and `POST /api/sync/push` include it. No new screen.
- D5: The phone gets D1 to D3 through core and uses the D4 helper in its push error. Before the phone ships, a build 34 vault is opened by the new build on a device: write, reopen, push.

## Consequences
- Harder: a cold process re-embeds (about 20 s for 859 memories); warm-up already absorbs it.
- `VACUUM` may renumber rowids; chain and list order are tested after a `VACUUM`ing save on Node and sql.js.

## Rejected
- Encrypted sidecar cache: derived data at rest and a new key derivation, to skip a cold start warm-up already hides.
- Strip at push time: uploaded bytes would differ from the local file, breaking every sha comparison.
- Raising the cap: a new upload path is its own decision.

## What leaves the machine
Less. After upgrade no code path writes vectors to disk, so the sync blob cannot carry them. Files written before the upgrade (`.bak`, `.auto-pull.bak`, pull hold files) keep their old image until rotated; in shipped use their table is empty. The server sees a smaller ciphertext size. The size report sends nothing.

## Links
Design and review findings: docs/design/embeddings-out-of-vault.md · Measurement: scripts/size-measure.mjs · Extends: ADR 0044, 0051
