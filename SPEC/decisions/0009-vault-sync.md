# ADR 0009: Encrypted vault sync (ciphertext-only server)

Status: Accepted 2026-07-07 (M5) · Review: adversarial review 2026-07-07, no CRITICAL or HIGH findings; MEDIUM-1 fixed

## Context
M5 makes the vault follow the user to a second machine; the server may store ciphertext and version numbers only (invariant #2). Jay chose sync now, billing later (M5b), on Vercel + Neon Postgres; the service is open with abuse guards.

## Decision
- D1: The `.nkv` file (ADR 0001) syncs as an opaque blob; the same passphrase plus `device.secret` derives the same key. No re-encryption or format change.
- D2: No signup. `accountId = keyed-BLAKE2b(device_secret, "nk-sync-account-v1")` and `token = keyed-BLAKE2b(device_secret, "nk-sync-token-v1")`, both one-way. The server stores only `sha256(token)`. No PII reaches it.
- D3: The server owns a monotonic `version`; the client keeps the last-synced one in `~/.northkeep/sync.json` (0600, no secrets). `PUT` sends `X-Base-Version`; the atomic conditional write returns 409 plus the current version on mismatch. Conflicts are whole-vault last-writer-wins; pull keeps the prior state as `.nkv.bak`.
- D4: A download is checked (NKV1 magic, length, transport `sha256`) and, when a local vault exists, proven to open with the caller's key before replacing it. A fresh machine writes it directly.
- D5: The client refuses non-`https` URLs unless loopback and uses `redirect:'error'`. The self-hostable server (`apps/sync-server`) stores ciphertext, version and hashes only, rejects non-NKV1 bodies, caps blobs at about 4 MB, and never logs blob content.
- D6 (from review): optional allowlist `NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES` (a set of `sha256(token)` hashes). When set, the server serves only those accounts, the way to run a private server until M5b. `northkeep sync id` prints the user's hash. The NKV1 check is a sanity check, not abuse protection.

## Consequences
- Open service until billing (M5b): without the allowlist, abuse protection is the size cap plus platform rate limiting. Do not expose a no-allowlist server publicly.
- Bounded trust in the host: opaque ciphertext and hashes reside in Neon, a subprocessor. Self-hosting gives full custody.
- Whoever holds `device.secret` can push or pull the undecryptable blob; a stolen token can at worst overwrite the server copy. `device.secret` is copied out-of-band; losing it loses the vault.
- Pull has no "you are ahead" guard: unpushed local edits are overwritten (recoverable from `.nkv.bak`). Push before you pull.
- The transport sha256 detects honest corruption only; open-verify is the defense. The fresh-machine path has no cryptographic gate before the first open.
- Dependencies (Jay approved): `sodium-native` (already present); `@neondatabase/serverless` and Vercel, server-side only.

## Rejected
- `chain_head` or file hashes as version: `forget()` does not advance the head; every save re-nonces.
- Per-entry or CRDT merge: deferred.

## What leaves the machine
The original has no egress section. Its review states clients transmit only the opaque `.nkv` blob and the one-way token, and passphrase, master key and device secret never leave; it verified storage and logs hold only ciphertext, hashes and versions, and no token, key or `DATABASE_URL` reaches a log, response or error.

## Links
Builds on: ADR 0001 · Full record: docs/design/adr-0009-vault-sync.md
