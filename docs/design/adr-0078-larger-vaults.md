# Design record: ADR 0078, larger vaults

Status: Accepted 2026-10-16 (Jay). Short form: SPEC/decisions/0078-larger-vaults.md.

## Measurements (2026-10-16, read-only)
- Jay's `~/.northkeep/vault.nkv`: 2,265,156 B (2026-09-23 pre-migration copy), 2,601,028 B (2026-09-30 auto-pull backup), 3,444,804 B (2026-10-16, 82% of 4,194,304). 980 live memories; 35 live project documents total 235 KB.
- Growth 2026-09-30 to 2026-10-16: 843,776 B in 16 days, about 53 KB a day. At that pace 32 MB is roughly a year and a half away; the growth includes project history that ADR 0051 bounds, so the real pace should slow.
- The file is whole-file encrypted, so per-table sizes were not measured.

## Parts protocol (D1)
New clients use the single `PUT`/`GET /api/blob` whenever the vault is at most 4 MiB, so an older device keeps reading every vault under that size. Parts are only for larger vaults.

Server tables, added to `SCHEMA_STATEMENTS` one statement each:
- `sync_uploads(upload_id text primary key, token_hash text not null, state text not null check (state in ('open','committed','replaced')), created_at timestamptz, committed_at timestamptz)`.
- `sync_parts(upload_id text, n integer, b64 text, primary key (upload_id, n))`, written with `INSERT ... ON CONFLICT DO NOTHING`, never updated.
- `sync_blobs` gains `upload_id text null`: null means the blob is in `blob_b64`, as today. The single PUT sets it back to null.

Routes, behind the same allowlist and billing gate, with unknown routes still 404 first (handler.ts:70-73) and bounded, parsed path segments:
- `POST /api/blob/uploads` creates an `open` upload; any other `open` upload for the account becomes `replaced` (its parts are deleted lazily).
- `PUT /api/blob/uploads/{id}/{n}`: raw bytes, at most 3 MiB, n from 0 to 10; refused unless the upload is this account's and `open`.
- `POST /api/blob/uploads/{id}/commit` with `{ base, parts, size, sha256 }`: the server reads the immutable parts and checks count, size and SHA-256. Then one statement with data-modifying CTEs: claim the upload (`UPDATE sync_uploads SET state='committed' WHERE upload_id=$id AND token_hash=$t AND state='open' RETURNING`), and from that claim update `sync_blobs` (version + 1, sha, size, upload_id, blob_b64 = '') where `version = base`. Both target rows are locked by the same statement, so a concurrent replace queues behind it. No claim returns 409 "replaced"; no version match returns the existing conflict. The base-0 first push uses the insert-on-conflict pattern from neon-storage.ts. The claim's WHERE also requires the current version to equal base. If a concurrent push still wins between the claim and the update, the statement returns no new version: the client sees the ordinary conflict, and the claimed but uninstalled upload is never readable (reads go through `sync_blobs.upload_id`) and is deleted lazily.
- `GET /api/blob/parts/{n}?upload={id}` reads a fixed committed upload. Committed uploads younger than ten minutes, at most three per account, stay readable; older ones are deleted lazily.
- `GET /api/status` adds `cap_bytes`, `upload_id` and `parts` and selects metadata columns only (today it reads `blob_b64`, neon-storage.ts:79-81).
- The single and parts paths share one version counter; the connector orders by it (apps/connector-server/src/neon-storage.ts:498). The single GET returns 409 when the stored vault is in parts.
- A server rollback after an account has used parts would strand it; rollback needs a step that concatenates parts back into `blob_b64` (3 MiB parts concatenate as base64 because 3 MiB is a multiple of 3 bytes).

## Cap (D2)
- Server `MAX_BLOB_BYTES` becomes config (default 32 MiB). A fixed `SINGLE_REQUEST_MAX` of 4 MiB guards every request body (server.ts:254).
- Clients compile `CLIENT_MAX_BLOB` (32 MiB) and use `min(server cap, CLIENT_MAX_BLOB)`; the phone keeps refusing oversize downloads before decrypting (apps/mobile/src/lib/sync.ts:220). Going past 32 MiB later needs a client release.
- The size report (packages/sync/src/size.ts) takes the cap as input; the sync-size card shows it.
- `RATE_LIMIT_DEFAULT` (server.ts:29) rises from 120 to 300 per 5 minutes: a 32 MiB push every 30 s is 130 requests.

## Older builds (D3)
They keep using single PUT and GET. Above 4 MiB they refuse to push locally (client.ts:343) and get 409 on pull, reported as a generic error. Nothing knows other devices' builds, so the new Mac and phone say "Your vault is over 4 MB; other devices need the latest NorthKeep to keep syncing" when the size crosses 4 MiB. Jay's vault crosses 4 MiB around 2026-10-30 at today's pace, so the Mac release and a phone build ship together.

## Lock (D4)
`withSyncLock` (client.ts:202) touches the lock file after each part, so lock.ts:65-75 never treats a live transfer as stale.

## Dropped from round 1
Compression (oracle) and the Free up space button with keep 3 (it would falsify the five-save copy at project-handoff.ts:52, index.html:3186 and KNOWN-LIMITS). The 32 MiB cap makes the button unnecessary; manual `northkeep projects compact --keep 3` stays available.

## Tests and acceptance
- Server against real Postgres (new harness): a replacing upload during commit yields 409 with nothing installed; commit with stale base conflicts and leaves parts of the winning version intact; missing, extra or reordered parts fail the hash; cross-account part PUT refused; a second upload deletes the first; status never selects blob_b64; old single PUT and parts commits interleave on one counter.
- Client: vaults at most 4 MiB use the single route; push and pull of a 20 MiB throwaway vault in parts; a pull spanning two pushes finishes on one version; lock is not stolen during a slow transfer (fake clock).
- E2E: two throwaway devices sync a 20 MiB vault; a pre-0078 client against the new server syncs under 4 MiB and fails cleanly over it.
- Device (D5): 32 MiB vault opens, edits, pushes and pulls on Jay's iPhone, timed, with memory noted, recorded in the ADR.
