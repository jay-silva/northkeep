# ADR 0021: Mobile crypto providers (platform-mobile adapters + Node byte-exact proof)

- **Date:** 2026-07-16
- **Status:** Proposed. NOT trusted for real vaults until (1) the invariant-#3
  adversarial review of the full mobile key-handling surface passes and (2) the
  on-device spike run confirms the real React Native bindings match their Node
  stand-ins byte-for-byte on Jay's iPhone.
- **Deciders:** Jay, Claude Code

## Context

ADR 0018 landed the platform seam: `@northkeep/core` talks to crypto, SQLite,
and storage through interfaces, and `@northkeep/platform-node` is the desktop
reference implementation. This ADR covers the second implementation:
`@northkeep/platform-mobile`, the React Native / Expo adapter set for Track M
of the mobile launch plan. Every primitive, parameter, and byte format is fixed
by the desktop vault (.nkv) format; any drift produces vaults one platform
cannot open, or a different derived key. CLAUDE.md invariant #3 governs all of
it: libsodium primitives only, and key-handling changes require an explicit
adversarial-review session before merge.

The hard constraint is that React Native code cannot run in this repo's Node
toolchain, so correctness has to be argued two ways: (a) the adapter code
follows the platform-node reference exactly, and (b) everything that CAN run in
Node is proven byte-identical to platform-node using the same wasm stand-ins
that passed the Week-1 spikes against a real desktop vault.

## Decision

### Libraries (device runtime)

| Seam | Desktop (platform-node) | Mobile (platform-mobile) |
| --- | --- | --- |
| AEAD, BLAKE2b, random | sodium-native | react-native-libsodium (JSI, libsodium-wrappers-compatible API) |
| Argon2id KDF | sodium-native crypto_pwhash | react-native-quick-crypto argon2Sync (node:crypto-compatible API) |
| SQLite image | better-sqlite3 | expo-sqlite (deserializeDatabaseSync / serializeSync) |
| Vault file | node:fs (temp + fsync + rename + .bak) | expo-file-system File API (tmp write, .bak copy, move) |
| Device secret | ~/.northkeep/device.secret (0600 file) | expo-secure-store, WHEN_UNLOCKED_THIS_DEVICE_ONLY (iOS Keychain / Android Keystore, never iCloud-synced) |

These are declared in `packages/platform-mobile/package.json` under an
informational `northkeepDevicePeers` field rather than `peerDependencies`,
because pnpm's autoInstallPeers would otherwise pull the entire React Native /
Expo native tree into the desktop monorepo install (react-native-libsodium's
install script cannot even run here). The future `apps/mobile` package declares
the real versions. Compilation inside this repo is decoupled through local
ambient type declarations (`src/rn-modules.d.ts`), the same pattern
platform-node uses for sodium-native.

### Argon2id via quick-crypto: the mapping and the risk

The RN libsodium binding does not expose `crypto_pwhash` (the launch plan's
fallback ladder, "PR crypto_pwhash into serenity-kit", exists precisely because
of this), so the KDF runs on react-native-quick-crypto instead. quick-crypto
tracks the node:crypto API, which gained `argon2Sync` in Node 24 (OpenSSL 3.2).
The adapter translates sodium `crypto_pwhash(ALG_ARGON2ID13)` inputs into
generic Argon2id parameters in one pure function
(`src/argon2.ts, argon2ParamsFromSodium`):

- t_cost (passes) = opslimit
- m_cost (memory, KiB) = floor(memlimit / 1024), the same floor libsodium
  applies to non-multiples
