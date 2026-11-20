# ADR 0085: Saved right: near-match check at save, a "replaces" field, every save stamped with its app

Status: Proposed 2026-11-20 (relaunch step 1, milestone 3) · Review: pending (gate: who decides, untrusted input) · Merge waits for the milestone 1 baseline score

## Context
Save test: Jay tells one agent a fact, a fresh session of another knows it, and the vault holds it once with the old version marked replaced. `memory_remember` has no duplicate check and stamps `mcp` (server.ts:1048), though the schema says `mcp:<client>`. Connector saves carry no app name. Connector `memory_retrieve` and `memory_list` print no ids, yet `memory_forget` tells apps to use the ids `memory_list` shows.

## Decision
- D1: Stamp. Device saves record `mcp:<host>` from the tamed handshake name. Connector saves record the app's OAuth `client_name` in `metadata.connector.app`. Both are self-reported; every surface showing them says "reported by the app". New rows only.
- D2: `replaces`. `memory_remember` takes an optional id; the save then has `memory_edit`'s effect (new row, old row superseded) and inherits every `editMemory` guard, plus: same scope as the old row. `memory_edit` already grants this power, so ADR 0043 is unchanged here; its relaxation stays with milestone 6.
- D3: Near-match. A save without `replaces` is compared with live memories in its scope. Identical after normalizing: nothing written, existing id returned. Close (word overlap above a floor, or meaning match when the local search model runs): nothing saved; the reply lists up to three matches with ids and asks for `replaces`, or `distinct: true` if both are true. NorthKeep never picks. Without meaning match the reply says it checked by words only.
- D4: Connector. Retrieve, list and `search` show ids. D3 runs by words only, per request, storing nothing (invariant 2). `replaces` rides inside the encrypted row; the device applies it on down-sync with D2's guards, or lands a plain new memory and logs why.
- D5: Replacing a confirmed memory (ADR 0084) is allowed; the successor is unconfirmed. Open question O1 for Jay: refuse until milestone 5.

## Consequences
- Easier: one copy per fact; the record says which app wrote it.
- Harder: agents meet a new refusal; one more envelope field.
- Committed to: KNOWN-LIMITS says the app name is self-reported and cannot prove "Grok wrote this".

## Rejected
- Save anyway and return matches: duplicates stay whenever an agent ignores the reply.
- NorthKeep picking the newer memory: the plan forbids choosing between facts.
- Embeddings on the connector: invariant 2.

## What leaves the machine
To the connected app: up to three memories from a scope it can already read, and ids. To the connector: a `replaces` id inside the existing ciphertext. It already knew the app name.

## Links
Design: docs/design/adr-0085-saved-right.md · Depends on: ADR 0084 · Extends: ADRs 0015, 0039, 0050, 0063
