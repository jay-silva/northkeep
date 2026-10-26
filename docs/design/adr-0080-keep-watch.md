# Design record: ADR 0080, Keep Watch

Status: Proposed. Short form: SPEC/decisions/0080-keep-watch.md.

ADR 0082 replaces how the helper runs: a signed program, label `ai.northkeep.keepwatch-helper`, runs the script below instead of `/bin/sh -c` in the plist. The plist, install and remove steps below describe 0.28.0; the current ones are in docs/design/adr-0082-signed-keep-watch-helper.md. The script and the marker are unchanged.

## Measurements (2026-10-21, Jay's MacBook Pro, Mac17,8, macOS 26)
- `sudo pmset -a disablesleep 1`, lid closed with no display: `date` every 10 s ran unbroken 12:04:49 to 12:08:30; `pmset -g log` shows `com.apple.powermanagement.lidopen` at 12:07:41. Before that, every lid close logged `Entering Sleep state due to 'Clamshell Sleep'`.
- `notifyutil -g com.apple.system.thermalpressurelevel` prints `0` at rest. Levels follow `NSProcessInfoThermalState`-style pressure: 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping.
- Not yet measured: whether `SleepDisabled 1` survives a reboot. The helper's `RunAtLoad` covers both answers.

## Files
- Marker: `/var/db/ai.northkeep.keepwatch`, root:wheel 0600, written by each turn-on prompt before `disablesleep 1`. Line 1: absolute heartbeat path. Line 2: ceiling, epoch seconds, turn-on plus 12 hours. Only the helper removes it.
- Heartbeat: `$NORTHKEEP_HOME/keep-watch/heartbeat`, as resolved at that turn-on, so a later `NORTHKEEP_HOME` change takes effect at the next turn-on. Touched every 15 s while on. NorthKeep requests off by deleting it.
- Helper: `/Library/LaunchDaemons/ai.northkeep.keepwatch.plist`, root:wheel 0644. Its bytes are a constant compiled into the app; nothing user-side is spliced in.

## Helper plist
```
Label              ai.northkeep.keepwatch
ProgramArguments   /bin/sh -c <SCRIPT>
StartInterval      15
RunAtLoad          true
AssociatedBundleIdentifiers  ai.northkeep.desktop   (display name in Login Items only)
```

## Helper script
```sh
mk=/var/db/ai.northkeep.keepwatch
[ -f "$mk" ] && [ ! -L "$mk" ] || exit 0
t5() { /usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' 5 "$@"; }
id=$(/usr/bin/stat -f %i:%m "$mk" 2>/dev/null) || id=x
off() {
  [ -x /usr/bin/perl ] || t5() { "$@"; }
  t5 /usr/bin/pmset -a disablesleep 0
  s=$(t5 /usr/bin/pmset -g | /usr/bin/awk '/^System-wide power settings:/{f=1;next} /^[^ \t]/{f=0} f&&$1=="SleepDisabled"{print $2;exit}')
  [ "$s" = 0 ] && [ "$(/usr/bin/stat -f %i:%m "$mk" 2>/dev/null)" = "$id" ] && /bin/rm -f "$mk"
  exit 0
}
now=$(/bin/date +%s)
{ IFS= read -r hb && IFS= read -r ceil; } < "$mk" || off
case "$ceil" in ''|*[!0-9]*) off ;; esac
[ "$now" -lt "$ceil" ] || off
case "$hb" in /*) ;; *) off ;; esac
m=$(t5 /usr/bin/stat -f '%HT|%m' "$hb" 2>/dev/null) || off
case "$m" in "Regular File|"*) m=${m#*|} ;; *) off ;; esac
case "$m" in ''|*[!0-9]*) off ;; esac
age=$((now - m))
[ "$age" -le 90 ] && [ "$age" -ge -60 ] || off
b=$(t5 /usr/bin/pmset -g batt) || off
l=$(printf '%s\n' "$b" | /usr/bin/grep -m1 'InternalBattery')
p=$(printf '%s' "$l" | /usr/bin/grep -Eo '[0-9]+%' | /usr/bin/head -1 | /usr/bin/tr -d %)
case "$p" in ''|*[!0-9]*) off ;; esac
case "$l" in *"; charging;"*|*"; charged;"*|*"; finishing charge;"*) ;; *) [ "$p" -gt 25 ] || off ;; esac
t=$(t5 /usr/bin/notifyutil -g com.apple.system.thermalpressurelevel) || off
t=${t##* }
case "$t" in ''|*[!0-9]*) off ;; esac
[ "$t" -lt 2 ] || off
exit 0
```
Rules the script keeps:
- Every external call except the local `date` and marker `stat` runs under a 5-second perl alarm; a timeout or error leads to `off`. If `/usr/bin/perl` is ever missing, every check fails and `off` runs `disablesleep 0` and its confirming read without the alarm, so a future macOS without perl still turns off. Turn-on refuses when perl is missing. The ceiling, which needs no external call, is checked first.
- Every path to "stay on" requires each check to read a well-formed passing value; anything else calls `off`.
- `off` always runs `disablesleep 0`. It removes the marker only on positive evidence: `SleepDisabled 0` read from the System-wide section, and the marker's inode and mtime unchanged since this run read it, so a turn-on that rewrote the marker meanwhile keeps its marker. A bad read leaves the marker, and the next run tries again.
- The script never reads `pmset -g` to decide whether to stay on, so a strange or empty read can only cause another `disablesleep 0`.
- `stat -f %HT` reports the type without following a final symlink; only a regular file passes. Intermediate directories are followed, but a stalled one hits the alarm.
- Battery: the internal battery line only, so a UPS listed first changes nothing. The 25% floor applies unless that line says charging or charged, so a weak charger that is discharging still hits it. No internal battery line means off; Keep Watch refuses to turn on on a Mac without one.
- The only privileged writes are `disablesleep 0` and removing its own marker.