- parallelism = 1 (always, in libsodium's Argon2)
- version = 0x13 (Argon2id v1.3), tag length = 32 bytes, salt = 16 bytes

This mapping is proven byte-exact in Node (below). The residual risk is the
binding itself: react-native-quick-crypto's argon2Sync surface and semantics
are asserted by our local type declaration and by the node:crypto contract it
tracks, but the actual native call has never executed in this repo. If the
installed quick-crypto version diverges from the node:crypto shape, the wrapper
in `src/native.ts` is the single file that adapts, and the on-device spike will
catch it. Secondary risk: OpenSSL Argon2 vs libsodium Argon2 could disagree on
some parameter edge; mitigated by testing the production MODERATE parameters,
the INTERACTIVE parameters, and a deliberately odd (non-multiple-of-1024)
memlimit against sodium-native.

Documented hardening losses versus desktop (carried over from ADR 0018): no
sodium_malloc guarded memory on RN, so the KDF output and master key live in
plain buffers, and secureZero is a best-effort fill(0) rather than
sodium_memzero.

### Buffer polyfill (device runtime requirement)

The CryptoProvider and VaultStorage contracts mandate Node `Buffer` returns, and
the adapters produce them (`src/crypto.ts`, `src/storage.ts`,
`src/device-secret-format.ts`). Hermes provides no global `Buffer`, so the
consuming `apps/mobile` MUST install a Buffer polyfill (the one
react-native-quick-crypto ships, or `@craftzdog/react-native-buffer`) and
register it globally in the Metro entry before constructing the platform.
Omitting it fails immediately on device. This is recorded in the
`northkeepDevicePeers` block of the package manifest as well.

### Byte-exact proof method (Node-runnable, the deliverable)

`packages/platform-mobile/test/byte-exact.test.ts` runs under the repo's normal
Vitest unit suite (`pnpm test`). The RN native modules are replaced by the same
stand-ins the Week-1 spikes used, chosen because each shares its API shape with
the device binding:

- libsodium-wrappers-sumo (wasm libsodium) stands in for react-native-libsodium
  through the `SodiumApi` seam. This is the SAME libsodium C source compiled to
  wasm, so the BLAKE2b/AEAD legs prove argument-order, plumbing, and build
  equality (the realistic failure mode) rather than cross-implementation
  agreement. It is also the documented Hermes fallback rung.
- node:crypto.argon2Sync (OpenSSL 3.2 Argon2) stands in for
  react-native-quick-crypto through the same `createNodeCryptoArgon2id` wrapper
  factory the device uses, so the exact mapping code that will run on the phone
  is what gets tested. This is a truly INDEPENDENT implementation of Argon2id
  (OpenSSL, not libsodium), so the KDF-mapping legs prove genuine
  cross-implementation byte agreement.
- sql.js (a third, independent SQLite build) stands in for expo-sqlite to
  exercise the whole-file image contract.

All assertions are on raw bytes against `@northkeep/platform-node`
(sodium-native + better-sqlite3), the reference desktop adapter.

**Node version and CI.** node:crypto.argon2Sync requires Node >= 24.7. The repo
CI currently runs Node 20, so the suite is written to DEGRADE, not fail, there:
the five react-native-quick-crypto MAPPING assertions skip with a loud
console warning, while the KDF byte-exactness and the full vault pipeline
(master-key derivation, .nkv decrypt, sql.js row-equality, image round-trip,
mobile write reopened on desktop) still run in CI on a wasm-libsodium
crypto_pwhash fallback provider that is itself proven byte-exact to
sodium-native. On Node >= 24.7 (the developer machine that produced these
results) all 30 tests run; on Node 20 CI, 25 run and 5 skip. The
graceful-skip path was verified by forcing the argon2-absent branch: the suite
went green with 5 skips, never red.

### Results (2026-07-16, 30 tests; 30 pass on Node >= 24.7, 25 pass + 5 skip on Node 20)

1. **Argon2id KDF: byte-identical.** The quick-crypto-shaped wrapper matches
   sodium-native crypto_pwhash for INTERACTIVE (ops 2 / 64 MiB), MODERATE
   (ops 3 / 256 MiB, the production vault default), and an odd memlimit that
   exercises the KiB floor. The wasm sumo crypto_pwhash also matches (fallback
   rung). Out-of-contract inputs (short salt, ops < 1, mem < 8192) are refused.
2. **Master key: byte-identical.** Keyed and unkeyed BLAKE2b-256 match
   sodium-native; `deriveMasterKey` (Argon2id then keyed BLAKE2b with the
   device secret) yields the identical 32-byte master key through the mobile
   provider; the nk-sync-account-v1 / nk-sync-token-v1 credential derivations
   match desktop.
3. **AEAD: byte-identical.** XChaCha20-Poly1305 with the 52-byte .nkv header as
   AAD round-trips desktop-to-mobile and mobile-to-desktop; ciphertext is
   byte-identical given the same nonce; tampered ciphertext, wrong key, and
   wrong AAD all throw.
4. **.nkv image: full loop.** The mobile adapter logic alone (header parse,
   mobile deriveMasterKey, mobile AEAD decrypt) opens a desktop-created vault;
   sql.js reads rows identical to better-sqlite3; the unmodified deserialize
   then serialize round trip is byte-stable; and a mobile-side write (new entry
   hashed with the mobile provider, chain head advanced, re-encrypted with a
   fresh nonce) reopens on desktop with `verifyChain()` ok. This replicates the
   Spike 1 acceptance in-process. The pipeline runs on the wasm-KDF provider so
   it executes in CI on every Node; on Node >= 24.7 a gated test additionally
   confirms the quick-crypto KDF path decrypts the same vault to identical bytes.

No primitive is left unproven: every CryptoProvider primitive and the image
contract is proven byte-exact against sodium-native + better-sqlite3 in Node.
The only conditional coverage is the react-native-quick-crypto MAPPING leg,
which needs node:crypto.argon2Sync (Node >= 24.7); when absent, the identical
KDF output is still proven via the wasm-libsodium fallback, so the byte-exact
guarantee holds on every supported Node.

### What is NOT proven here

- The React Native bindings themselves (react-native-libsodium,
  react-native-quick-crypto, expo-sqlite, expo-file-system, expo-secure-store)
  have never executed in this repo. `src/native.ts`, `src/sqlite.ts`,
  `src/storage.ts`, and `src/device-secret.ts` are import glue over the proven
  logic, written against locally declared API shapes. The M6-0 on-device spike
  on Jay's iPhone must confirm the same byte vectors on device before this
  package touches a real vault.
- expo-file-system exposes no fsync AND no overwrite-rename, so the atomic-save
  dance (tmp write, .bak copy, delete target, move tmp into place) is NOT atomic:
  a crash in the window between deleting the target and completing the move
  leaves NO file at the canonical path (the previous vault is intact at `.bak`,
  the new one at `.tmp`). The failure mode is "no vault at path" (recoverable),
  never a torn/corrupt vault, but core does not read `.bak`, so `apps/mobile`
  MUST implement recovery-on-open (prefer `.tmp`, else `.bak`). Power-loss
  durability is also weaker than desktop (no fsync). Both must be assessed in
  the adversarial review.
- The expo-sqlite SqliteDb/SqliteStatement wrapper (`src/sqlite.ts`: get()
  null-to-undefined, lastInsertRowId-to-lastInsertRowid, transaction wrapper,
  pragma) has no Node coverage because sql.js is used directly for the image
  tests. The `@`-prefixed named-param translation is proven to bind correctly
  against a real SQLite engine (sql.js), but that expo actually wants the `@`
  prefix (versus `:` or bare keys) is only asserted against the documented expo
  API shape and must be confirmed on device.
- Unlock time and peak Argon2id memory on device (MODERATE is 256 MiB) remain
  unmeasured; the spike plan's fallback ladder applies if the phone cannot
  afford it.

## Required before this is trusted for real vaults

1. A FULL invariant-#3 adversarial review session of the mobile key-handling
   surface (this package plus the future apps/mobile unlock and QR-link flows).
2. On-device validation: the M6-0 spike vectors (Argon2id, keyed BLAKE2b, AEAD
   against a desktop-generated .nkv, expo-sqlite image round trip) executed on
   real hardware with the real bindings, matching the Node results exactly.
3. A crash-safe save story: `apps/mobile` implements recovery-on-open for the
   non-atomic writeAtomic window (prefer `.tmp`, else `.bak`), and the
   adversarial review signs off on the reduced durability versus desktop.
4. The Buffer polyfill wired into the Metro entry (see above), verified on device.

Until items 1 and 2 are done, the Status above stays Proposed and nothing ships
against a vault that holds real memories; items 3 and 4 are prerequisites for
the apps/mobile integration that follows.
