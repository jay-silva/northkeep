# ADR 0018 — Platform seam (mobile crypto / SQLite / storage adapters)

- **Date:** 2026-07-15
- **Status:** Accepted (invariant-#3 adversarial review passed after two fixes)
- **Deciders:** Jay (wants a native mobile NorthKeep app that opens the same
  encrypted vaults), Claude Code

## Context

The mobile app (Track M of the mobile launch plan) must run the vault, crypto,
and sync logic on a React Native runtime that has no `sodium-native` and no
`better-sqlite3` — while opening and writing the exact same `.nkv` vault files
as the desktop. A Week-1 spike proved, byte-for-byte, that wasm/native mobile
libraries reproduce the desktop crypto and round-trip the SQLite image (see
`../../07-MOBILE-LAUNCH-PLAN.md` "Week-1 spike results"). What remained was to
let `@northkeep/core` depend on those operations through an interface, so a
mobile adapter can be swapped in without forking the security-critical code.

The refactor touches key handling, so CLAUDE.md invariant #3 (libsodium-only, no
hand-rolled crypto, "key handling changes require an explicit adversarial-review
session before merge") governs it. Byte-exactness is non-negotiable: any drift
would produce vaults one platform cannot open, or a different derived key.

## Decision

Introduce a **Platform seam**: `@northkeep/core` defines three interfaces and a
registration point; concrete adapters live in separate packages.

- **Interfaces (in core):**
  - `CryptoProvider` — Argon2id pwhash (ALG_ARGON2ID13, header opslimit/memlimit,
    16-byte salt -> 32B), keyed and unkeyed BLAKE2b-256 generichash, XChaCha20-
    Poly1305-IETF aead encrypt/decrypt (header as AAD), random bytes, secure-zero.
    Exact same primitives and parameters as before — the interface only relocates
    the call site.
  - `SqliteDriver` — synchronous, mirroring `better-sqlite3`: open-from-image
    (deserialize), create-empty, serialize-to-bytes, prepare/exec/run/get/all/
    transaction/pragma. Synchronous on purpose so `vault.ts` is unchanged and the
    mobile adapter (expo-sqlite) implements the same shape.
  - `VaultStorage` — read the raw `.nkv` bytes and write them atomically
    (temp + fsync + rename + `.bak`, as `vault.ts save()` did).
  - A `Platform` bundles the three: `{ crypto, sqlite, storage }`.
- **Dependency injection (`platform-context.ts`):** core holds a module-level
  default and exposes `setPlatform(p)` / `getPlatform()`. **core never imports a
  concrete provider** (that would be circular — providers import core for the
  types). `getPlatform()` **throws** when unset (fail-closed). Each application
  ENTRY POINT registers the platform exactly once at startup:
  `packages/cli` bin, `apps/web` `startUiServer`, `packages/mcp-server`
  `startServer` -> `setPlatform(nodePlatform())`; tests via a shared Vitest setup;
  `apps/mobile` (future) -> `setPlatform(mobilePlatform())`.
- **`@northkeep/platform-node`** implements all three with `sodium-native`,
  `better-sqlite3`, and `node:fs`. It preserves today's hardening: the Node
  `CryptoProvider` still uses `sodium_malloc` guarded memory and `sodium_memzero`
  for the password key and master key. `sodium-native.d.ts` moved here; core no
  longer runtime-imports `sodium-native` or `better-sqlite3`.
- `packages/sync` `creds.ts` routes its keyed-BLAKE2b through the same
  `CryptoProvider` so mobile reuses it; output is byte-identical.

## Deliberate boundaries (not yet abstracted)

- **`device.secret` file I/O stays Node-specific.** `core/platform.ts`
  (`ensureDeviceSecret`/`loadDeviceSecret`, the `~/.northkeep` home, the call log
  path) still uses `node:fs`/`os`. Mobile does NOT reuse this: the device secret
  reaches the phone by QR and lives in the OS keychain/keystore, and paths are
  app-sandbox specific — that is ADR 0019 (device linking & mobile secret
  storage), out of scope here. So the mobile app supplies the 32-byte device
  secret and vault bytes directly rather than through these helpers.
- **The advisory file lock (`lock.ts`)** stays Node-only for now; a single-process
  mobile app does not need cross-process locking.
- **Guarded memory (`sodium_malloc`)** is preserved on Node but will be lost on
  mobile (wasm libsodium has no guarded allocation). This is hardening, not
  correctness; documented as an accepted mobile limitation (KNOWN-LIMITS on the
  mobile build).

## Alternatives considered

- **Tauri mobile with a Rust rewrite of core** — forfeits the entire pure-TS
  reuse and forks security-critical code into a second implementation a solo
  founder must keep byte-identical. Rejected (see the mobile plan).
- **Conditional imports / platform `#ifdef` inside core** — leaks both native
  deps into core and makes the mobile build pull `sodium-native`. Rejected.
- **The seam (chosen)** — one interface, core stays native-free, adapters are
  swappable and independently testable.

## Consequences

- `@northkeep/core` is mobile-portable: it compiles and runs without the
  Node-native modules. The mobile port (`platform-mobile`) implements the same
  three interfaces with react-native-libsodium + react-native-quick-crypto
  (Argon2id) + expo-sqlite + expo-file-system.
- Every entry point MUST call `setPlatform()` before touching a vault; a missed
  call fails loudly (throw), not silently. Entry points enumerated above.
- Verified: `pnpm build` clean, 307 unit + 83 e2e pass, the redaction leak gate
  reports zero misses, and the crypto tests + provenance-chain verification pass
  unchanged — i.e. the `.nkv` format, key derivation, hash chain, and sync creds
  are byte-identical.

## Adversarial review record (invariant #3)

An adversarial review focused on byte-exactness and key hygiene. Byte-exactness
was certified clean: the keyed-BLAKE2b argument order (message = Argon2id output,
key = device secret) was NOT inverted through the indirection, nonce/salt slicing
and the 52-byte-header AAD are unchanged, `buf()` never re-copies bytes, and the
libsodium cost constants are inlined as literals in core with
`@northkeep/platform-node` asserting at startup that they still match the linked
libsodium. All three production entry points (cli, `startUiServer`, `startServer`)
register the platform before any vault op; a grep confirmed no module-scope crypto
call runs before setup, so the Vitest setup hides no production gap. Findings found
and fixed:

1. **HIGH — master key lost `sodium_malloc` guarding.** The refactor derived the
   master key via the plain-buffer `generichash` (correct for the hash-chain hot
   loop, but the master key is held for the whole unlock session and the original
   allocated it with `sodium_malloc`). Fixed by adding a dedicated
   `generichashSecure(message, key)` to `CryptoProvider` — guarded (sodium_malloc)
   on Node, called once per unlock — and pointing `deriveMasterKey` at it. Output
   is byte-identical; **re-verified by an independent wasm decrypt of a vault made
   by the fixed code.** So the ADR's guarded-memory guarantee (§ Decision) now
   holds.
2. **Passphrase not zeroed on KDF failure** (`deriveMasterKey`). The passphrase
   buffer was outside the try, so a `pwhash()` throw (Argon2id OOM) skipped the
   `finally`. Fixed: buffer created before the try; both it and the password key
   zeroed in a single `finally` covering `pwhash`.
3. **`server.ts` committed with raw control bytes.** The provider-sanitization
   regex `/[\0-\037,"]/g` was written with literal NUL..0x1F bytes (pre-existing in
   HEAD), which made git treat the file as binary and defeated review. Rewritten
   with escaped hex `/[\x00-\x1f,"]/g` — identical runtime behavior, now clean text.

LOW (noted, not fixed — no production path triggers it): `createServer()` is
exported without registering a platform; a consumer embedding it directly (not via
`startServer` or a test setup) would hit the fail-closed throw. INFO: the desktop
bundle's `server-tree/` is regenerated from `apps/web` at build time, so a clean
desktop rebuild carries the fix; do not ship from a stale on-disk copy.

Post-fix: `pnpm build` clean, 307 unit + 83 e2e pass, leak gate zero misses,
standalone MCP-server runtime check passes, and the guarded-key vault decrypts
under an independent wasm implementation. Verdict: **GO.**
