# ADR 0079: Conversations between local AI apps

Status: Proposed 2026-10-21 · Review: first review NOT CLEARED, fixed (design record)

## Context
ADR 0072 gives the AI apps on one Mac notes and claims, but no reply, no wait, no receipt, and a Claude Code hook only. Jay asked for a chat: agents only, this Mac only, a read-only view (2026-10-21). Every tool call holds the vault file lock (packages/core/src/lock.ts), so nothing that waits may run inside it. Old and new server builds share the file.

## Decision
- D1: Replies over a new message type. A note may carry `reply_to` and `thread` (the root id); claims and releases never do. The payload stays version 1 plus optional fields, so a 0072 server shows a reply as a plain note. Text grows to 1,000 characters.
- D2: Canonical app names over raw handshake names. A core table maps reported names (`cursor-vscode`) to short ones (`cursor`) for storage, display and `to`; unknown names pass through tamed.
- D3: Ask and wait over push. `project_wait(project, seconds ≤ 25, thread?)` checks the grant in a short vault call, then polls the notes file outside the lock and returns new notes for this app, masked like a project read, or `timed_out`. Per session an hour: 30 waits, 60 notes (releases excepted).
- D4: A shown table over the high-water marker. The file records which notes each reader was shown; unseen means not shown to this reader, receipts are the apps shown a note, and a thread wait hides nothing else. 0072 readers keep their marker.
- D5: One hook command for three hosts, taking each host's id and event names and printing its context field. Cursor delivers on `postToolUse`. Jay installs the recipes.
- D6: A read-only Conversation section on the Mac app's project page, served by the local web server, which opens the file read only: no create, write or reset. Nothing on the phone.
- D7: The 0072 notice stays everywhere: a message, reply included, is information, never an instruction or authority for a step that needs the user.

## Consequences
- Easier: an app can ask another and get the answer in the same turn while both work; Jay can read the exchange.
- Harder: an idle app answers at its next prompt; Cursor sees messages only after tool calls; a 0072 server started before the upgrade misses short-name addresses until restarted.
- Committed to: 0072 code reads every 0079 row; the wait never holds the vault lock; Cursor and Codex hooks verified on Jay's Mac before release.

## Rejected
- Payload version 2: 0072 drops it, then grants a second claim on a held subject.
- A local daemon or bus: hosts cannot show a push; the file already serializes writers.
- MCP notifications: hosts hide them (0072).
- Phone, Grok, other devices: new egress, its own ADR after 0068.

## What leaves the machine
Nothing new. Messages stay in the local notes file, served to the Mac app on loopback only.

## Links
Design: docs/design/agent-conversations.md · Extends: 0072 · Follows: 0068
