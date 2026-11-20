# ADR 0084: Found first: agents told to check NorthKeep, search skips project paperwork, confirmed memories rank first

Status: Proposed 2026-11-20 (relaunch step 1, milestone 2) · Review 1: CLEARED WITH WOUNDS, fixed in this revision; recheck pending · Merge waits for the milestone 1 baseline score

## Context
The relaunch test asks fresh Claude, Grok Bot and Codex sessions 25 questions without telling them to use NorthKeep. The MCP connect-time text is only the milestone rule, in two hand-kept copies (server.ts:909, connector mcp.ts:261); `northkeep contract install` writes a third standing text into app files. `memory_retrieve` ranks project documents and log archives beside facts. Nothing marks a memory the user confirmed.

## Decision
- D0: Before building, a live check records, for Claude, Grok Bot, Codex and Muse, whether each passes server instructions to its model. Where none do, D2 is that app's path.
- D1: One wording, sent by both servers and placed in the contract text: a trigger (a named person, organization or property the agent has no facts about: `memory_retrieve`; a named project: `project_get`), that the agent's own memory is not the user's record, the reason, then the milestone rule. A test fails if any copy differs.
- D2: One stable sentence for apps that ignore server instructions, in the Connect help text now and behind a copy button once Jay approves its mock.
- D3: `memory_retrieve` (device and connector) and the connector's `search` skip a live project document and a log archive, detected by the existing `isProjectLogArchive` (one detector, shared). Other project-scope memories stay searchable.
- D4: A memory is confirmed when its metadata holds `confirmed: {by: "user", at}`. Only the app and CLI set it; confirming supersedes the memory with the same content plus the marker. Any agent write that supersedes a confirmed memory drops the marker: `supersedeEntry` copies metadata today and must strip it for actor agent.
- D5: The boost applies only to an entry that matches the query on a word that is not a stopword, word-bounded on the connector. It reorders matches; it never admits one.
- D6: Pushes carry `confirmed: true` inside the encrypted row. The connector deploys before clients send it.
- D7: CLI `northkeep confirm <id>` and `remember --confirmed`. Jay confirms core facts with commands the agent hands him, since he rarely opens the app.

## Consequences
- Easier: one wording; confirmed facts outrank agent guesses.
- Harder: an envelope field; a confirm writes a row.
- Committed to: KNOWN-LIMITS says the instruction is advisory, that a shell-capable agent can run `confirm` (as with milestones), and which apps D0 found pass instructions.

## Rejected
- Excluding all `project:*` scopes: drops project facts agents need.
- A mutable confirmed column: only bookkeeping may change after creation.
- Letting agents confirm: an agent could promote its own memories.

## What leaves the machine
To each connected app: the instruction text, no vault content. To the connector, shared scopes only: one boolean per row inside the existing ciphertext.

## Links
Design and review log: docs/design/adr-0084-found-first.md · Extends: ADRs 0039, 0067
