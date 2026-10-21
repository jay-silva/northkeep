# Design record: ADR 0080, Keep Watch

Status: Proposed. Short form: SPEC/decisions/0080-keep-watch.md.

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
```

## Helper script
```sh
mk=/var/db/ai.northkeep.keepwatch
[ -f "$mk" ] && [ ! -L "$mk" ] || exit 0
now=$(/bin/date +%s)
if ! /usr/bin/pmset -g | /usr/bin/grep -Eq '^[[:space:]]*SleepDisabled[[:space:]]+1'; then
  mm=$(/usr/bin/stat -f %m "$mk" 2>/dev/null) || mm=0
  [ $((now - mm)) -gt 60 ] && /bin/rm -f "$mk"
  exit 0
fi
{ IFS= read -r hb; IFS= read -r ceil; } < "$mk"
ok=1
case "$ceil" in ''|*[!0-9]*) ok=0 ;; *) [ "$now" -lt "$ceil" ] || ok=0 ;; esac
if [ -f "$hb" ] && [ ! -L "$hb" ]; then
  m=$(/usr/bin/stat -f %m "$hb" 2>/dev/null) || m=0
  age=$((now - m))
  [ "$age" -le 90 ] && [ "$age" -ge -60 ] || ok=0
else
  ok=0
fi
b=$(/usr/bin/pmset -g batt)
case "$b" in *"'AC Power'"*) ;; *)
  p=$(printf '%s' "$b" | /usr/bin/grep -Eo '[0-9]+%' | /usr/bin/head -1 | /usr/bin/tr -d %)
  case "$p" in ''|*[!0-9]*) ok=0 ;; *) [ "$p" -gt 25 ] || ok=0 ;; esac ;;
esac
t=$(/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel 2>/dev/null | /usr/bin/awk '{print $2}')
case "$t" in ''|*[!0-9]*) ok=0 ;; *) [ "$t" -lt 2 ] || ok=0 ;; esac
if [ "$ok" = 0 ]; then /usr/bin/pmset -a disablesleep 0 && /bin/rm -f "$mk"; fi
exit 0
```
Every check is written so a missing, unreadable or unexpected value means off. The only privileged writes are `disablesleep 0` and removing its own marker. Battery is checked whenever the source is not `'AC Power'`, so UPS power counts as battery.

## Install, on, off
All root steps run through `/usr/bin/osascript -e 'do shell script … with administrator privileges'`, called with `execFile` (no shell on our side). Values that vary (the heartbeat path) travel base64-encoded inside the command text and are decoded by the root shell, never quoted into it; the path must also be absolute and contain no newline, or turn-on is refused.
- First on: one prompt writes the constant plist root-owned, `launchctl bootstrap system` it, writes the marker, then `pmset -a disablesleep 1`.
- Later turns on: one prompt writes the marker, then `pmset -a disablesleep 1`, after `launchctl print system/ai.northkeep.keepwatch` shows the helper loaded. If it is not loaded (missing, or disabled in Login Items), turn-on is refused with a message saying how to re-enable it.
- Add time: allowed without a prompt up to the 12-hour ceiling.
- Off, by any trigger: the server deletes the heartbeat; the helper turns the mode off within 15 s. The page shows "Turning off" until `SleepDisabled 0` is seen.
- Remove helper (Settings): one prompt runs `pmset -a disablesleep 0`, removes the marker, `launchctl bootout system/ai.northkeep.keepwatch`, and deletes the plist.

## Server controller (`apps/web`)
- Routes behind the existing local token: `GET /api/keep-watch` (state, time left, power source, battery, thermal level, helper installed), `POST /api/keep-watch` with `on` (hours, allow battery), `off`, `extend`, `remove-helper`.
- A 15-second loop touches the heartbeat and checks: timer, power source, battery floor 25%, thermal pressure 2 or higher. Any failure turns off.
- Startup: delete any leftover heartbeat, so the helper turns off whatever an earlier run left on.
- While on, each tick also checks the helper is still loaded; if it is not, the page and a notification say Keep Watch cannot turn itself off and offer Turn off now (one password prompt).
- Darwin only; other platforms report `unsupported` and the page is hidden.

## Menu bar (Tauri shell)
A tray menu reading the same route over the tokened local URL the shell already holds. Shown only on macOS.

## Known gaps
- If the helper is disabled in Login Items while Keep Watch is on and NorthKeep is also not running, nothing turns the mode off until the helper is re-enabled or someone runs `sudo pmset -a disablesleep 0`.
- A same-user process can keep an already-on Mac awake by touching the heartbeat, up to the 12-hour ceiling and only above the battery and heat floors. It cannot turn the mode on or extend the ceiling.
- Changing the clock needs admin rights, so clock steps are out of scope.
