# ADR 0080: Keep Watch, lid-closed awake on the Mac

Status: Proposed · Review: Reviews/adr-0080 (pending)

## Context
Jay wants agent sessions on his MacBook to keep running with the lid shut and no display attached. Idle-sleep assertions (`caffeinate`) do not cover a closed lid; only `pmset -a disablesleep 1` does, and it needs root. Verified on his Mac 2026-10-21: a 10-second log ran unbroken through a lid close. The setting outlives the app, so a crash could leave a Mac that never sleeps.

## Decision
- D1: Keep Watch is an opt-in Mac-only setting, off by default, with a Settings page and a menu bar menu (mock approved 2026-10-21). Turning it on asks for the Mac password every time through the macOS admin prompt, over storing any standing permission to turn it on.
- D2: The controller lives in the local server (`apps/web`), over the Tauri shell, so the shell stays a window and the menu bar calls the same local API.
- D3: While on, the server turns it off when the timer ends (1, 2, 4 or 8 hours), the charger is unplugged unless battery is allowed, battery reaches 25%, macOS thermal pressure reaches heavy, or the app quits. On launch it turns off any Keep Watch it finds left on.
- D4: Turning off also needs root and must work unattended, so an off-only helper is required: a root LaunchDaemon installed with the first password prompt, its script inline in a root-owned plist. When NorthKeep's heartbeat file changes, every 30 seconds, and at boot, it runs `pmset -a disablesleep 0` if the file is over 90 seconds old, the Mac is on battery at 25% or below, or thermal pressure is heavy. NorthKeep turns off by backdating the file. The helper never turns the mode on.
- D5: The helper acts only when NorthKeep's marker file says NorthKeep turned the mode on, over owning the setting outright, so it leaves another tool's use of `disablesleep` alone.
- D6: Settings can remove the helper, with the same password prompt.

## Consequences
- Easier: a closed-lid MacBook keeps working through long agent runs.
- Harder: NorthKeep ships its first root component. The worst a local process can do through it is keep an already-on Mac awake by refreshing the heartbeat.
- Committed to: the off direction is the only privileged action in the helper, and the claim "it can only turn Keep Watch off" ships under the review gate.

## Rejected
- Idle assertions only: a closed lid still sleeps.
- A privileged helper that can also turn it on: one password, but a root service that keeps the Mac awake on request.
- A sudoers line for `pmset`: edits a macOS security setting, and a typo can break sudo.
- Skip crash cover: the setting may survive a reboot, leaving the Mac awake indefinitely.

## What leaves the machine
Nothing new.

## Links
Design: docs/design/adr-0080-keep-watch.md · Plan: NorthKeep project northkeep · Supersedes: none
