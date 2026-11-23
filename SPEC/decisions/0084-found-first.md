# ADR 0084: Found first: agents told to check NorthKeep, search skips project paperwork, confirmed memories rank first

Status: Accepted 2026-11-22 (Jay: "Passed."), shipped in 0.29.0 · Review 1: CLEARED WITH WOUNDS, fixed; recheck 2: CLEARED WITH WOUNDS · D8 added 2026-11-21; D1 reworded 2026-11-23, after 0.29.0 · D0 run for Claude Code only

## Context
The relaunch test asks fresh agent sessions 25 questions without naming NorthKeep. The connect-time text is only the milestone rule, in two hand-kept copies; the contract installer writes a third. `memory_retrieve` ranks project documents and log archives beside facts. Nothing marks a memory the user confirmed. Stale agent session notes outranked facts.

## Decision
- D0: Before building, a live check records, for Claude, Grok Bot, Codex and Muse, whether each passes server instructions to its model. Apps that do not get D2.
- D1: One wording, sent by both servers and placed in the contract text: search with `memory_retrieve` before answering or acting on anything about the user or a person, organization, property or project in their life, even when the agent's own notes seem to answer; read a named project with `project_get`; then the milestone rule. A test fails if a copy differs.
- D2: One stable sentence for apps that ignore server instructions, behind a copy button once Jay approves its mock.
- D3: `memory_retrieve` (device and connector) and the connector's `search` skip a live project document and any archive: a log archive (`isProjectLogArchive`) or a row NorthKeep marks `archive` (moved-out Decisions). Other project-scope memories stay searchable.
- D4: A memory is confirmed when its metadata holds `confirmed: {by: "user", at}`. Only the app and CLI set it; confirming supersedes the memory with the same content plus the marker. An agent write that supersedes a confirmed memory drops the marker.
- D5: A keyword match needs a word that is not a stopword, word-bounded on the connector; this gates admission and the boost. The boost only reorders.
- D6: Pushes carry `confirmed` and `archive` flags inside the encrypted row. The connector deploys before clients send it.
- D7: CLI `northkeep confirm <id>` and `remember --confirmed`, as Jay rarely opens the app.
- D8: An unconfirmed episodic memory an AI app wrote over 30 days ago ranks after every other match (Jay, 2026-11-21). The connector cannot see who wrote a row, so it does not apply this.

## Consequences
- Easier: one wording; confirmed facts outrank guesses.
- Harder: a confirm writes a row.
- Committed to: KNOWN-LIMITS says the instruction is advisory, a shell-capable agent can run `confirm`, and which apps pass instructions.

## Rejected
- Excluding all `project:*` scopes: drops facts agents need.
- A mutable confirmed column: only bookkeeping may change after creation.
- Letting agents confirm: an agent could promote its own memories.

## What leaves the machine
To each connected app: the instruction text. To the connector, shared scopes only: two flags per row (confirmed, archive) inside the ciphertext.

## Links
Design and review log: docs/design/adr-0084-found-first.md · Extends: ADRs 0039, 0067
