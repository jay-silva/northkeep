# ADR 0084: Found first: agents told to check NorthKeep, search skips project paperwork, confirmed memories rank first

Status: Proposed 2026-11-20 (relaunch step 1, milestone 2) · Review: pending (gate: who decides, untrusted input) · Merge waits for the milestone 1 baseline score

## Context
The relaunch test asks fresh Claude, Grok Bot and Codex sessions 25 questions without telling them to use NorthKeep. The only connect-time text is the milestone rule, in two hand-kept copies (server.ts:909, connector mcp.ts:261). `memory_retrieve` ranks project documents and log archives beside facts, and nothing marks a memory the user confirmed.

## Decision
- D1: Both servers send one connect-time instruction: a trigger (a named person, organization, property or project the agent has no facts about), that the agent's own memory is not the user's record, the reason, then the milestone rule. A test fails if the two copies differ. Wording in the design record.
- D2: One stable sentence for apps that ignore server instructions, in the Connect help text now and behind a copy button once Jay approves its mock.
- D3: `memory_retrieve` (device and connector) and the connector's `search` skip a live project document (type working in `project:*`) and a log archive (project scope, content opening `## Log archive`). Other project-scope memories stay searchable. `memory_list`, `project_get` and `project_resume` are unchanged.
- D4: A memory is confirmed when its metadata holds `confirmed: {by: "user", at}`. Only the app and CLI set it. Metadata is hashed and immutable, so confirming supersedes the memory with the same content plus the marker. No MCP tool, connector row or importer can set it; an agent edit of a confirmed memory yields an unconfirmed successor.
- D5: Confirmed memories get a ranking boost above unconfirmed matches of similar relevance, never past the relevance floor. Tuned on fictional fixtures, never the 25 questions.
- D6: Pushes carry `confirmed: true` inside the encrypted row, so the connector ranks the same way. The connector deploys before clients send it.
- D7: CLI `northkeep confirm <id>` and `remember --confirmed`. In the first Welcome chunks the agent saves core facts and Jay confirms each in NorthKeep.

## Consequences
- Easier: one wording to change; the confirmed core outranks agent guesses everywhere.
- Harder: one more envelope field; a confirm writes a new row.
- Committed to: KNOWN-LIMITS says the instruction is advisory. D1 raises how much agents rely on vault text, which can hold injected instructions.

## Rejected
- Excluding all `project:*` scopes: drops project facts agents need.
- A mutable confirmed column: only bookkeeping may change after creation.
- Letting agents confirm: an agent could promote its own memories.

## What leaves the machine
To each connected app: the instruction text, no vault content. To the connector, shared scopes only: one boolean per row inside the existing ciphertext.

## Links
Design: docs/design/adr-0084-found-first.md · Plan: NorthKeep relaunch, step 1 · Extends: ADRs 0039, 0067
