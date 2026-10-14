# ADR 0023: Mobile crypto providers (platform-mobile adapters + Node byte-exact proof)

Status: Accepted (shipped in the iOS app), dated 2026-07-16; status corrected 2026-07-25 from a stale "Proposed" · Review: open contradiction: the record's body still says the status "stays Proposed" until a full invariant-#3 adversarial review of mobile key handling passes and the on-device spike matches Node byte-for-byte on Jay's iPhone; the record does not log either outcome

## Context
ADR 0018 put crypto, SQLite and storage behind interfaces in `@northkeep/core`, with `@northkeep/platform-node` as the desktop reference. This ADR is the second implementation, `@northkeep/platform-mobile` (React Native / Expo). Every primitive, parameter and byte format is fixed by the desktop `.nkv` format, and React Native cannot run in this repo's Node toolchain, so correctness is argued by following platform-node exactly and proving in Node everything that can run there.

## Decision
- D1: Libraries: react-native-libsodium (AEAD, BLAKE2b, random); react-native-quick-crypto `argon2Sync` (Argon2id); expo-sqlite (image); expo-file-system (vault file); expo-secure-store with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (device secret, never iCloud-synced). Declared under `northkeepDevicePeers`, not `peerDependencies`, so the desktop install does not pull the RN tree.
- D2: `argon2ParamsFromSodium` (`src/argon2.ts`) maps sodium `crypto_pwhash` to Argon2id: t_cost = opslimit, m_cost = floor(memlimit / 1024) KiB, parallelism 1, version 0x13, 32-byte tag, 16-byte salt.
- D3: `apps/mobile` must register a global Buffer polyfill in the Metro entry; Hermes has none.
- D4: `packages/platform-mobile/test/byte-exact.test.ts` proves byte equality against sodium-native + better-sqlite3 using stand-ins: libsodium-wrappers-sumo (same libsodium source), node:crypto `argon2Sync` (independent OpenSSL Argon2id) and sql.js. 30 tests: all pass on Node >= 24.7; on Node 20 CI, 25 pass and the 5 quick-crypto mapping tests skip loudly, with KDF output still proven via the wasm fallback.

## Consequences
- Easier: Argon2id (INTERACTIVE, MODERATE, odd memlimit), master key, BLAKE2b, sync credentials, XChaCha20-Poly1305 with the 52-byte header as AAD, and the full `.nkv` loop (mobile write reopened on desktop, `verifyChain()` ok) are byte-identical in Node.
- Limits, not proven here: the RN bindings never executed in this repo; `src/sqlite.ts` wrapper and expo's `@` param prefix are unverified in Node; device unlock time and 256 MiB peak memory unmeasured.
- Limits, hardening losses: no `sodium_malloc` guarded memory, so keys sit in plain buffers; `secureZero` is a best-effort `fill(0)`.
- Limits, durability: expo-file-system has no fsync and no overwrite-rename, so saves are not atomic. A crash can leave no file at the canonical path (old vault at `.bak`, new at `.tmp`), never a torn vault; core does not read `.bak`, so `apps/mobile` must recover on open (prefer `.tmp`, else `.bak`). Power-loss durability is weaker than desktop.
- Committed to, before real vaults: the adversarial review, on-device vectors, recovery-on-open signed off, Buffer polyfill verified on device.

## Rejected
- `crypto_pwhash` from the RN libsodium binding: not exposed.
- Real `peerDependencies`: pnpm autoInstallPeers would pull the native tree into the desktop install.

## What leaves the machine
Not addressed in the original record; see the design file.

## Links
Extends: ADR 0018 · Full record: docs/design/adr-0023-mobile-crypto-providers.md
