# Design record: ADR 0078, larger vaults

Status: Proposed 2026-10-16. Short form: SPEC/decisions/0078-larger-vaults.md.

## Measurements (2026-10-16, read-only)
- Jay's `~/.northkeep/vault.nkv`: 2,265,156 B (2026-09-23 pre-migration copy), 2,601,028 B (2026-09-30 auto-pull backup), 3,444,804 B (2026-10-16, 82% of 4,194,304). 980 live memories; 35 live project documents total 235 KB.
- Growth 2026-09-30 to 2026-10-16: 843,776 B over 16 days, about 53 KB a day; at that rate the 4 MB cap is about two weeks away.
- Compressibility: 535 KB of his live memory text (two `memory_list` pages) deflates to 190 KB at zlib level 6 (2.8 to 1). Distinct memories only; superseded project revisions are near-duplicates of each other, but they usually sit more than deflate's 32 KB window apart in the image, so 2.8 is the planning number, not a floor we can promise.
- The vault file is whole-file encrypted, so per-table sizes were not measured. ADR 0051 found superseded project documents were 2.7 of 4.37 MB in September; with keep 5 and 35 projects they are still likely the largest part.

## Format (D1)
- Header unchanged except magic: `NKV2 | salt | opslimit | memlimit | nonce`, still the AEAD associated data.
- Plaintext: `u32LE deflatedLength | rawDeflate(serialize()) | 0x00 padding` to a multiple of 65,536 bytes. Decrypt, read the length, inflate exactly that many bytes, reject trailing non-zero bytes and any length past the end.
- Inflate output is capped (the D4 image ceiling plus margin) so a crafted blob cannot exhaust memory; the AEAD tag already stops anyone without the key from producing one.
- fflate is pure JavaScript, no network access, no native code; one implementation on Node and Hermes keeps output identical across platforms.
- `isVaultBlob` in packages/sync/src/client.ts, `hasVaultMagic` in apps/sync-server/src/handler.ts and the phone's copy in apps/mobile/src/lib/sync.ts accept both magics. Opening in packages/core/src/vault.ts (the magic check near line 287) branches on the magic.

## Rollout (D2)
1. Server deploy: parts routes, NKV2 magic accepted, cap from config. Single PUT and GET unchanged.
2. Release A, Mac and phone: read NKV2, sync in parts when the server offers it, write NKV1.
3. Release B: write NKV2 on the next save. The desktop shows a one-time note on any device still on an older build that pulled nothing new.
An older build that pulls an NKV2 blob fails its magic check and keeps its own file (checkDownload runs before installBlob).

## Parts protocol (D3)
- `POST /api/blob/uploads` returns an upload id. `PUT /api/blob/uploads/{id}/{n}` stores part n (at most 3 MiB, under Vercel's 4.5 MB limit after base64 overhead is avoided by sending raw bytes). `POST /api/blob/uploads/{id}/commit` with `{ base, parts, sha256 }` verifies part count, total size and the hash of the concatenation, then applies the existing optimistic version check and swaps the stored parts in one Neon transaction (`sql.transaction([...])`, since the HTTP driver runs one statement per call).
- `GET /api/status` adds `cap_bytes`, `parts`, and the part size; `GET /api/blob/parts/{n}` returns part n of the current version with its version number, so a download that spans a new push is detected and retried.
- Uncommitted uploads expire after an hour and are deleted on the next request from the same account. A part upload counts against the existing 120 requests per 5 minutes per account; a 16 MB push is 6 requests.
- The single `GET /api/blob` returns 409 with "update NorthKeep to sync this vault" when the stored blob is over 4 MB.

## Cap (D4)
16 MB of ciphertext. The phone holds the decrypted compressed bytes, the inflated image and the open database together, so a 45 MB image is roughly 100 MB of working memory. Release B waits for that device check. Neon storage for 16 MB is trivial per account; parts are stored as base64 text rows like today's `blob_b64`.

## Free up space (D5)
The sync-size card adds a button. It runs `compactProjectHistory({ keep: 3, dryRun: true })`, shows bytes freed per project, then runs it for real on confirm. `PROJECT_COMPACT_DEFAULT_KEEP` becomes 3, so automatic compaction also keeps 3. Older revisions past three stop being available to Restore this version; a revision named by a handoff receipt is still protected (ADR 0051 D1). Needs a mock before build.

## Tests and acceptance
- Core: NKV1 and NKV2 round-trip on Node and sql.js; tampered length, trailing data and oversized inflate refused; sha of local file equals uploaded bytes.
- Server, against real Postgres: parts commit with a stale base conflicts; a missing or reordered part fails the hash; expired uploads are removed; old single PUT still works up to 4 MB.
- E2E: a 10 MB synthetic vault pushes from one throwaway device and pulls on another; a Release A build pulls an NKV2 vault; a pre-0078 build refuses it and keeps its file.
- Device: a 45 MB image opens, edits and pushes on Jay's iPhone (recorded in the ADR before Release B).
