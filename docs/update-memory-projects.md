# Updating to the Memories and Projects workspace

Release preparation: the replacement installer has not been published. Version 0.21.0 remains the public Mac download. These steps must accompany the new installer and its release announcement.

## Before installing

1. Finish the current work and confirm the saved project state. Keep your normal vault backup.
2. Quit NorthKeep and every AI app connected to its local server, including Claude Desktop, Codex and Cursor where used. Close terminal-based assistant sessions as well. Use Quit, not just Close Window.
3. Install the new release only after its version and download have been published. Reopen NorthKeep, unlock your vault, then reopen the connected AI apps.

## Before continuing a project

Ask each connected assistant to check its actual local NorthKeep tools. It should expose `project_resume`, `project_checkpoint` and `project_wrap`; `project_update` should require `expected_revision`. Have it call Resume for an existing project and report the current status and next action. This check is read-only.

If it still shows the old tools, stop project writes from that connection. Fully quit and reopen the host again. If the old schema persists, resolve the stale connection before continuing. Use the local connection explicitly when a hosted connector is also present; the existing hosted project tools do not have these revision guarantees.

## Why a full restart matters

A connected assistant can keep a NorthKeep server running in the background. Replacing the app does not replace code already loaded into that process. The vault format remains compatible, so an old process can still open it and save a project without the new revision checks.

The restart loads the new server. Its local saves refuse an outdated project revision and recognize an identical retry. This release uses an explicit restart requirement, not automatic retirement of every older process.

## What this update changes

Memories organizes saved information by collection. Review provides deliberate consolidation of eligible private memories, with original wording retained in history. Projects brings the current state, next actions, decisions, questions and file references together with Resume, Checkpoint and Wrap up.

The existing vault format is retained. A new import is not part of the transition. The new local handoff checks do not change hosted connector writes or coordinate competing edits across devices.
