# ADR 0082: A signed program runs the Keep Watch helper

Status: Proposed · Review: Reviews/adr-0082: review 1 CLEARED WITH WOUNDS (three wounds, fixed below; recheck pending)

## Context
The ADR 0080 helper is `/bin/sh -c <script>`, so Login Items lists it as "sh, Item from unidentified developer" (Jay, 0.28.0). A do-nothing test daemon, signed and notarized under our Developer ID at a new label, was listed as NorthKeep on 2026-10-26, pending Jay's confirmation that the row was the test.

## Decision
- D1: The helper becomes a small C program that ignores its arguments and environment and runs the unchanged ADR 0080 script, compiled in, through `/bin/sh -c`. A test checks the C source, the TypeScript constant and the design doc match word for word.
- D2: It ships in the app's Resources, which Tauri seals but does not re-sign. Presign signs it with identifier `ai.northkeep.keepwatch-helper`, hardened runtime, timestamp, no entitlements, and the build fails unless the built app's copy passes the D3 requirement.
- D3: Root installs it by copying into a root-owned temp file in `/Library/PrivilegedHelperTools`, setting root:wheel 755, verifying that copy with `codesign --verify --strict` against a fixed requirement (Apple anchor, Developer ID, that identifier, team 8VZPFY6BDP), then moving it into place. Any failure removes the temp file.
- D4: New label `ai.northkeep.keepwatch-helper`, keeping `AssociatedBundleIdentifiers`. Install and Remove also delete the old `ai.northkeep.keepwatch` daemon. The marker path does not change.
- D5: A helper state, outdated: the old daemon exists, or the installed program's code hash differs from the app's. It outranks disabled. Turn-on then shows the install prompt, and Settings shows Update and Remove, so users who never turn Keep Watch on again can still clear the "sh" row.
- D6: Unsigned builds refuse turn-on with a plain message; no shell fallback.

## Consequences
- Easier: Login Items shows NorthKeep instead of an unknown "sh".
- Harder: a native program to sign each release; one more admin prompt when the helper changes.
- Committed to: ADR 0080's "off is the only privileged action" still holds; the program takes no input.

## Rejected
- SMAppService daemon: needs native code in the shell and moves the controller out of the server (ADR 0080 D2).
- Old label, new program: unproven that the row renames.
- Shell fallback when unsigned: the bug returns silently.

## What leaves the machine
Nothing new.

## Links
Design: docs/design/adr-0082-signed-keep-watch-helper.md · Plan: NorthKeep project northkeep · Supersedes: 0080 D4 (how the helper runs)
