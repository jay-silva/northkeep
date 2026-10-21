# ADR 0080: Keep Watch, lid-closed awake on the Mac

Status: Accepted 2026-10-21 (Jay) · Review: Reviews/adr-0080: review 1 and 2 NOT CLEARED (fixed); recheck CLEARED WITH WOUNDS (fixed)

## Context
Jay wants agent sessions to keep running with the MacBook lid shut. Idle-sleep assertions (`caffeinate`) do not cover a closed lid; only `pmset -a disablesleep 1` does, and it needs root. Verified on his Mac 2026-10-21. The setting outlives the app, so a crash could leave a Mac that never sleeps.

## Decision
- D1: Keep Watch is an opt-in Mac-only setting, off by default, with a Settings page and a menu bar menu (mock approved 2026-10-21). Turning it on asks for the Mac password every time through the macOS admin prompt.
- D2: The controller lives in the local server (`apps/web`), over the Tauri shell, so the shell stays a window and the menu bar calls the same local API.
- D3: While on, the server turns it off when the timer ends (1, 2, 4 or 8 hours), the charger is unplugged unless battery is allowed, battery reaches 25%, macOS thermal pressure reaches heavy, or the app quits. On launch it turns off any Keep Watch it finds left on.
- D4: Turning off also needs root and must work unattended, so an off-only root helper is required, installed with the first password prompt. Its plist is a fixed constant with the script inline.
- D5: Each turn-on prompt writes a root-owned marker (heartbeat path, 12-hour ceiling) before setting the mode. Every 15 seconds and at boot, with a marker present, the helper runs `pmset -a disablesleep 0` unless the heartbeat is a real file touched in the last 90 seconds and not in the future, the ceiling has not passed, the battery is above 25% or charging, and thermal pressure reads below heavy. Anything missing, unreadable or slow (5-second limit) means off; the marker is cleared only once the mode reads off. Without a marker it leaves the setting alone.
- D6: Settings can remove the helper, with the same password prompt.

## Consequences
- Easier: a closed-lid MacBook keeps working through long agent runs.
- Harder: NorthKeep ships its first root component. The worst a local process can do through it is keep an already-on Mac awake by refreshing the heartbeat, up to the 12-hour ceiling and only above the battery and heat floors.
- Committed to: the off direction is the only privileged action in the helper, and the claim "it can only turn Keep Watch off" ships under the review gate.

## Rejected
- Idle assertions only: a closed lid still sleeps.
- A privileged helper that can also turn it on: one password, but a root service that keeps the Mac awake on request.
- A sudoers line for `pmset`: edits a macOS security setting, and a typo can break sudo.

## What leaves the machine
Nothing new.

## Links
Design: docs/design/adr-0080-keep-watch.md · Plan: NorthKeep project northkeep · Supersedes: none