## Install, on, off
All root steps run through `/usr/bin/osascript -e 'do shell script … with administrator privileges'`, called with `execFile` (no shell on our side). Each root command starts with `set -e`, so a failed step stops the rest.
- Turn-on command, run as root: decode the heartbeat path from base64 embedded in the command; refuse unless it starts with `/` and holds no newline; compute the ceiling as root's own clock plus 43,200 seconds (nothing from the caller); write the two lines to a `mktemp` file in /var/db, `chmod 600`, `mv` it over the marker; then `pmset -a disablesleep 1`.
- The server touches the heartbeat before showing the prompt, so a slow password entry cannot make the next helper run see it as stale.
- First on: the same command, preceded by writing the constant plist root-owned and `launchctl bootstrap system`.
- Later turns on: the same command, after `launchctl print system/ai.northkeep.keepwatch` shows the helper loaded. If it is not loaded (missing, or disabled in Login Items), turn-on is refused with a message saying how to re-enable it.
- Add time: allowed without a prompt up to the 12-hour ceiling; past it needs a new turn-on.
- Off, by any trigger: the server deletes the heartbeat; the helper turns the mode off within 15 s. The page shows "Turning off" until `SleepDisabled 0` is seen.
- Remove helper (Settings): one prompt runs `pmset -a disablesleep 0`, removes the marker, `launchctl bootout system/ai.northkeep.keepwatch`, and deletes the plist.

## Server controller (`apps/web`)
- Routes behind the existing local token: `GET /api/keep-watch` (state, time left, power source, battery, thermal level, helper installed), `POST /api/keep-watch` with `on` (hours, allow battery), `off`, `extend`, `remove-helper`.
- A 15-second loop touches the heartbeat and checks: timer, power source, battery floor 25%, thermal pressure 2 or higher. Any failure turns off.
- Startup: delete any leftover heartbeat, so the helper turns off whatever an earlier run left on.
- While on, each tick also checks the helper is still loaded and the marker still exists (`/var/db` is world-readable, so `stat` works without root); if either fails, the page and a notification say Keep Watch cannot turn itself off and offer Turn off now (one password prompt).
- Darwin only; other platforms report `unsupported` and the page is hidden.

## Menu bar (Tauri shell)
A tray menu reading the same route over the tokened local URL the shell already holds. Shown only on macOS.

## Known gaps
- If the helper is disabled in Login Items while Keep Watch is on and NorthKeep is also not running, nothing turns the mode off until the helper is re-enabled or someone runs `sudo pmset -a disablesleep 0`. Accepted as a known limit by Jay, 2026-10-21 ("accepted").
- If the mode is turned off some other way while Keep Watch is on, the helper does nothing until the heartbeat stops, then confirms off and clears the marker.
- A user who had set `disablesleep 1` by hand before turning Keep Watch on loses that setting when Keep Watch turns off.
- The thermal floor relies on `com.apple.system.thermalpressurelevel`; `notifyutil` returns 0 for unknown keys too, so a renamed key would read as cool. Unverified until a real heavy reading is seen.
- A same-user process can keep an already-on Mac awake by touching the heartbeat, up to the 12-hour ceiling and only above the battery and heat floors. It cannot turn the mode on or extend the ceiling.
- Changing the clock needs admin rights, so clock steps are out of scope.
