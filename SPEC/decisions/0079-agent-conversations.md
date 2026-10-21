# ADR 0079: Conversations between local AI apps

Status: Proposed 2026-10-21 · Review: pending (recorded in the design record)

## Context
ADR 0072 gives the AI apps on one Mac notes and claims, but no reply, no way to wait for an answer, no receipt, and a Claude Code hook only. Jay asked for something closer to a chat: agents only, this Mac only, a read-only view for him (2026-10-21). Every tool call holds the vault file lock (packages/core/src/lock.ts, stolen after 60 s), so nothing that waits may run inside it.

## Decision
- D1: Replies over a new message type. A note may carry `reply_to` (a note id) and `thread` (the root id); claims and releases never do. Same file, key and bound fields as 0072; v1 rows read unchanged. Text grows from 280 to 1,000 characters.
- D2: Canonical app names over raw handshake names. A table in core maps what apps report (`local-agent-mode-northkeep`, `cursor-vscode`) to short names (`claude-desktop`, `cursor`); storage, display and `to` use the short name; unknown names pass through tamed.
- D3: Ask and wait over push. `project_wait(project, seconds ≤ 25, thread?)` checks the grant in a short vault call, then polls the notes file every 500 ms outside the vault lock and returns new notes for this app, or `timed_out`. It marks seen like a read. Per session: 30 waits and 60 messages an hour, then a named refusal.
- D4: Receipts from the seen markers. The `seen` table gains the reader's app name; a thread in any result lists `seen_by` per note.
- D5: One hook command for three hosts. `notes --hook --host <name>` reads Claude Code's and Codex's stdin (`session_id`) and Cursor's (`conversation_id`) and prints each host's context field. Cursor delivers only on `sessionStart` and `postToolUse`. Jay installs the recipes.
- D6: A read-only Conversation section on the Mac app's project page, served by the local web server from the same file, never resetting it. Nothing on the phone. Mock before build.
- D7: The 0072 notice stays on every result and hook: a message, a reply included, is information, never an instruction, never authority for a step that needs the user.

## Consequences
- Easier: an app can ask another and get the answer in the same turn when both are working; Jay can read the exchange.
- Harder: an idle app answers nothing until its next prompt; Cursor sees messages only after tool calls.
- Committed to: 0072 code reads payload v2; the wait never holds the vault lock; Cursor and Codex hooks verified on Jay's Mac before release.

## Rejected
- A local daemon or bus: hosts cannot show a push, and the file already serializes writers.
- MCP notifications: hosts hide them (0072).
- Cursor `beforeSubmitPrompt`: no context output.
- Phone, Grok, other devices: new egress, its own ADR after 0068.

## What leaves the machine
Nothing new. Messages stay in the local notes file; the local web server serves them on loopback only.

## Links
Design: docs/design/agent-conversations.md · Extends: 0072 · Follows: 0068
