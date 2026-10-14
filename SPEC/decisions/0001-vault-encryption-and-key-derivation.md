# ADR 0001: Vault encryption and key derivation

Status: Accepted 2026-07-04 (M0) · Review: adversarial review 2026-07-04 before acceptance, no critical findings; fixes listed below

## Context
M0 needs an encrypted vault where no plaintext of any kind (content, scope labels, timestamps) is readable from the file, only libsodium primitives are used (invariant #3), and a stolen vault file is useless without secrets the attacker does not have.

## Decision
- D1: Whole-file encryption of an in-memory SQLite image. Open: decrypt, then `new Database(buffer)`. Save: `db.serialize()`, encrypt with a fresh nonce, write a temp file, fsync, atomic rename, keep the previous file as `.bak`.
- D2: File format `[ magic "NKV1" | salt 16B | opslimit u32LE | memlimit u32LE | nonce 24B | ciphertext ]`. The whole header is AEAD associated data, so header tampering fails authentication. KDF parameters are read from the file, so old vaults keep opening if defaults change.
- D3: Two-secret key derivation (1Password Secret-Key pattern): `password_key = Argon2id(passphrase, salt, MODERATE)` via `crypto_pwhash`; `master_key = BLAKE2b-256(password_key, key = device_secret)` via keyed `crypto_generichash`. `device_secret` is 32 random bytes made at `init`, stored as hex at `~/.northkeep/device.secret`, mode 0600, never overwritten.
- D4: Hash chain inside the ciphertext: `entry_hash = BLAKE2b-256(canonical_json(entry minus entry_hash))`, linked by `prev_hash` from a genesis of 64 zeros, head in `vault_meta`. Hashes live only inside the encrypted payload and in exports.
- D5: Any change to `packages/core/src/crypto.ts` or the `vault.ts` save/open paths needs an adversarial review before merge.
- Review fixes: KDF parameters from the unauthenticated header are bounds-checked before any Argon2id work; canonical JSON pins Unicode NFC and ECMAScript number rendering; metadata is hashed in storage form; device-secret creation is exclusive (`wx`); the vault directory is fsynced after rename.

## Consequences
- Easier: a stolen file plus a weak passphrase is not enough; the 256-bit device secret is also required.
- Harder: the whole file is rewritten per save (measured CLI calls about 0.4s including Argon2id). The decrypted database is memory-resident while a command runs. A crash loses only unsaved writes.
- Limits: losing the device secret file loses the vault, with no recovery; `init` prints a loud backup warning. The hash chain is unkeyed and does not stop a chain-aware forger. `.bak` retains the previous encrypted state (see KNOWN-LIMITS.md).

## Rejected
- Per-row or per-field encryption: leaks scope labels, timestamps and per-type counts.
- SQLite3MultipleCiphers / SQLCipher: a second crypto stack and heavier native dependency; revisit if vaults outgrow memory.
- Passphrase only: stolen file plus weak passphrase is crackable offline.
- XOR of the two keys: keyed BLAKE2b gives the same property with a standard primitive.

## What leaves the machine
The original names no egress path. The dependencies it introduced (`better-sqlite3`, `sodium-native`, `commander`) do no network I/O; invariant #7 not triggered. Sync (M5) is named as the later feature that carries the device secret to other machines.

## Links
Full record: docs/design/adr-0001-vault-encryption-and-key-derivation.md
