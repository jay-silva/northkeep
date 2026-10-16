# ADR 0077: A project section for the next agent

Status: Proposed 2026-10-15 · Review: not required (no change to what leaves the machine, who decides, or crypto)

## Context
Assistants write one Current Status for two readers: the person on the project page and the next AI session. The result reads badly for both. Jay's summary ran 1,339 characters and opened with commit hashes. ADR 0076 caps the summary at 1,000 characters; agents still need somewhere to put the dense detail.

## Decision
- D1: Project documents get an owned section, `## For the Next Agent`, written through a new optional `agent_detail` field on `project_update`, `project_checkpoint` and `project_wrap`. It replaces the section; an empty string clears it. `project_get` and `project_resume` return it.
- D2: Tool schemas and the standing instruction split the readers: Current Status and Next Actions are for the person (plain, short, no hashes or ids); branches, hashes, paths, commands and gotchas go in `agent_detail`.
- D3: The project page shows the section closed, below Files, with a line saying the user does not need to read it.

## Consequences
- Easier: the summary stays readable without losing detail the next session needs.
- Older builds keep the section as an unknown heading, byte for byte, so mixed versions do not lose it.
- The hosted connector does not write the field yet, as with Open Questions; it preserves the section when it updates other parts.
- The section counts toward the 16,384-character document cap.

## Rejected
- Using ADR 0072 agent notes: they stay on one Mac and are not part of the project record other apps resume from.
- Only the Log: it rolls out after ten entries and is written per session, not kept current.

## What leaves the machine
Nothing new. The section syncs and shares exactly as the rest of the project document does.

## Links
ADR 0076 (summary limit) · ADR 0039 (project documents) · ADR 0072 (agent notes)
