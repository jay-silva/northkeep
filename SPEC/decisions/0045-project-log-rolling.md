# ADR 0045 — Project documents roll their Log into archive memories

- **Date:** 2026-09-04
- **Status:** Accepted by Jay ("go", 2026-09-04). Implemented in the same
  session.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0040 (connector
  project tools)
- **Does not touch:** vault schema, sync, crypto, the redaction harness. An
  archive is an ordinary memory with a scope and a type that already exist.

## Context

A project document is one `working` memory per `project:<slug>` scope,
capped at 16,384 characters so that `project_get` stays cheap to load at
every session start. Three of its sections are replaced on each update and
stay small. The Log only grows: every session prepends an entry, and a busy
day of long entries filled the NorthKeep document in one day (2026-09-04),
after which `project_update` refused every further log entry until a human
pruned by hand. Raising the cap moves the wall and makes every session
start heavier. The document should stay an index; the history should live
where history lives, in memories.

## Decision 1: The live document keeps only its newest Log entries

`project_update` merges as before, then rolls. While the document fits, it
is untouched. When it would exceed the cap, the newest ten entries stay in
the Log; if the document still does not fit, fewer stay, down to one. Only
when even that does not fit is the update refused, and then the hand-written
sections are the problem and the message says so. Decisions never roll.

## Decision 2: Rolled entries become an archive memory in the same scope

The rolled entries are written, oldest first, as one `episodic` memory in
the project's own scope, with the first line `## Log archive: <slug>` and a
one-line note of when it was rolled. It is an ordinary memory: it syncs,
exports, shares with the scope, and is found by search and retrieval. One
archive per roll; a roll happens once every ten or so sessions on a busy
project. Nothing is summarized or dropped by the tool. Summarizing an old
archive is a job for the review pass (ADR 0043), on request, never here.

## Decision 3: `project_get` returns the index by default and history on request

`project_get` gains an optional `history` flag. Off, it returns the live
document as today. On, it also returns the scope's archive memories, newest
first. The session contract keeps calling it without the flag at session
start.

## Decision 4: The tool asks for short entries

The `log_entry` description asks for a few hundred characters and says that
detail belongs in its own episodic memory in the project scope. The tool
reports when it rolled and where the archive went, so an agent that just
lost visibility of an entry knows how to get it back.

## Where it lives

The parsing, rolling and archive formatting are pure functions in the
shared project document module (`packages/core/src/project-doc.ts`, with
the byte-identical copy the connector keeps). Both MCP hosts, the local
server and the hosted connector, call them, so Claude Code, Claude Desktop,
Cursor and Claude.ai all see one behaviour. The connector writes the archive
as a pending shared entry the way `memory_remember` does, and the fold brings
it into the vault.

## Acceptance test (Jay)

From Claude Code with the NorthKeep project scope granted:

1. Ask for the NorthKeep project with history: the reply carries the live
   document and, once a roll has happened, its archives.
2. Append log entries until the document would pass the cap: the tool
   answers with "archived N entries to <id>" instead of refusing, and the
   live document's Log shows only the newest ten.
3. Search the project scope for a phrase from an archived entry: it is
   found.

## Consequences

- `mergeProjectDoc` no longer enforces size; hosts roll, then assert.
- KNOWN-LIMITS gains the roll rule and the "one archive per roll" note.
- The Command Repo file `projects/<name>.md` is unaffected; it keeps the
  full log by hand, as before.
