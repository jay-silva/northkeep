# ADR 0018: Platform seam (mobile crypto / SQLite / storage adapters)

Status: Accepted 2026-07-15 · Deciders: Jay (wants a native mobile app that opens the same encrypted vaults), Claude Code · Review: invariant #3 adversarial review, verdict GO after fixes

## Context
The mobile app must run vault, crypto and sync logic on React Native, which has no `sodium-native` and no `better-sqlite3`, while opening and writing the exact same `.nkv` files as desktop. A Week-1 spike proved mobile libraries reproduce the desktop crypto byte for byte. The refactor touches key handling, so invariant #3 governs it, and byte-exactness is non-negotiable.

## Decision
- D1: `@northkeep/core` defines three interfaces bundled as a `Platform` `{ crypto, sqlite, storage }`: `CryptoProvider` (Argon2id pwhash, keyed and unkeyed BLAKE2b-256, XChaCha20-Poly1305-IETF with header as AAD, random bytes, secure-zero; same primitives and parameters, only the call site moves), a synchronous `SqliteDriver` mirroring `better-sqlite3`, and `VaultStorage` (atomic write: temp + fsync + rename + `.bak`).
- D2: `platform-context.ts` exposes `setPlatform(p)` / `getPlatform()`. Core never imports a concrete provider. `getPlatform()` throws when unset (fail-closed). Each entry point registers once at startup: `packages/cli` bin, `apps/web` `startUiServer`, `packages/mcp-server` `startServer`; tests via a shared Vitest setup.
- D3: `@northkeep/platform-node` implements all three with `sodium-native`, `better-sqlite3` and `node:fs`, keeping `sodium_malloc` guarded memory and `sodium_memzero` for the password key and master key (via a dedicated `generichashSecure`).
- D4: `packages/sync` `creds.ts` routes its keyed BLAKE2b through `CryptoProvider`; output is byte-identical.
- D5: Not abstracted yet: `device.secret` file I/O and the `~/.northkeep` paths stay Node-specific (mobile secret storage: the record says ADR 0019; it landed as ADR 0024); the advisory file lock `lock.ts` stays Node-only.

## Consequences
- Easier: core runs without Node-native modules; `platform-mobile` implements the same interfaces with react-native-libsodium, react-native-quick-crypto, expo-sqlite and expo-file-system.
- Harder: every entry point must call `setPlatform()` before touching a vault. Exported `createServer()` does not register one, so a direct embedder hits the throw (LOW, not fixed).
- Limits: guarded memory (`sodium_malloc`) is lost on mobile, since wasm libsodium has none; accepted as a documented mobile limitation.
- Verified byte-identical: `.nkv` format, key derivation, hash chain and sync creds (307 unit + 83 e2e pass, leak gate zero misses, guarded-key vault decrypts under an independent wasm implementation).
- Review fixes: master key regained `sodium_malloc` guarding; passphrase and password key now zeroed in one `finally` even if `pwhash()` throws; `server.ts` raw control bytes rewritten as escaped hex.

## Rejected
- Tauri mobile with a Rust rewrite of core: forks security-critical code a solo founder must keep byte-identical.
- Conditional imports inside core: leaks both native deps into core.

## What leaves the machine
The original has no egress section and names no network path; it states the crypto interface only relocates call sites, with the same primitives and parameters.

## Links
Related: ADR 0024 (device linking; the record cites it as 0019), and the mobile launch plan (kept outside this repo)
Full record: docs/design/adr-0018-platform-seam.md
