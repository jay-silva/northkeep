# ADR 0067: Embeddings out of the synced vault, and a size warning before the sync cap

Status: Proposed 2026-10-15 · Review: pending (adversarial, against code)

## Context
Sync uploads the whole `.nkv` file, capped at 4 MiB (`MAX_BLOB_BYTES`; Vercel refuses bodies over 4.5 MB). The `embeddings` table lives in the vault image (`schema.ts:29`). Measured by `scripts/size-measure.mjs`:
- Content costs about 707 bytes per memory: the cap is near 5,900 memories, or 450 to 500 entries of 8,000 characters.
- One model's 768-dimension vectors add about 4,170 bytes per memory: the cap falls to 853 memories.
- Shipped searches run on a fresh handle and close without saving, so vectors are discarded today. Any save on a handle that searched persists them all. Dropping the table without `VACUUM` frees nothing, and forgotten content keeps its pages.
- Nothing warns until a push fails.

The vector cliff is latent; the content cliff is real.

## Decision
- D1: The vector cache is RAM only: a per-handle map in core, plus the existing process cache (`createCachedEmbedder`, cleared on lock). `SCHEMA_DDL` stops creating `embeddings`.
- D2: No schema bump, so older builds still open the vault. `save()` drops a leftover `embeddings` table and runs `VACUUM` before serializing. Opening never saves by itself, so upgrading causes no sync divergence. `pushVault` saves first when the table exists.
- D3: `save()` runs `VACUUM` when over a quarter of the image is free pages.
- D4: One `@northkeep/sync` helper reports `{ bytes, cap_bytes, percent, warning }`, warning at 75%. `syncState` and `pushVault` return it; `northkeep sync status` and `sync push` print it with the remedy; `GET /api/sync/status` and `POST /api/sync/push` include it. No new screen; Mac UI text follows a mock.
- D5: The phone gets D1 to D3 through core and uses the D4 helper in its push error. No storage seam change.

## Consequences
- Easier: vectors can never push a vault over the cap, and users see 75% first.
- Harder: a cold process re-embeds (about 20 s for 859 memories); web warm-up and MCP pre-embed already absorb it.
- `.bak` keeps the old table until the second save after upgrade. It is never synced.

## Rejected
- Encrypted sidecar cache: new derived data at rest, a key derivation under crypto review, purge on forget, phone storage and backup rules, all to skip a cold start warm-up already hides. Revisit if first searches prove slow.
- Strip at push time: uploaded bytes would differ from the local file, breaking the sha comparisons in `client.ts` and `auto.ts`, and the file still grows.
- Raising the cap: a new upload path is its own decision.

## What leaves the machine
Less. The sync blob can no longer carry embedding vectors, and vectors are never written to disk. The server sees a smaller ciphertext size, which it already sees. Cloud Connect never received vectors. The size report is local and sends nothing.

## Links
Design: docs/design/embeddings-out-of-vault.md · Measurement: scripts/size-measure.mjs · Extends: ADR 0044, 0051 · Spec: SPEC/memory-schema.md (Embeddings)
