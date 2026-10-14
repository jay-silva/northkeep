# ADR 0020: Connector store encryption at rest

Status: Accepted 2026-07-16, shipped (corrected 2026-07-25) · Review: design review (four mandatory corrections) and crypto review (pepper, pairing-code fixes). Open: the status says review completed, but the record's closing line says the code-level review gates the merge, and no code-level verdict is recorded

## Context
Under ADR 0019 a stolen or leaked connector database held every shared memory in plaintext. Here AI apps still receive plaintext, but the database holds only ciphertext and no key that can decrypt it.

## Decision
- D1: Each account has one random 32-byte DEK (`randombytes_buf`), never stored raw. Each row's `{type, content}` is encrypted with XChaCha20-Poly1305 under the DEK, per-row nonce, stored as `nkc1:<b64 nonce>:<b64 ct>`. AAD is `"nk-conn-row-v1" || account_hash`, which blocks cross-account transplant; it excludes `entry_id` so `/client/ack` stays key-free.
- D2: The DEK is stored only wrapped (`crypto_secretbox_easy`, `nkw1:`) in a `dek_wrap` column on each credential row, so wraps die with their credential. `KEK = generichash(key = pepper, msg = generichash(key = credential, msg = label))`, one label per credential class (`nk-conn-kek-conn-v1`, `-pair-v1`, `-code-v1`, `-token-v1`).
- D3: `CONNECTOR_KEK_PEPPER` (32-plus bytes, outside the database) enters every KEK. On real Neon storage the server throws at startup without it; InMemory uses a fixed non-secret DEV pepper. Rotating it requires a full wipe and re-pair.
- D4: Pairing codes (about 40 bits) are DELETEd on consume and refused and GC'd on expiry; the pepper covers outstanding codes.
- D5: Custody: the DEK is unwrapped only while a request presents a credential (`/pair/start`, `/consent`, `/token`, `/mcp`, `/client/entries`, `/client/pending`). Refresh uses one atomic `consumeToken`, which also fixes a concurrent-refresh race. First DEK creation uses a `COALESCE` update.
- D6: An unopenable wrap returns 409 `reencrypt_required` (re-push the shared scopes); on `/mcp` a 401.
- D7: Non-`nkc1:` rows are skipped unless `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1` (self-host only; hosted does not set it).
- D8: Dependency `libsodium-wrappers` (wasm, no network) in `apps/connector-server` only; ships only with Jay's OK on this ADR.

## Consequences
- Protected: a database-only compromise yields ciphertext, wraps, sha256 credential hashes and metadata; no stored value decrypts anything.
- NOT protected: a compromised server codebase or runtime can capture credentials and DEKs as requests arrive; memory dumps can hold transient DEKs and plaintext; AI providers see whatever a connected app retrieves.
- Still visible: scope labels, entry ids, row counts, ciphertext lengths (approximating content lengths), timestamps, `entry_hash` values, account hashes, the content-free audit ledger.
- Claim wording: "we don't store," never "we can't read."
- Migration: wipe the connector database and re-pair.

## Rejected
- Wrapping under the pairing code alone: groundable offline from the database.
- `entry_id` in the AAD: would force the ack path to hold a key.

## What leaves the machine
The original has no egress section. It states AI apps still receive plaintext and the server encrypts pushed rows before storage, decrypting transiently per request. What changes is what the connector stores.

## Links
Full record: docs/design/adr-0020-connector-encryption-at-rest.md · Narrows: ADR 0019 · Canary test: `apps/connector-server/test/c3-property.test.ts`
