# ADR 0093: Tidies itself: four changes made alone, a cold tier, a list an agent can undo

Status: Proposed 2026-11-24 (relaunch milestone 6) · Draft: not reviewed, not accepted; the gate applies

## Context
Rule 19 lets NorthKeep, alone, merge near-identical memories, apply a declared replacement, move a memory unretrieved for 90 days to cold, and hold one that reads like an instruction, all listed and reversible. ADR 0043 D4 forbids automatic writes. No memory records its last use.

## Decision
- D1: Merge only memories with the same words in the same order, in one scope and type, ignoring case, punctuation, spacing and a/an/the. ADR 0085 holds a save at 60% shared weight; this needs every word and digit.
- D2: A merge copies nothing. The newest survives, or the confirmed one; the others are marked replaced and kept. Undo clears the mark. A confirmed memory is never merged away, moved or held.
- D3: Use comes from existing content-free logs: the device call log and the connector's audit table, folded into a last-used day per memory. Reads still write nothing.
- D4: Cold is a bookkeeping date, like "replaced". Search skips cold memories unless fewer than three others match; then they follow, labelled. One returned comes back at the next pass.
- D5: Held: a memory from an AI app or import that matches a fixed pattern list is saved, shown to no agent, and not sent to the connector. Only the owner reads or releases it.
- D6: Each change is a row in a new vault table, exported and synced. Device tools: `memory_tidy`, `memory_changes`, `memory_undo`. The connector offers the last two; a cloud undo waits for the owner ("O2, no").
- D7: The pass runs inside a save already under way, at most daily, or on request. No timer, no model.
- D8: ADR 0043 D4 and its "Rejected" line narrow: the model review still writes nothing alone; this pass may.

## Consequences
- Easier: repeats and unused memories stop crowding search; any agent can show and undo changes.
- Harder: a schema step; every device updates first.
- Committed to: KNOWN-LIMITS says merging catches only exact repeats, the hold list is a tripwire, and notes that keep being returned never go cold.
- Unproven: the bench's 91 to 95 came from facts an agent rewrote; D1 merges nothing there.

## Rejected
- Merging on shared search words: nine build notes differing by one digit match.
- Stamping last use on each search: every read becomes a save.
- Markers in metadata: each change copies the row.
- Choosing between memories that differ: milestone 5 asks.

## What leaves the machine
To the connector, shared scopes only, inside the ciphertext: a cold flag, and change records (ids, kind, day, app name). Held memories stop being sent. From the connector to the owner's device: memory ids with last-used days. To a connected app: changes to memories it can read, never held text.

## Links
Design: docs/design/adr-0093-tidies-itself.md · Changes: ADR 0043 · Extends: ADRs 0084, 0085, 0090 · Meets: milestone 5
