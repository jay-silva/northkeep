# ADR 0085: Saved right: near-match check at save, a "replaces" field, every save stamped with its app

Status: Proposed 2026-11-20 (relaunch step 1, milestone 3) · Reviews 1 to 3 in the record (review 3: CLEARED WITH WOUNDS, fixed)

## Context
Save test: Jay tells one agent a fact, another agent knows it, and the vault holds it once with the old version marked replaced. `memory_remember` has no duplicate check and stamps `mcp`, though the schema says `mcp:<client>`. Connector saves carry no app name, and its retrieve and list print no ids.

## Decision
- D1: Stamp. Device saves record `mcp:<host>` from the tamed handshake name. Connector saves record the app's OAuth `client_name`, tamed the same way, in `metadata.connector.app`. Surfaces label both "reported by the app". A superseding row carries the writer's stamp.
- D2: `replaces` on the device. `memory_remember` takes an optional id and then acts as `memory_edit` does: every `editMemory` guard, the Tier 1 text-save refusal, the old row's scope. A project document is refused. The new row is unconfirmed (ADR 0084 D4).
- D3: Save check, words only (no local model), against live memories in the same scope, never project documents or archives. Identical after normalizing: nothing written, the existing id returned. Held when a memory shares two or more of its words and they carry 60% of the save's weight, words weighed by rarity as in ADR 0090: the reply lists up to three with ids and asks for `replaces` or `distinct: true`. Otherwise saved; NorthKeep never picks. Replies pass return masking.
- D4: Connector. Retrieve and list show ids. A cloud `replaces` lands the new memory as an addition; the replace waits in its own connector queue, like `pending_forgets`, until the user confirms it on a device, and until then cloud apps see both memories. Only clients on a new protocol version read that queue. The connector runs D3 too.
- D5: A device agent may replace a confirmed memory (Jay, 2026-11-21, "O1, yes"). Cloud replaces always wait for Jay's confirmation, even of agent-written rows ("O2, no").

## Consequences
- Easier: fewer duplicates; the record says which app wrote each memory.
- Harder: agents meet a new refusal; cloud replaces wait for Jay until milestone 5.
- Committed to: KNOWN-LIMITS says the app name is self-reported, short or reworded updates slip past D3, and D3 holds some unrelated saves. Milestone 5 is the backstop.

## Rejected
- Meaning match by local model: the first customer has none.
- Holding on any two shared words: held most ordinary saves (recheck 2).
- NorthKeep picking the newer memory: the plan forbids it.
- Applying cloud replaces unconfirmed: Jay said no (O2).

## What leaves the machine
To the connected app: up to three memories it can already read, and ids. To the connector: which shared memory replaces which, in the replace queue it can read. It already knew the app name.

## Links
Design and review log: docs/design/adr-0085-saved-right.md · Depends on: ADR 0084 · Extends: ADRs 0015, 0039, 0050, 0063
