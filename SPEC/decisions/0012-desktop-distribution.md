# ADR 0012: Desktop distribution: signed, notarized macOS DMG

Status: Accepted 2026-07-11, pipeline built and verified unsigned; first signed build gated on Jay's Apple credentials · Review: adversarial review 2026-07-12 (post-ship v0.12.0-m7), sound, no CRITICAL/HIGH; M2, L2 fixed; M1, L1, L3, I1 residual

## Context
The desktop app only ran on a dev machine, spawning the system `node`. End users need a double-clickable `.app` in a DMG Gatekeeper accepts, meaning Developer ID signing and notarization. `better-sqlite3` and `sodium-native` load `.node` addons from the real filesystem, and Keychain unlock shells out to `/usr/bin/security`, so no App Sandbox.

## Decision
- D1: Bundle the stock, pinned Node binary plus the built server tree. The binary is fetched at build time from nodejs.org and checked against `SHASUMS256.txt`. Zero new npm dependencies.
- D2: Layout: `Contents/MacOS/northkeep-server` (renamed Node, `externalBin`) and `Resources/server/` (production tree via `pnpm --filter @northkeep/web deploy --prod --legacy --config.node-linker=hoisted`). The Rust shell spawns the child with `std::process::Command`, no `tauri-plugin-shell`.
- D3: `NORTHKEEP_SERVER_JS` and the system-node path are compiled out of release builds (`cfg(debug_assertions)`).
- D4: The UI URL and token pass over the private parent-child stdout pipe as in ADR 0004; loopback bind, Host check, constant-time token compare and CSP remain the security boundary.
- D5: Shutdown is SIGTERM, 2 s grace, then SIGKILL; the server's SIGTERM/SIGINT handler runs `session.lock()` (zeroizes the master key). A child-death watcher shows an `osascript` alert and quits.
- D6: Hardened runtime with allow-jit entitlements; `--jitless` rejected because it removes WebAssembly, breaking `fetch()` and silently degrading Tier-2 (invariant 6). Every `*.node` and the Node binary are codesigned before `tauri build`.
- D7: `aarch64-apple-darwin` only; `minimumSystemVersion` 13.5. Credentials come from env only.
- D8: No auto-update. Updates are manual DMG downloads. (ADR 0017 later added a user-initiated check.)

## Consequences
- Easier: non-engineers install by double-click; the signature seals every file on disk.
- Harder: DMG is 49 MB unsigned (`.app` 174 MB); Node security releases require a NorthKeep re-release; certificates need upkeep; arm64 only; Ollama stays a separate install.
- Limits: `SHASUMS256.txt` is not GPG-verified (M1), so a nodejs.org dist-server compromise is not stopped. Killing the shell itself (`kill -9`) can orphan the sidecar. The notarytool password is visible in `ps` during `--wait` (L3). Keychain prompt behavior, externalBin notarization (tauri#11992) and DMG stapling awaited the first signed build.

## Rejected
- Node SEA: addons must be written to a temp dir and `dlopen`ed at runtime, a security regression.
- pkg / yao-pkg / bun: break addon loaders, add a dependency or swap the runtime.
- Tauri updater: a background phone-home (invariants 5 and 7).

## What leaves the machine
The original has no egress section; its dependency note states no new network access in the shipped product: the loopback listener of ADR 0004, nothing outbound. At build time only: the Node download from nodejs.org, and notarization uploads the binaries to Apple. Gatekeeper's runtime notarization check is OS behavior, not ours.

## Links
Supersedes: ADR 0004 Decision 5 (deferral) · Related: ADR 0017 · Full record: docs/design/adr-0012-desktop-distribution.md
