# Embeddings out of the synced vault: design notes for ADR 0067

## Measurements
`node scripts/size-measure.mjs` after `pnpm build`. Throwaway vaults in a temp directory; the fake embedder returns 768 numbers per text, and vectors are written the way the app writes them (`retrieveSemantic`, then `save()`).

| Memories | Without embeddings | With one model |
|---|---|---|
| 500 | 0.37 MiB | 2.36 MiB |
| 1,000 | 0.70 MiB | 4.68 MiB |
| 2,000 | 1.37 MiB | 9.34 MiB |
| 4,000 | 2.71 MiB | 18.63 MiB |

First count over 4 MiB: 853 with vectors, about 5,900 without. Other growth: a project with 200 logged updates reaches 0.25 MiB (compaction keeps 5 revisions); forgetting 500 of 1,000 memories leaves the file at 0.70 MiB; logs, `sync.json`, `.bak` and the device secret live outside the vault file.

## Who reads the vault bytes
- Sync: `pushVault` reads and caps the file; `syncState`, pull, preview, confirm and `auto.ts` compare whole-file sha256 values. Every save already changes the bytes (fresh nonce), so stripping inside `save()` adds no new divergence case. Stripping only at push time would, which is why option (b) is rejected.
- The phone: `preparePushMobile` reads and caps; `hashVaultFile` hashes; the auto-pull `.bak` copies. All go through core's `save()`.
- Backups: `writeAtomic` keeps the previous file as `.bak`. After upgrade, `.bak` holds the table until the next save rotates it.
- Export, the git mirror and Cloud Connect read entries, never vectors. Cloud Connect pushes `MemoryEntry` rows only (`connector-push.ts`).

## Migration detail
`save()`: if `sqlite_master` lists `embeddings`, `DROP TABLE embeddings` then `VACUUM`, unless a transaction is open. Then the D3 check: `PRAGMA freelist_count` over `page_count` above 0.25 runs `VACUUM`. `pushVault`'s locked snapshot step already opens the vault; it saves when the table exists, inside the same step the auto-sync engine already treats as its own save. No schema version bump: a bump would make older phone builds refuse the vault (`VaultSchemaError`).

## Failure modes
A RAM cache cannot be corrupt or missing on disk. If the embedder fails, search falls back to keyword and says so (unchanged). A failed `VACUUM` fails the save loudly, as any SQLite error does today; the file on disk is untouched because `writeAtomic` has not run.

## Phase 2 file list
- `packages/core/src/schema.ts`, `packages/core/src/vault.ts`: D1 to D3.
- `packages/sync/src/client.ts`, `packages/sync/src/index.ts`: D2 push step, D4 helper and fields.
- `packages/cli/src/syncCmd.ts`: D4 lines.
- `apps/web/src/api.ts`: D4 JSON (additive).
- `apps/mobile/src/lib/sync.ts`: D4 message.
- `SPEC/memory-schema.md` (Embeddings section), `KNOWN-LIMITS.md` (sync cap entry).
- Tests: `packages/core/test/semantic.test.ts`, a new `packages/core/test/vault-size.test.ts`, `packages/sync/test` push and status tests, `packages/cli/test` sync status output, `apps/web/test` sync status JSON, an e2e check that a vault saved after search carries no `embeddings` table.
