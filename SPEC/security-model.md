# Northkeep Security Model — v0.1 (M0 scope)

*Plain-language first, mechanism second. This document grows with each
milestone; sections marked (M1+)…(M5) are placeholders with intent stated.
Honesty about limits is a product feature — see KNOWN-LIMITS.md.*

---

## What we protect against (M0 threat model)

| Threat | Protection |
|---|---|
| Vault file stolen (laptop theft, backup leak, cloud-drive sync) | File is XChaCha20-Poly1305 ciphertext; useless without BOTH the passphrase and the device secret |
| Passphrase guessed offline against a stolen file | Attacker also needs the device secret file — a random 256-bit value that makes offline guessing pointless (1Password Secret-Key pattern) |
| Vault file tampered with | AEAD authentication fails closed: any modified byte makes the vault refuse to open. KDF parameters in the header are bounds-checked before use, so a tampered header cannot demand unbounded Argon2id work (pre-authentication DoS) |
| History silently edited by *naive* tooling with vault access | Per-entry hash chain: edits by tools that don't rebuild the chain are detected on verify/export. The chain is unkeyed — see the limits below for what it does NOT stop |
| Us (Northkeep the company) | Nothing to protect against yet: M0 has no network code at all. The invariant that carries forward: we never see plaintext |

## What we do NOT protect against (stated plainly)

- **Malware on the unlocked machine.** While a command runs, the key and the
  decrypted database exist in process memory. An attacker with code execution
  or root on the user's machine wins. This is true of every local-first tool.
- **A forgotten passphrase or lost device secret.** There is no recovery. This
  is the point: no back door for an attacker means no back door for support.
- **Weak passphrases chosen by the user** — mitigated (Argon2id is slow to
  brute-force, and the device secret must also be stolen) but not eliminated.
- **A chain-aware attacker with write access to the open vault.** The hash
  chain is unkeyed BLAKE2b; anyone who can write the database and knows the
  (open, published) algorithm can recompute every hash and the chain head
  consistently. The chain detects naive edits, not a deliberate forger who
  holds the same access as the user. Real tamper-proofing against a key-holder
  would need a MAC or signature under a key the editor doesn't have — not
  claimed, not in M0.
- **The `.bak` file retains the immediately-previous vault state** (encrypted,
  same keys). Content you delete is only durably gone after a *subsequent*
  save overwrites the backup. See KNOWN-LIMITS.md.
- **Semantic/contextual privacy** (M3+): content-level redaction cannot make
  free text anonymous. We say so in the product.

## Key derivation (M0 — see ADR 0001)

```
password_key = Argon2id( passphrase, salt,
                         opslimit = MODERATE, memlimit = MODERATE )   # libsodium crypto_pwhash
master_key   = BLAKE2b-256( password_key, key = device_secret )       # libsodium crypto_generichash, keyed
```

- `salt`: 16 random bytes, stored in the vault file header (public by design).
- `device_secret`: 32 random bytes generated at `init`, stored at
  `~/.northkeep/device.secret` (mode 0600) as hex. **The user must back it up**;
  init says so loudly.
- Two independent secrets, combined with a keyed hash: a stolen vault file +
  weak passphrase is still not crackable without the device secret; a stolen
  device secret without the passphrase yields nothing.

## Vault file format (`.nkv`)

```
[ magic "NKV1" | salt 16B | opslimit u32LE | memlimit u32LE | nonce 24B | ciphertext ]
```

- Ciphertext = XChaCha20-Poly1305-ietf over the serialized SQLite image, with
  the entire header as AEAD associated data (header tampering ⇒ open fails).
- Fresh random nonce on every save.
- The SQLite database exists only in memory while a command runs. Saves are
  atomic: write `vault.nkv.tmp`, fsync, rename over `vault.nkv`; the previous
  version is kept as `vault.nkv.bak`.
- Key material is zeroed (`sodium_memzero`) when the vault handle is closed.

## Crypto rules (non-negotiable, from CLAUDE.md)

libsodium primitives only, via `sodium-native`. No hand-rolled crypto. Any
change to key handling requires an adversarial review session before merge.

## Roadmap sections

- **(M1) MCP surface:** every retrieval visible in a local call log.
- **(M3) Redaction tiers:** Tier 1 deterministic (always on), Tier 2
  pseudonymization (on-device), Tier 3 explicitly NOT claimed.
- **(M4) Scope enforcement + audit log:** capability-based scope grants per
  conversation; immutable audit export.
- **(M5) Sync:** client-side-encrypted blobs; server stores ciphertext and
  version numbers only.
