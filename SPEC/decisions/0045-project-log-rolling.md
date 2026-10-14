# ADR 0045: Project documents roll their Log into archive memories

Status: Accepted by Jay ("go", 2026-09-04), implemented the same session · Review: no adversarial review recorded · Corrected 2026-09-24 (0.22.0 doc-vs-code pass)

## Context
A project document is one `working` memory per `project:<slug>` scope, capped at 16,384 characters to stay cheap at session start. Its Log only grows; on 2026-09-04 it filled, and `project_update` refused every entry until a human pruned it.

## Decision
- D1: `project_update` merges, then rolls. If the document would exceed the cap, the newest ten Log entries stay, fewer down to one if needed. If one still does not fit, the update is refused and the message blames the hand-written sections. Decisions never roll.
- D2: Rolled entries are written, oldest first, as one `episodic` memory in the project's scope, first line `## Log archive: <slug>` plus a rolled-when note. It syncs, exports, shares with the scope; it is found by `memory_retrieve`, `memory_list` or `project_get` with `history: true`. The tool never summarizes or drops. Current state: the review pass (ADR 0043) excludes project scopes, so no shipped tool summarizes an archive, and the Mac Memories search excludes project scopes (ADR 0049).
- D3: `project_get` gains an optional `history` flag that adds the scope's archives, newest first. Current state: sessions start with `project_resume` (ADRs 0048, 0052), which without `history` returns only an archive count and dates (`archive_summary`), and with `history: true` up to 20 archives.
- D4: The `log_entry` description asks for a few hundred characters, with detail in its own episodic memory. Current state: only the hosted connector's `project_update` reports the roll ("Archived N older log entries to <id>"). The local `project_update` returns an archive count but no roll count or archive id; local `project_checkpoint` and `project_wrap` name the archive in `archive_ids`.
- D5: Rolling is pure functions in `packages/core/src/project-doc.ts` and a byte-identical connector copy, called by both MCP hosts. The connector writes the archive as a pending shared entry.
- D6 (2026-09-19): every row in a slug-valid project scope gets the connector's 64 KiB push cap, not only the working document. `memory_remember` into a project scope stays capped at 8 KiB by the tool. Amends ADR 0040 Decision 6, after archives over 8 KiB made every share sync since 2026-09-11 fail with a 413.

## Consequences
- Committed to: `mergeProjectDoc` no longer enforces size; hosts roll, then assert. KNOWN-LIMITS carries the roll rule and "one archive per roll".
- Limits: the Command Repo became a read-only archive on 2026-09-23; project documents and their archives are the record.

## Rejected
- Raising the cap: moves the wall; heavier session starts.
- Summarizing or dropping in the tool: history lives whole in memories.

## What leaves the machine
The original has no egress section. It says it does not touch vault schema, sync, crypto or redaction, and that an archive is an ordinary memory that syncs and shares with its scope.

## Links
Extends: ADRs 0039, 0040 · Amends: ADR 0040 Decision 6 · Full record: docs/design/adr-0045-project-log-rolling.md
