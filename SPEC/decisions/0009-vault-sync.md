# ADR 0009 — Encrypted vault sync (ciphertext-only server)

- **Date:** 2026-07-07
- **Status:** Accepted (M5)
- **Deciders:** Jay (product owner; chose sync-now / billing-later and Vercel+Neon hosting), Claude Code

## Context

M5 makes the vault follow the user to a second machine. The blueprint's
acceptance test: *"Second machine, same passphrase + secret key → vault
appears; our server storage inspected = ciphertext only."* Invariant #2 is the
hard constraint: **the sync server stores ciphertext + version numbers only** —
no plaintext, no derived plaintext, no server-side embeddings or content logs.

Jay's scope decisions: build **sync end-to-end now, defer Stripe billing** to a
later milestone (M5b); deploy a **real managed service now on Vercel + Neon
Postgres**. So this milestone's service is open (no paywall) with abuse guards
instead.

## Decision 1: The vault syncs as its own opaque blob — no re-encryption

The `.nkv` file is already a single self-contained XChaCha20-Poly1305 blob
(ADR 0001): magic + salt + KDF params + nonce + AEAD ciphertext of the SQLite
image, with `master_key = f(passphrase, device_secret, salt-from-header)` and
**no per-machine entropy**. So sync is a **blob + version exchange**: push the
raw bytes, pull the raw bytes. A second machine with the same passphrase +
`device.secret` derives the identical key and opens the pulled blob. The
server never re-encrypts, never sees a key, and **no vault format change was
needed**.

## Decision 2: Zero-knowledge, no signup — the account is the device secret

There is no email/password/account system. Credentials derive entirely from
the 256-bit `device.secret` the two-secret model already treats as a recovery
key:

```
accountId = keyed-BLAKE2b(device_secret, "nk-sync-account-v1")   // public label
token     = keyed-BLAKE2b(device_secret, "nk-sync-token-v1")     // bearer secret
```

Distinct domain-separation labels; both one-way (the server cannot recover the
device secret from either). The server keys storage on `sha256(token)` and
stores only that hash — a DB leak reveals hashes, and even the token itself
decrypts nothing (the master key also needs the passphrase). No PII ever
reaches the server. A second machine with the same `device.secret` derives the
same pair and finds the vault. Honest limit: whoever holds `device.secret` can
push/pull the (undecryptable) blob — it's the account root, guarded like a
recovery key and transported out-of-band.

## Decision 3: Optimistic concurrency — server-authoritative version, client sidecar

