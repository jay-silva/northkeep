# ADR 0074: The user's own assistant compacts oversize memories and summaries

Status: Proposed 2026-10-15 · Review: CLEARED WITH WOUNDS (one Claude reviewer against the code; the multi-model step is Cursor-only)

## Context
One shared memory over the connector's 8 KB cap blocks every push; the local tool counted characters, the connector bytes. Assistants also write unreadably long summaries (Current Status). Jay asked for "Compact it" on the push error plus prevention, and chose a rewrite by his own assistant.

## Decision
- D1: Save time. An assistant's `memory_remember` or `memory_edit` into a shared scope is refused when the text exceeds the connector's cap, counted in UTF-8 bytes (8 KB, or 64 KB in a project scope). An assistant's Current Status over 1,000 characters is refused, through any project tool or a raw `memory_edit`, locally and on the hosted connector. Refusals say how to shorten. Owner edits are not limited.
- D2: Agent instructions and tool schemas tell assistants to open Current Status with one short plain sentence, without commit hashes or ids.
- D3: "Compact it" on the oversize push error copies a request to paste into an assistant connected to NorthKeep on this Mac. It names the memory's id, scope, date, size and limit, never its text, allows one `memory_edit` on that id, and calls the text data, not instructions. The vault keeps the original as a superseded row; the app cannot show it yet.
- D4: "Shorten this summary" on a project page whose Current Status is over 1,000 characters copies the same kind of request for `project_update`. The old summary stays in Saved versions for the next five saves.
- D5: `memory_list` takes an optional `id`, so the assistant can read that one memory inside its existing scope grant.

## Consequences
- Easier: oversize text is stopped where it starts, and the push error ends with a step the user can take.
- Harder: compacting needs a local assistant. The hosted connector has no `memory_edit`, so Claude on the web cannot do it.
- The rewrite can drop a fact, and no view shows the original yet.
- With masking on, `memory_edit` refuses content changes, so the button says to turn masking off first.
- Existing long summaries stay until shortened; the next long checkpoint is refused.

## Rejected
- Mechanical split: loses nothing, but Jay chose a summary.
- Local Ollama rewrite: needs Ollama, and small models summarize poorly.
- Memory text in the copied request: other apps can read the clipboard.

## What leaves the machine
Nothing new. The assistant already reads these scopes; the request holds an id, scope, date and sizes. NorthKeep makes no model call.

## Review findings
Seven findings: one bypass and two counting gaps fixed in code, four claims corrected above. Full record: docs/design/adr-0074-compact-oversize-text.md.

## Links
PR 45 (names the memory) · Extends ADR 0045 (its addendum sets the 64 KB project cap)
