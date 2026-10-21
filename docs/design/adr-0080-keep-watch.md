# Design record: ADR 0080, Keep Watch

Status: Proposed. Short form: SPEC/decisions/0080-keep-watch.md.

## Measurements (2026-10-21, Jay's MacBook Pro, Mac17,8, macOS 26)
- `sudo pmset -a disablesleep 1`, lid closed with no display: `date` every 10 s ran unbroken 12:04:49 to 12:08:30; `pmset -g log` shows `com.apple.powermanagement.lidopen` at 12:07:41. Before that, every lid close logged `Entering Sleep state due to 'Clamshell Sleep'`.
- `notifyutil -g com.apple.system.thermalpressurelevel` prints `0` at rest. Levels follow `NSProcessInfoThermalState`-style pressure: 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping.
- Not yet measured: whether `SleepDisabled 1` survives a reboot. The helper's `RunAtLoad` covers both answers.

## Files
- Heartbeat: `$NORTHKEEP_HOME/keep-watch/heartbeat` (default `~/.northkeep`). Exists only while NorthKeep has the mode on; touched every 15 s; backdated to 1970 to request off; deleted once `SleepDisabled 0` is seen.
- Helper: `/Library/LaunchDaemons/ai.northkeep.keepwatch.plist`, root:wheel 0644. No other file.

## Helper plist
```
Label              ai.northkeep.keepwatch
ProgramArguments   /bin/sh -c <SCRIPT> keepwatch <absolute heartbeat path>
WatchPaths         <absolute heartbeat path>
StartInterval      30
RunAtLoad          true
```
The heartbeat path is a positional argument (`$1`), never spliced into the script text, so a home path with quotes cannot change the script.

## Helper script
```sh
hb="$1"
/usr/bin/pmset -g | /usr/bin/grep -Eq '^[[:space:]]*SleepDisabled[[:space:]]+1' || exit 0
[ -e "$hb" ] || exit 0
off=0
now=$(/bin/date +%s)
m=$(/usr/bin/stat -f %m "$hb" 2>/dev/null) || m=0
[ $((now - m)) -gt 90 ] && off=1
b=$(/usr/bin/pmset -g batt)
case "$b" in *"'Battery Power'"*)
  p=$(printf '%s' "$b" | /usr/bin/grep -Eo '[0-9]+%' | /usr/bin/head -1 | /usr/bin/tr -d %)
  [ -n "$p" ] && [ "$p" -le 25 ] && off=1 ;;
esac
t=$(/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel | /usr/bin/awk '{print $2}')
[ -n "$t" ] && [ "$t" -ge 2 ] && off=1
[ "$off" = 1 ] && /usr/bin/pmset -a disablesleep 0
exit 0
```
The only privileged write is `disablesleep 0`. Every input (`hb`, file mtime, battery and thermal readings) can at most cause or skip that write.

## Install, on, off
All root steps run through `/usr/bin/osascript -e 'do shell script … with administrator privileges'`, called with `execFile` (no shell on our side).
- First on: one prompt runs `install`-equivalent steps that decode a base64 copy of the plist embedded in the command itself (no temp file another process could swap), write it root-owned, `launchctl bootstrap system` it, then `pmset -a disablesleep 1`. Later turns on: one prompt for `pmset -a disablesleep 1`, after checking that the helper plist is present.
- Off, by any trigger: the server backdates the heartbeat. launchd fires the helper on the change; the server waits for `SleepDisabled 0` and deletes the file. No prompt.
- Remove helper (Settings): one prompt runs `launchctl bootout system/ai.northkeep.keepwatch` and deletes the plist, after turning the mode off.

## Server controller (`apps/web`)
- Routes behind the existing local token: `GET /api/keep-watch` (state, time left, power source, battery, thermal level, helper installed), `POST /api/keep-watch` with `on` (hours, allow battery), `off`, `extend`, `remove-helper`.
- A 15-second loop touches the heartbeat and checks: timer, power source, battery floor 25%, thermal pressure 2 or higher. Any failure turns off.
- Startup: an existing heartbeat file means an earlier run left the mode on; backdate it.
- Darwin only; other platforms report `unsupported` and the page is hidden.

## Menu bar (Tauri shell)
A tray menu reading the same route over the tokened local URL the shell already holds. Shown only on macOS.

## Known gaps
- macOS Login Items lets the user disable background items. If the helper is disabled there, turning off cannot happen unattended; the page must detect this (`launchctl print system/ai.northkeep.keepwatch`) and refuse to turn on.
- A same-user process can keep an already-on Mac awake by touching the heartbeat. It cannot turn the mode on.