The server owns a monotonic `version`; the client records the last-synced
version in a plaintext sidecar (`~/.northkeep/sync.json`, 0600, no secrets).
`PUT` sends `X-Base-Version`; the server does an atomic conditional write
(`INSERT ... ON CONFLICT DO NOTHING` for the first blob, `UPDATE ... WHERE
version = $base` thereafter) and returns **409 + current version** on a
mismatch. The client then pulls before pushing. The vault header was **not**
touched — `chain_head` and file hashes are both unsuitable as version tokens
(`forget()` doesn't advance the head; every save re-nonces the ciphertext).
Conflict resolution is **whole-vault last-writer-wins**: pull replaces local
(the prior state is kept as `.nkv.bak`); per-entry/CRDT merge is future work.

## Decision 4: Pull must never destroy a good local vault

A download is verified structurally (NKV1 magic + length) and by transport
`sha256`, written to a temp file, and — when a local vault already exists —
**proven to open with the caller's master key before it replaces the local
file** (the old vault becomes `.nkv.bak`). A corrupt download or a malicious
server serving garbage is thus rejected without harming the existing vault. A
fresh machine (no local vault) has nothing to protect, so the verified blob is
written directly and opened with the passphrase afterward.

## Decision 5: HTTPS-only, and the server is dumb by design

The client refuses a non-`https` sync URL unless it is loopback (tests /
self-host on the same box). All client fetches use `redirect:'error'` +
`AbortSignal.timeout` and throw status-only errors (converse conventions). The
server (`apps/sync-server`) is framework-agnostic `handleSync` logic over a
`Storage` interface — `InMemoryStorage` for tests/self-host, `NeonStorage`
(Postgres, ciphertext stored base64) for production — wrapped by a plain
`node:http` server (self-hostable) and a thin Vercel function adapter. It
stores only ciphertext + version + hashes, rejects non-NKV1 bodies (won't be
free storage), caps blobs at ~4 MB (v1; Vercel Blob is the scale path for
embedding-heavy vaults), and never logs blob content.

## Consequences & honest limits (KNOWN-LIMITS.md)

- **Open service until billing (M5b).** No paywall this milestone; access is
  gated only by the device-secret-derived token, plus a size cap and reliance
  on the platform's rate limiting.
- **Bounded, not zero, trust in the host.** Ciphertext + hashes live in Neon
  (a subprocessor); it's opaque, but the data resides on managed infra. The
  design is self-hostable for anyone who wants full custody.
- **Whole-vault last-writer-wins**; the overwritten side is preserved as
  `.nkv.bak`, not merged.
- **`device.secret` must be transported out-of-band** to a second machine
  (copy the file); losing it still loses the vault (ADR 0001) — sync is not a
  recovery service.

## Dependencies introduced (invariant #7 — Jay approved)

- `@northkeep/sync` (client): `sodium-native` (already in the tree) for the
  keyed-BLAKE2b derivation. No network dependency — raw `fetch`.
- `@northkeep/sync-server`: `@neondatabase/serverless` (server-side only) and
  the Vercel platform as the deploy target.

## Adversarial review (2026-07-07)

Highest-stakes review yet (crypto + network + the first public service), with
empirical proofs against the built code. **No CRITICAL or HIGH findings.** The
three load-bearing properties were verified:

1. **The server never gets plaintext or keys, and cannot be made to.** Clients
   transmit only the opaque `.nkv` blob and the one-way-derived token;
   passphrase/master-key/device-secret never leave the machine; storage and
   logs hold ciphertext + hashes + versions only. No `console.*` logs a
   blob/token/key/`DATABASE_URL`.
2. **No path corrupts or destroys a good local vault.** Pull open-verifies the
   download with the caller's key BEFORE the `.bak` copy and the rename-swap,
   fails closed without a key, and leaves the local file intact on any error or
   mid-operation crash (temp cleaned in `finally`, whole op under the file
   lock). A stolen token can at worst overwrite the undecryptable server copy.
3. **Account isolation holds** — storage keyed on `sha256(token)` with distinct
   256-bit tokens; cross-account access needs a hash collision.
4. **No token/key/secret/DB-URL leaks** into any log, response, config file, or
   error path.

**Fixed from the review:**
- **Abuse gate (was MEDIUM-1).** The `NKV1` body check is a sanity check, NOT
  abuse protection — the server can't read ciphertext, so a forged `NKV1` blob
  is indistinguishable from a real one, and an attacker could mint unlimited
  device-secret-derived tokens and upload junk to an open service. Added an
  optional **token allowlist** (`NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES`, a set of
  `sha256(token)` hashes): when set, the server serves only those accounts —
  the way to run a **private** server until billing (M5b). `northkeep sync id`
  prints the user's allowlist hash. Misleading comments corrected (the magic
  check is not constant-time-meaningful; the transport sha256 is honest-
  corruption detection, not a defense against a hostile server — open-verify
  is).

**Accepted, documented, not fixed (within the ADR's stated limits):**
- Without the allowlist the service is **open** — abuse protection is then the
  size cap + the host's platform rate limiting, resolved properly by billing
  (M5b). Do not expose an open (no-allowlist) server publicly.
- The transport sha256 is not a security control; the fresh-machine path has no
  cryptographic gate before the first passphrase open (nothing to protect —
  there is no local vault to lose).
- Pull is whole-vault last-writer-wins with no "you are ahead" guard: pulling
  on a machine with unpushed local edits overwrites them (recoverable from
  `.nkv.bak`). Guidance: push before you pull on a machine you've edited.
- The web GUI's generic 500 handler reflects `err.message` to the same-origin
  localhost page (pre-existing across all routes); every sync error path was
  traced and carries no secret.
