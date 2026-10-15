# Embeddings out of the synced vault: design notes for ADR 0067

## Measurements
`node scripts/size-measure.mjs` after `pnpm build`. Throwaway vaults in a temp directory; a fake embedder returns 768 numbers per text, written the way a pre-0067 build wrote them.

| Memories | Without embeddings | With one model |
|---|---|---|
| 500 | 0.37 MB | 2.36 MB |
| 1,000 | 0.70 MB | 4.68 MB |
| 2,000 | 1.37 MB | 9.34 MB |
| 4,000 | 2.71 MB | 18.63 MB |

First count over 4 MB: 853 with vectors, about 5,900 without. A project with 200 logged updates reaches 0.25 MB. Logs, `sync.json`, `.bak` and the device secret live outside the vault file.

## Who reads the vault bytes
- Sync on desktop and phone hashes and caps the whole file. Every save already changes the bytes (fresh nonce), so dropping the table inside `save()` adds no new divergence case; stripping at push time would.
- Backups: `.bak`, `.auto-pull.bak` and pull hold files keep earlier images until rotated.
- Export, the git mirror and Cloud Connect read entries, never vectors.

## Review findings and how each is addressed
1. Phone pragmas and transactions. The phone driver's `pragma()` returns nothing and it has no `inTransaction`. Fixed: `freelist_count` and `page_count` are read with `prepare('PRAGMA ...').get()`. The invariant "core never calls `save()` inside a transaction" replaces the guard; on Node `save()` throws if one is open, pinned by `vault-size.test.ts`. A sql.js driver shaped like the expo adapter runs the real `save()` in `byte-exact.test.ts`. A device run (build 34 vault opened by the new build: write, reopen, push) is an acceptance item before the phone ships.
2. Scope. `SCHEMA_DDL` made the table in every vault, so every device drops it on its next save. `pushVault`'s extra save is only in the stamped, unlanded branch, inside the locked step before the bytes are read, so `lastSha` matches what was sent (tested). The phone adds no push save.
3. "Never written to disk" holds only after upgrade. The ADR now says files written before the upgrade keep their image until rotated.
4. `VACUUM` may renumber rowids. Tests assert `verifyChain()`, list order and export after a `VACUUM`ing save on better-sqlite3 and sql.js.

## Implementation notes
- D3 frees whole pages only. Forgetting a long memory frees its overflow pages, which D3 reclaims. Forgetting short memories blanks rows in place and leaves slack inside pages that `freelist_count` does not see (300 of 400 short memories forgotten: 76 pages, 54 after `VACUUM`). KNOWN-LIMITS says so.
- The per-handle vector map is cleared on `close()` and by `clearEmbeddingCache()`, which also drops a legacy table.
- D4 helper: `packages/sync/src/size.ts`. Percent rounds down, so 74.9% never reads as 75%.
