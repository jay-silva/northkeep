# ADR 0064: Unsigned Linux bundles and where the vault key sits

Status: Accepted 2026-10-11 for an unsigned build, not a public release. D2 amended by D3 on 2026-10-13 · Review: code review passed; D3 review NOT CLEARED, then CLEARED on b457a12 (full record)

## Context
The signed desktop app is an Apple Silicon DMG (ADR 0012). Linux needs an AppImage, a deb, a linux-x64 Node sidecar, and a place for the derived vault key. Before this, Linux stored no key, so unlock refused. The device secret is a separate unencrypted 0600 file (ADR 0001).

## Decision
- D1: `build.sh` on Linux uses `tauri.linux.bundle.conf.json` (AppImage and deb). `fetch-node.sh` checks Node's SHA-256 on every run, and GPG when `NORTHKEEP_REQUIRE_GPG=1`, which the Linux workflow sets. CI is Ubuntu 22.04 (glibc 2.35). Artifacts are unsigned workflow uploads, not a GitHub release.
- D2: Prefer the Secret Service via `secret-tool`, with the key on stdin, used only when the session bus already owns `org.freedesktop.secrets`. `NORTHKEEP_NO_KEYCHAIN=1` disables every store. macOS Keychain behavior is unchanged. Provider API keys and OAuth tokens stay off disk on Linux.
- D3 (Jay, 2026-10-13, replaces D2's automatic file write): with no Secret Service, background unlock is off. Only `northkeep unlock --allow-key-file` writes `master.key` (mode 0600, directory 0700, not encrypted, because wrapping it would need another key). The app's "Keep unlocked" box never does. `NORTHKEEP_SECRET_BACKEND=file` is the Linux test and power-user switch, read on Linux only. `northkeep lock` deletes the file and the keyring item whichever store it would pick, and reports `keyring-unreachable` (exit 1) when it cannot check the keyring.

## Consequences
- Easier: Linux users with a keyring get background unlock. Without one, nothing lands on disk unless they opt in.
- Harder: an opt-in key file is readable by anyone with the user's Linux session.
- Limits (from the D3 review): with neither `secret-tool` nor `gdbus` on PATH, lock cannot see a keyring copy. An unknown `NORTHKEEP_SECRET_BACKEND` hides the app's full-lock prompt (the CLI still clears it). Not yet checked against a real `secret-tool`: that `clear` exits 0 when nothing matches.

## Rejected
- Encrypting the key file: needs another key, which is the problem being solved, and hand-rolled crypto is forbidden.
- Automatic file fallback: a review of PR #9 found it turned on by itself.

## What leaves the machine
Nothing new at runtime. The build downloads Node from nodejs.org, the same build-time fetch ADR 0012 already does.

## Links
Full record: docs/design/adr-0064-linux-desktop-and-key-storage.md · Tests: `packages/mcp-server/test/keychain-linux.test.ts`, `apps/web/test/linux-key-store.test.ts`
