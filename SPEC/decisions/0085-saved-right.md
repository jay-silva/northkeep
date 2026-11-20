# ADR 0085: Saved right: near-match check at save, a "replaces" field, every save stamped with its app

Status: Proposed 2026-11-20 (relaunch step 1, milestone 3) · Review 1: NOT CLEARED (cloud replaces skipped the user's confirmation), fixed in this revision; recheck pending · Merge waits for the milestone 1 baseline score

## Context
Save test: Jay tells one agent a fact, a fresh session of another knows it, and the vault holds it once with the old version marked replaced. `memory_remember` has no duplicate check and stamps `mcp` (server.ts:1047), though the schema says `mcp:<client>`. Connector saves carry no app name, and its retrieve and list print no ids.

## Decision
- D1: Stamp. Device saves record `mcp:<host>` from the tamed handshake name. Connector saves record the app's OAuth `client_name`, tamed by the same rule, in `metadata.connector.app`. Surfaces label both "reported by the app". When an agent supersedes a row, the new row carries the writer's stamp, not the old row's.
- D2: `replaces` on the device. `memory_remember` takes an optional id and then acts as `memory_edit` does: every `editMemory` guard, the Tier 1 text-save refusal, and the same scope as the old row. The new row drops any confirmed marker (ADR 0084 D4).
- D3: Save check, words only (no local model). Identical after normalizing: nothing written, existing id returned. Four words or more and overlapping above a floor on non-stopwords: held, and the reply asks for `replaces`, or `distinct: true`. Otherwise saved, and the reply lists up to three memories in that scope sharing its key words, with ids, as possible updates. NorthKeep never picks; replies pass return masking.
- D4: Connector. Retrieve and list show ids. A cloud `replaces` lands the new memory as an addition, but the replace itself waits for the user's confirmation, as connector forgets do today. The connector serves such rows only to clients that can hold that confirmation. Older builds and the phone never ack them.
- D5: A device agent may replace a confirmed memory. O1 for Jay: refuse until milestone 5. O2 for Jay: let cloud replaces of unconfirmed, agent-written rows apply without confirmation.

## Consequences
- Easier: fewer duplicate copies, and the record says which app wrote each one.
- Harder: agents meet a new refusal; cloud replaces queue for Jay until O2 or milestone 5.
- Committed to: KNOWN-LIMITS says the app name is self-reported, and reworded updates can slip past D3. Milestone 5's conflict check is the backstop.

## Rejected
- Meaning match by local model: the first customer has none.
- NorthKeep picking the newer memory: the plan forbids choosing between facts.
- Applying cloud replaces unconfirmed now: changes who decides with no decision from Jay.

## What leaves the machine
To the connected app: up to three memories from a scope it can already read, and ids. To the connector: a `replaces` id inside the existing ciphertext. It already knew the app name.

## Links
Design and review log: docs/design/adr-0085-saved-right.md · Depends on: ADR 0084 · Extends: ADRs 0015, 0039, 0050, 0063
