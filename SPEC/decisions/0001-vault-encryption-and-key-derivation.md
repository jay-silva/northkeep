# ADR 0001 — Vault encryption and key derivation

- **Date:** 2026-07-04
- **Status:** Accepted (M0)
- **Deciders:** Jay (approved the M0 plan), Claude Code

## Context

M0 requires an encrypted vault where (a) no plaintext of any kind — content,
scope labels, timestamps — is readable from the file, (b) only libsodium
primitives are used (CLAUDE.md invariant #3), and (c) a stolen vault file is
useless without secrets the attacker doesn't have.

## Decision 1: Whole-file encryption over an in-memory SQLite image

The vault file is a single sodium-encrypted blob of the serialized SQLite
database. On open: decrypt → `new Database(buffer)` (better-sqlite3 in-memory
restore). On save: `db.serialize()` → encrypt with a fresh nonce → write temp
file → fsync → atomic rename, keeping the previous file as `.bak`.

Format: `[ magic "NKV1" | salt 16B | opslimit u32LE | memlimit u32LE | nonce 24B | ciphertext ]`,
with the whole header as AEAD associated data, so header tampering also fails
authentication. KDF parameters are read from the file, so old vaults keep
opening if defaults change later.

**Alternatives rejected:**
- *Per-row/field encryption:* leaks metadata (scope labels like `client:x`,
  timestamps, entry counts per type) — unacceptable for the professional story.
- *SQLite3MultipleCiphers / SQLCipher builds:* transparent page-level
  encryption, better for very large vaults, but adds a second crypto stack
  beside libsodium and a heavier native dependency. Revisit if vaults outgrow
  memory (noted in KNOWN-LIMITS.md); the file format version byte in the magic
  gives us a migration path.

**Consequences:** whole file rewritten per save (fine at personal scale;
XChaCha20 runs at GB/s — measured e2e CLI calls complete in ~0.4s including
Argon2id); the decrypted database is memory-resident while a command runs;
a crash between saves loses only unsaved writes (the CLI saves after every
mutation).

## Decision 2: Two-secret key derivation (1Password Secret-Key pattern)

```
password_key = Argon2id(passphrase, salt, MODERATE)      # crypto_pwhash
master_key   = BLAKE2b-256(password_key, key = device_secret)  # crypto_generichash, keyed
```

- `salt`: 16 random bytes, stored in the vault header (public by design).
- `device_secret`: 32 random bytes, generated at `init`, stored as hex at
  `~/.northkeep/device.secret`, mode 0600, never overwritten once created.
- Composition is a keyed hash of two independently derived secrets — both are
  required, and offline brute-force of the passphrase against a stolen vault
  file is pointless without the 256-bit device secret.

**Alternatives rejected:**
- *Passphrase only:* a stolen file + weak passphrase = crackable offline.
- *XOR of the two keys (as sketched in the blueprint):* keyed BLAKE2b achieves
  the same two-secret property with a standard primitive and no bespoke
  bit-mixing; this is the "no hand-rolled crypto" reading of the same intent.

**Consequences (Jay-visible):** losing the device secret file loses the vault
— there is no recovery. `init` prints a loud backup warning. Sync (M5) is the
feature that carries the secret to other machines.

## Decision 3: Hash chain inside the ciphertext

`entry_hash = BLAKE2b-256(canonical_json(entry minus entry_hash))`, linked via
`prev_hash` from a genesis of 64 zeros; head stored in `vault_meta`. Hashes
live inside the encrypted payload and in exports only — never exposed beside
anything an attacker could dictionary-test.

## Review requirement

Per CLAUDE.md invariant #3, any change to this module
(`packages/core/src/crypto.ts`, `vault.ts` save/open paths) requires an
adversarial review session before merge.

The M0 implementation received one (2026-07-04) before this ADR was accepted.
Outcome: AEAD construction, two-secret derivation, and atomic save confirmed
sound; no critical findings. Fixed from the review: KDF parameters from the
unauthenticated header are now bounds-checked before any Argon2id work
(pre-auth DoS); canonical JSON pins Unicode NFC and ECMAScript number
rendering; metadata is hashed in its storage form; device-secret creation is
exclusive (`wx`); the vault directory is fsynced after rename. Documented
honestly rather than fixed (by design): the hash chain is unkeyed and does
not stop a chain-aware forger; `.bak` retains the previous encrypted state
(see KNOWN-LIMITS.md).

## Dependencies introduced

`better-sqlite3`, `sodium-native` (native, no network access),
`commander` (CLI parsing, no network access). No dependency in this repo
performs network I/O; invariant #7 not triggered.
