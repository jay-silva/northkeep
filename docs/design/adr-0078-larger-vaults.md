# Design record: ADR 0078, larger vaults

Status: Proposed 2026-10-16. Short form: SPEC/decisions/0078-larger-vaults.md.

## Measurements (2026-10-16, read-only)
- Jay's `~/.northkeep/vault.nkv`: 2,265,156 B (2026-09-23 pre-migration copy), 2,601,028 B (2026-09-30 auto-pull backup), 3,444,804 B (2026-10-16, 82% of 4,194,304). 980 live memories; 35 live project documents total 235 KB.
- Growth 2026-09-30 to 2026-10-16: 843,776 B in 16 days, about 53 KB a day. At that pace 32 MB is roughly a year and a half away; the growth includes project history that ADR 0051 bounds, so the real pace should slow.
- The file is whole-file encrypted, so per-table sizes were not measured.

## Parts protocol (D1)
Server tables, added to `SCHEMA_STATEMENTS` one statement each:
- `sync_uploads(upload_id text primary key, token_hash text not null, created_at timestamptz)`, at most one open row per account.
- `sync_parts(upload_id text, n integer, b64 text, primary key (upload_id, n))`, written with `INSERT ... ON CONFLICT DO NOTHING` and never updated.
- `sync_blobs` gains `upload_id text null` (null means the blob lives in `blob_b64`, as today).

Routes, all behind the same allowlist and billing gate, with unknown routes still 404 first (handler.ts:70-73) and bounded, parsed path segments:
- `POST /api/blob/uploads` creates an upload for this account, deleting any open one and its parts.
- `PUT /api/blob/uploads/{id}/{n}`: raw bytes, at most 3 MiB, n from 0 to 10; refused unless the upload belongs to this account.
- `POST /api/blob/uploads/{id}/commit` with `{ base, parts, size, sha256 }`: the server reads the immutable parts, checks count, size and SHA-256, then runs one statement: a data-modifying CTE that updates `sync_blobs` (version + 1, sha, size, upload_id, blob_b64 cleared) where `token_hash` and `version = base` match, returning the new version. Zero rows is a conflict, exactly as today's put. First push (base 0) uses the same insert-on-conflict pattern as neon-storage.ts.
- `GET /api/blob/parts/{n}?upload={id}` reads a fixed upload; the previous committed upload is kept for ten minutes after a newer commit, then deleted lazily, so a slow download finishes on one version or restarts cleanly.
- `GET /api/status` adds `cap_bytes`, `upload_id` and `parts`, and selects metadata columns only (today it reads `blob_b64`, neon-storage.ts:79-81).
- Single `PUT /api/blob` and `GET /api/blob` keep working while size is at most 4 MiB and share the version counter; the connector orders by that number (apps/connector-server/src/neon-storage.ts:498). Above 4 MiB the single GET returns 409.

## Cap (D2)
- Server `MAX_BLOB_BYTES` becomes config (default 32 MiB). A separate fixed `SINGLE_REQUEST_MAX` of 4 MiB guards every request body in server.ts:254, so a big single PUT never reaches Vercel's opaque 413.
- Clients compile `CLIENT_MAX_BLOB` (32 MiB) and use `min(server cap, CLIENT_MAX_BLOB)`; the phone keeps refusing oversize downloads before decrypting (apps/mobile/src/lib/sync.ts:220).
- The size report (packages/sync/src/size.ts) takes the cap as input; the sync-size card shows it.

## Older builds (D3)
They keep using single PUT and GET. Past 4 MiB, their push gets 413 and pull 409, and they report a generic HTTP error (client.ts:118, mobile sync.ts:211). The new Mac and phone show "Your vault is over 4 MB; update NorthKeep on your other devices" when the size crosses 4 MiB. No format change, so old builds still open every local file.

## Lock (D4)
`withSyncLock` (client.ts:202) touches the lock file after each part, so lock.ts:65-75 never treats a live transfer as stale.

## Free up space (D5)
Runs `compactProjectHistory({ keep: 3, dryRun: true })`, lists bytes freed per project, and runs it on confirm. `PROJECT_COMPACT_DEFAULT_KEEP` stays 5. Copy on the button says older versions past three are cleared for every project now. Needs a mock before build.

## Tests and acceptance
- Server against real Postgres: commit with stale base conflicts and leaves parts of the winning version intact; missing, extra or reordered parts fail the hash; cross-account part PUT refused; a second upload deletes the first; status never selects blob_b64; old single PUT and parts commits interleave on one counter.
- Client: push and pull of a 20 MiB throwaway vault in parts; a pull spanning a push finishes on one version; lock is not stolen during a slow transfer (fake clock).
- E2E: two throwaway devices sync a 20 MiB vault; a pre-0078 client against the new server syncs under 4 MiB and fails cleanly over it.
- Device (D6): 32 MiB vault opens, edits and pushes on Jay's iPhone, timed, recorded in the ADR.
