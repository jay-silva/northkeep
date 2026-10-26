# ADR 0082: A signed program runs the Keep Watch helper

Status: Proposed · Review: Reviews/adr-0082

## Context
The ADR 0080 helper is `/bin/sh -c <script>`, so Login Items lists it as "sh, Item from unidentified developer". Jay saw this on 0.28.0. A do-nothing test daemon whose program was signed and notarized under our Developer ID, under a new label, was listed as NorthKeep on 2026-10-26 (pending Jay's confirmation that the row was the test). Unknown: whether changing an existing label's program renames its row.

## Decision
- D1: The helper becomes a small C program, signed with our Developer ID, identifier `ai.northkeep.keepwatch-helper`, hardened runtime, notarized with the app. It ignores its arguments and environment and runs the ADR 0080 script, compiled in, through `/bin/sh -c`. The script is unchanged; a test checks the C source, the TypeScript constant and the design doc match word for word.
- D2: It ships inside the app bundle, covered by the app's seal. The installer, as root, copies it into a root-owned temp file in `/Library/PrivilegedHelperTools`, runs `codesign --verify --strict -R` against a fixed requirement (Apple anchor, Developer ID, that identifier, team 8VZPFY6BDP) on the copy, and only then moves it into place. The bundle path is never trusted on its own.
- D3: A new label, `ai.northkeep.keepwatch-helper`, whose plist names only that program. Install and Remove also boot out and delete the old `ai.northkeep.keepwatch` daemon. The marker path stays `/var/db/ai.northkeep.keepwatch`.
- D4: A fourth helper state, outdated: the old daemon is present, or the installed plist or program differs from the app's copy. Outdated is handled like missing, so the next turn-on shows the install prompt and replaces it.
- D5: Builds without a signed helper (local, unsigned) refuse turn-on with a plain message instead of falling back to the shell helper.

## Consequences
- Easier: Login Items shows NorthKeep, with our name on it, instead of an unknown "sh".
- Harder: a native program to build, sign and notarize each release, and one more admin prompt for current Keep Watch users.
- Committed to: ADR 0080's "the off direction is the only privileged action" still holds; the program adds no input, so the attack surface is the same script.

## Rejected
- SMAppService daemon with BundleProgram: needs native code in the Tauri shell, a Login Items approval step, and moves the controller out of the server (ADR 0080 D2).
- Keep the old label with a new program: unproven that the row renames.
- Fall back to the shell helper when unsigned: two code paths, and the bug returns silently.

## What leaves the machine
Nothing new. Notarization already uploads the app; this adds one binary to it.

## Links
Design: docs/design/adr-0080-keep-watch.md · Plan: NorthKeep project northkeep · Supersedes: 0080 D4 (how the helper runs)
