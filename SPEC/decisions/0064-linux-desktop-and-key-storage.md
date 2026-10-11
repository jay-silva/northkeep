# ADR 0064 — Unsigned Linux bundles and where the vault key sits

- **Date:** 2026-10-11
- **Status:** Accepted for an unsigned build. Not a public release.
- **Deciders:** Jay (approved the unsigned Linux build)

## Context

The signed desktop app is an Apple Silicon DMG (ADR 0012). A Linux build needs an AppImage, a deb, a linux-x64 Node sidecar, and a place for the derived vault key.

On Linux before this change, `keychain.ts` stored nothing. `keychainAvailable()` is Darwin-only, so unlock refused and the derived key was not on disk. The device secret is a different file (ADR 0001): hex at `~/.northkeep/device.secret`, mode 0600, not encrypted, not logged. Provider API keys and OAuth tokens are also not written on Linux (ADR 0035 has no file fallback for tokens).

## Decision 1: Linux bundles, unsigned

`build.sh` on Linux passes `tauri.linux.bundle.conf.json` (targets `appimage` and `deb`, same sidecar and server tree). The file is not named `tauri.linux.conf.json`, because Tauri auto-merges that name into every Linux command, including dev. macOS keeps `tauri.bundle.conf.json` (`app` and `dmg`) and its signing path. `fetch-node.sh` downloads Node's `linux-x64` tarball, checks SHA-256 against `SHASUMS256.txt` on every run, and stages `northkeep-server-x86_64-unknown-linux-gnu`. GPG over that SHASUMS file stays required when `NORTHKEEP_REQUIRE_GPG=1`. The Linux workflow sets that. CI is Ubuntu 22.04 so the bundles link glibc 2.35. Artifacts are unsigned workflow uploads. They are not a GitHub release.

## Decision 2: Where the vault key goes on Linux

Prefer the Secret Service via `secret-tool`. The key is the process stdin, never an argument. The store is used only when `secret-tool` runs and the session bus already owns `org.freedesktop.secrets`, so a missing daemon cannot sit on a prompt. If that service is absent, write `master.key` in the existing NorthKeep home (the same directory as the device secret), mode 0600, directory mode 0700, and warn. The file is not encrypted. Wrapping it would need another key, which is the problem being solved, and hand-rolled crypto is forbidden. `northkeep lock` deletes the Secret Service item and the file. `NORTHKEEP_NO_KEYCHAIN=1` disables every store. macOS Keychain behavior is unchanged. Provider API keys and OAuth tokens stay off disk on Linux.

## Review

Checked the code, not this prose. Attacks live in `packages/mcp-server/test/keychain-linux.test.ts` and `apps/web/test/linux-key-store.test.ts`: umask 0 still leaves mode 0600 and directory 0700; a symlink is not followed and is replaced rather than written through; a group-readable file is tightened before use; a malformed key never creates a file; `secret-tool` argv and `/proc/pid/cmdline` omit the key; a missing daemon does not wait on a hung `secret-tool`; `NORTHKEEP_NO_KEYCHAIN=1` and an unknown backend store nothing; the unlock response and the warning omit the key. Outcome: those checks passed. Fixed before that run: if `rename` throws, the temp file is removed so it cannot keep the key.

## What leaves the machine

Nothing new at runtime. The build downloads Node from nodejs.org, the same build-time fetch ADR 0012 already does.
