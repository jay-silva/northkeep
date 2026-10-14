> Full design and review record for [ADR 0064](../../SPEC/decisions/0064-linux-desktop-and-key-storage.md). The ADR holds the decision summary.

# ADR 0064 — Unsigned Linux bundles and where the vault key sits

- **Date:** 2026-10-11
- **Status:** Accepted for an unsigned build. Not a public release. Decision 2 amended 2026-10-13 (Decision 3).
- **Deciders:** Jay (approved the unsigned Linux build)

## Context

The signed desktop app is an Apple Silicon DMG (ADR 0012). A Linux build needs an AppImage, a deb, a linux-x64 Node sidecar, and a place for the derived vault key.

On Linux before this change, `keychain.ts` stored nothing. `keychainAvailable()` is Darwin-only, so unlock refused and the derived key was not on disk. The device secret is a different file (ADR 0001): hex at `~/.northkeep/device.secret`, mode 0600, not encrypted, not logged. Provider API keys and OAuth tokens are also not written on Linux (ADR 0035 has no file fallback for tokens).

## Decision 1: Linux bundles, unsigned

`build.sh` on Linux passes `tauri.linux.bundle.conf.json` (targets `appimage` and `deb`, same sidecar and server tree). The file is not named `tauri.linux.conf.json`, because Tauri auto-merges that name into every Linux command, including dev. macOS keeps `tauri.bundle.conf.json` (`app` and `dmg`) and its signing path. `fetch-node.sh` downloads Node's `linux-x64` tarball, checks SHA-256 against `SHASUMS256.txt` on every run, and stages `northkeep-server-x86_64-unknown-linux-gnu`. GPG over that SHASUMS file stays required when `NORTHKEEP_REQUIRE_GPG=1`. The Linux workflow sets that. CI is Ubuntu 22.04 so the bundles link glibc 2.35. Artifacts are unsigned workflow uploads. They are not a GitHub release.

## Decision 2: Where the vault key goes on Linux

Prefer the Secret Service via `secret-tool`. The key is the process stdin, never an argument. The store is used only when `secret-tool` runs and the session bus already owns `org.freedesktop.secrets`, so a missing daemon cannot sit on a prompt. If that service is absent, write `master.key` in the existing NorthKeep home (the same directory as the device secret), mode 0600, directory mode 0700, and warn. The file is not encrypted. Wrapping it would need another key, which is the problem being solved, and hand-rolled crypto is forbidden. `northkeep lock` deletes the Secret Service item and the file. `NORTHKEEP_NO_KEYCHAIN=1` disables every store. macOS Keychain behavior is unchanged. Provider API keys and OAuth tokens stay off disk on Linux.

## Decision 3 (2026-10-13): the key file is opt-in, lock checks every store, macOS ignores the override

Jay chose opt-in only on 2026-10-13 after a review of PR #9 found the file fallback turned on by itself. This replaces the automatic file write in Decision 2.

- With no Secret Service, background unlock is off. `northkeep unlock --allow-key-file` writes `master.key`; the app's "Keep unlocked" box never does. `NORTHKEEP_SECRET_BACKEND=file` remains the Linux test and power-user switch. A file that exists keeps being read, because only an opt-in wrote it, and `lock` deletes it.
- `northkeep lock` on Linux deletes the file and the Secret Service item whichever store this process would pick. Before this, a lock run while the keyring was down chose the file store, said "not unlocked", and left the keyring copy readable once the keyring came back (reproduced). When `secret-tool` is installed but the keyring is not on the bus, lock now reports `keyring-unreachable` and exits 1.
- `NORTHKEEP_SECRET_BACKEND` is read on Linux only. On macOS it had sent the key to a plain file (reproduced), contradicting "macOS Keychain behavior is unchanged."

## Review

Checked the code, not this prose. Attacks live in `packages/mcp-server/test/keychain-linux.test.ts` and `apps/web/test/linux-key-store.test.ts`: umask 0 still leaves mode 0600 and directory 0700; a symlink is not followed and is replaced rather than written through; a group-readable file is tightened before use; a malformed key never creates a file; `secret-tool` argv and `/proc/pid/cmdline` omit the key; a missing daemon does not wait on a hung `secret-tool`; `NORTHKEEP_NO_KEYCHAIN=1` and an unknown backend store nothing; the unlock response and the warning omit the key. Outcome: those checks passed. Fixed before that run: if `rename` throws, the temp file is removed so it cannot keep the key.

### Review of Decision 3 (2026-10-13)

A separate Claude session attacked the built `keychain.js` with fake `secret-tool`, `gdbus` and `security` on PATH and a simulated darwin. First verdict: NOT CLEARED. What it found, and what was done:

- With `NORTHKEEP_SECRET_BACKEND=file` at lock time, lock skipped the keyring and left an earlier keyring copy (confirmed). Fixed: lock checks the keyring whatever the override says.
- `secret-tool lookup` exits 1 for "no item" and also for a locked keyring, and a long-running app reused a cached probe, so lock could report "not unlocked" over a live copy. Fixed: lock re-probes, runs `clear` every time, and treats only a successful `clear` as gone.
- `secret-tool` missing from this process's PATH while the keyring is on the bus reported "not unlocked". Fixed: reports `keyring-unreachable`.
- macOS lock left a `master.key` an earlier build could have written. Fixed: lock deletes it.
- Accepted: an unknown `NORTHKEEP_SECRET_BACKEND` hides the app's full-lock prompt (the CLI still clears it). `NORTHKEEP_NO_KEYCHAIN=1` makes lock a no-op, as before. After an opt-in file unlock, lock exits 1 if the keyring cannot be checked, which fails safe.

Found nothing: a file written without opt-in (CLI, `/api/unlock`, `resolveMasterKey`), a symlinked `master.key`, a stale file beside a running keyring, a macOS file write, a macOS regression against the parent commit. Each fix has a test in `keychain-linux.test.ts`.

Second pass on b457a12: CLEARED. Each finding above was re-run and now removes the key or fails loudly. Left open, low: with neither `secret-tool` nor `gdbus` on PATH, lock cannot see a keyring copy. A lock that cleared a locked keyring's item still says "Vault was not unlocked". Not yet checked against a real `secret-tool`: that `clear` exits 0 when nothing matches. If it does not, every lock with nothing stored throws, which is safe but noisy.

## What leaves the machine

Nothing new at runtime. The build downloads Node from nodejs.org, the same build-time fetch ADR 0012 already does.
