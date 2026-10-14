# ADR 0052: Project provenance, session accounting, a lighter resume brief, and draft projects

Status: Accepted 2026-09-21, merged (main dd4e78b) 2026-09-22, released in 0.22.0; Jay's acceptance passed 2026-09-22 · Review: three passes NOT CLEARED with amendments, fourth CLEARED WITH WOUNDS (two accepted by Jay, one fixed) · Corrected 2026-09-24; amended by ADRs 0054, 0060

## Context
Agents were indistinguishable in the record, a session that read a project without writing back was undetectable, and hosts never called `project_wrap` or `project_checkpoint` in 2.5 months, while default `project_resume` cost tens of thousands of tokens. No MCP host exposes a model identifier.

## Decision
- D1: Every project write through the project tools stores `northkeep_provenance_v1` `{ version, host, host_version, model: null, session_id, recorded_at }` from a caller-supplied `writer`, never inherited. `tameOneLine` strips Unicode `Cc`, `Cf`, `U+2028`, `U+2029` and unpaired surrogates and caps at 80 UTF-16 units (40 for version); `validateProjectWriter` refuses those classes; `readProjectProvenance` reads a violating block as null. The block is inside `computeEntryHash`, outside the request fingerprint. `memory_edit` strips it.
- D2: One session id (lowercase v4) per server process, on every call-log row. Open sessions are derived at resume, never stored: a successful `project_get`/`project_resume` read within 30 days with no later write, newest three, rows validated (strict ISO `ts` at most 5 minutes ahead, re-emitted). A log that exists but cannot be read degrades resume with `open_sessions_note`.
- D3: `project_resume` defaults `history` to false: content-free revision summaries, `archive_summary`, no `content` or `files_text`. Structural bound: sections once, never prior text, never larger than `history: true`. No byte number is a published claim. `project_get` gains `revision`.
- D4: `project_create` gains `draft` (a preamble line), cleared by `project_wrap` or `project_update` with `draft: false`.
- D5: The contract prefers resume, checkpoint and wrap; Jay installs it.

## Consequences
- Claim 1: writer is host-reported attribution, never verified identity. The chain is unkeyed: tamper-evident, not tamper-proof. On a compacted revision the block survives but is not evidence.
- Claim 2: a non-writing session is visible only if it read through a local MCP server on this Mac; GUI, CLI and hosted reads are invisible, `project_board` does not count (ADR 0054), and the shown host is the last read's presented name.
- Claim 3: the block never carries a model; Converse's call-log `model` is a separate record.
- Accepted: an 80-character host can spell a same-line heading; a row 5 minutes ahead pins the list; the log follows a symlink; an empty-after-sanitizing name cannot write; unknown MCP arguments are stripped; long-lived hosts share one id. Since ADR 0060 a pending row is logged before vault access and the call is refused if it cannot be. Nothing forces hosts to call wrap.

## Rejected
- Recording a model id: no host exposes one.
- Auto-wrap or writing on open.

## What leaves the machine
The original states it does not touch egress, redaction, crypto, the connector or sync, runs no model and adds no dependency.

## Links
Full record: docs/design/adr-0052-project-provenance-and-session-accounting.md · Extends: ADRs 0039, 0042, 0045, 0048, 0051
