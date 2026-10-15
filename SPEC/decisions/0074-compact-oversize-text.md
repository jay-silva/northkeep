# ADR 0074: The user's own assistant compacts oversize memories and summaries

Status: Proposed 2026-10-15 · Review: pending

## Context
One shared memory over the connector's 8 KB cap blocks every push to Cloud Connect; the local tool counted characters, the connector bytes. Assistants also write unreadably long project summaries (Current Status): Jay's is 1,339 characters and opens with commit hashes. Jay asked for a "Compact it" offer on the push error and for prevention, and chose a rewrite by his own assistant.

## Decision
- D1: Save time. An assistant's `memory_remember` or `memory_edit` into a shared scope is refused when the text exceeds the connector's cap, counted in UTF-8 bytes (8 KB, or 64 KB in a project scope). An assistant's Current Status over 1,000 characters is refused, locally and on the hosted connector. Both refusals say how to shorten. Owner edits in the app are not limited.
- D2: Agent instructions and tool schemas tell assistants to open Current Status with one short plain sentence, without commit hashes or ids.
- D3: "Compact it" on the oversize push error copies a request for the user to paste into an assistant connected to NorthKeep on this Mac. The request names the memory's id, scope, saved date, size and limit, never its text. The assistant reads the memory, rewrites it below the limit with `memory_edit`, and the original stays in the memory's history.
- D4: "Shorten this summary" on a project page whose Current Status is over 1,000 characters copies the same kind of request for `project_update`. Earlier text stays in Saved versions.
- D5: `memory_list` takes an optional `id`, so the assistant can read that one memory inside its existing scope grant.

## Consequences
- Easier: oversize text is stopped where it starts, and the push error ends with a step the user can take.
- Harder: compacting needs a local assistant. The hosted connector has no `memory_edit`, so Claude on the web cannot do it.
- The rewrite is the assistant's. It can drop a fact; the original stays restorable from history.
- Existing long summaries stay until shortened; the next long checkpoint is refused.

## Rejected
- Mechanical split: loses nothing, but Jay chose a summary.
- Local Ollama rewrite: works only where Ollama is installed, and small models summarize poorly.
- Memory text in the copied request: other apps can read the clipboard.

## What leaves the machine
Nothing new. The assistant already reads these scopes under its grant. The copied request holds an id, a scope name, a date and sizes. NorthKeep makes no model call.

## Review findings
Pending.

## Links
PR 45 (names the memory) · Extends ADR 0045 (its addendum sets the 64 KB project cap)
