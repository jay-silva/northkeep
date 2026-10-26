# ADR 0082 design: the signed Keep Watch helper

Status: Proposed. Review: Reviews/adr-0082/review-1.md (CLEARED WITH WOUNDS; FW1 to FW3 addressed here and in the ADR); review-1-recheck.md (all three closed; quarantine note adopted below).

## Program
`apps/desktop/keep-watch-helper/main.c`: a single `execve("/bin/sh", {"sh", "-c", SCRIPT, NULL}, {"PATH=/usr/bin:/bin:/usr/sbin:/sbin", NULL})`. It never reads `argv` or the inherited environment. `SCRIPT` is the ADR 0080 script; a test extracts it from the C source and compares it with `HELPER_SCRIPT` and with the script block in docs/design/adr-0080-keep-watch.md. Built arm64 and x86_64, minimum macOS 13.5.

## Build and signing (FW1)
- Built by `scripts/desktop-bundle/build-keep-watch-helper.sh` into `apps/desktop/src-tauri/keep-watch-helper/ai.northkeep.keepwatch-helper`, shipped through `bundle.resources`, so it lands at `NorthKeep.app/Contents/Resources/keep-watch-helper/`. Tauri signs executables and externalBin with a file-name identifier and the app's JIT entitlements; it does not re-sign resources, and the outer signature seals them.
- `presign.sh` signs it with `-i ai.northkeep.keepwatch-helper --options runtime --timestamp` and no `--entitlements`.
- `build.sh` runs the install requirement against the built `.app`'s copy whenever `APPLE_SIGNING_IDENTITY` is set and fails the build if it does not pass.

## Requirement
`anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "8VZPFY6BDP" and identifier "ai.northkeep.keepwatch-helper"`. Passed as `-R='…'` (with `=`; review A1 showed the form without it fails closed but uselessly). Never add `--arch`: the default verifies the slice the kernel runs (A2).

## Install, as root (FW3)
```
set -e
d=/Library/PrivilegedHelperTools
/bin/mkdir -p "$d"
tp=$(/usr/bin/mktemp "$d/.keepwatch-helper.XXXXXX")
trap '/bin/rm -f "$tp"' EXIT
/bin/cat "$src" > "$tp"         # src decoded from base64; cat drops the download quarantine tag that cp keeps
/usr/sbin/chown root:wheel "$tp"
/bin/chmod 755 "$tp"
/usr/bin/codesign --verify --strict -R="$REQ" "$tp"
/bin/mv -f "$tp" "$d/ai.northkeep.keepwatch-helper"
```
Then the plist as in ADR 0080 (temp file, root:wheel 644, move), bootout and delete the old `ai.northkeep.keepwatch` daemon, bootstrap the new one. Mode 755 lets launchd exec it and lets the user-level server read it for the D5 comparison. Copy-then-verify is what defeats a source swap (A3c); the verified bytes are root-owned from the copy on.

The bundle check is defence in depth. The root command is composed by the app's own JavaScript, so a same-user attacker who can rewrite the app can rewrite the command; this is ADR 0080's threat model and is not changed.

## Helper state (FW2)
Order: outdated, missing, disabled, installed.
- outdated: `/Library/LaunchDaemons/ai.northkeep.keepwatch.plist` exists, or the installed plist differs from the constant, or the cdhash from `codesign -d -vvv` (plain `-v` omits it) of the installed program differs from the app copy's, or cannot be read. Byte comparison is wrong: each signature carries its own timestamp, so every release would look new.
- `tick()` treats outdated as able to self-off when the new label is loaded or the old daemon is loaded (both are off-only and read the same marker), so replacing the app while Keep Watch is on raises no false alarm.
- Settings shows Update (install prompt, no turn-on) and Remove whenever the state is outdated, so a user who never turns Keep Watch on again can still clear the "sh" row.

## Remove
`pmset -a disablesleep 0`, remove the marker, bootout and delete both labels' plists and the program.

## Acceptance (Jay, on a signed build)
1. On an app installed from the downloaded DMG (not a local build, which carries no quarantine tag): Settings, Keep Watch, Update; enter password. Login Items shows NorthKeep and no "sh" row.
2. Turn Keep Watch on, quit NorthKeep, then `pmset -g | grep SleepDisabled` reads 0 within 20 seconds.
3. Remove helper; the NorthKeep row for it disappears.

## Known gaps
- Whether deleting the old plist removes its Login Items row immediately is unverified; step 1 checks it.
- Downgrading to 0.28.0 reinstalls the old helper beside the new one. Both are off-only; harmless.
