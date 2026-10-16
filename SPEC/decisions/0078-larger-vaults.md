# ADR 0078: Larger vaults: compress inside the envelope, sync in parts

Status: Proposed 2026-10-16 · Review: pending

## Context
Sync sends the whole `.nkv` in one request, capped at 4 MB by Vercel's 4.5 MB body limit (ADR 0051 D4). The SQLite image inside is uncompressed text. Jay's vault hit 4.37 MB on 2026-09-21; after ADR 0051 it was 2.60 MB on 2026-09-30 and 3.44 MB on 2026-10-16, about 53 KB a day. His memory text deflates 2.8 to 1 (535 KB sample). Retention alone only buys weeks.

## Decision
- D1: Format NKV2 compresses before encrypting. Same header with magic `NKV2`; the plaintext is a u32 length, the raw-deflate SQLite image (fflate, level 6, both platforms), then zeros to the next 64 KiB. The local file and the upload stay the same bytes, so sha checks hold. Every build opens NKV1 and NKV2.
- D2: Two releases. Release A (Mac and phone) reads NKV2 and still writes NKV1. Release B writes NKV2 once Jay's devices all run Release A. An older build that meets NKV2 refuses it as not a vault; it never overwrites it.
- D3: Sync in parts. New routes upload parts of at most 3 MB under an upload id that expires after an hour, then commit with the existing version check in one transaction. Download reads parts by index. The single `PUT`/`GET /api/blob` stays for blobs up to 4 MB, so older builds sync until a vault passes 4 MB.
- D4: The cap becomes 16 MB of ciphertext, set by server config; the warning stays at 75%. At 2.8 to 1 that holds about 45 MB of vault, 13 times Jay's today. The client reads the cap from `/api/status`.
- D5: The size card gets "Free up space": a dry run shows what project history compaction would free, and a confirm runs it with keep 3. The default keep drops from 5 to 3.

## Consequences
- Easier: years of headroom; cleanup sits on the warning.
- Harder: two releases and a server deploy before Release B; a parts table on Neon, up to 16 MB per account.
- Phone: opening holds both images in memory; Release B waits until a 45 MB image opens on Jay's iPhone.

## Rejected
- Direct upload to object storage: a new networked vendor (invariant 7).
- zstd: no pure-JS encoder for the phone.
- Compress at push only: the upload would differ from the local file (ADR 0067).
- Cap raise alone: costs phone memory and storage for less headroom.

## What leaves the machine
The same ciphertext, smaller, to the same server. Compressing before encrypting lets size depend on content. Padding to 64 KiB means the server sees only size buckets; someone who can write chosen text into the vault and watch push sizes learns at most whether a write crossed a bucket. Part counts and upload timing are new metadata.

## Review
Pending.

## Links
Design: docs/design/adr-0078-larger-vaults.md · Extends: ADR 0009, 0051, 0067
