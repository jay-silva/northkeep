# ADR 0093: Tidies itself: exact repeats merged, unused private memories shelved, a list an agent can undo

Status: Proposed 2026-11-24 (milestone 6) · Draft: review 1 NOT CLEARED 2026-11-25, revised, recheck pending

## Context
Rule 19 lets NorthKeep merge near-identical memories and move one unretrieved for 90 days to cold, alone, listed and reversible. ADR 0043 D4 forbids automatic writes. No memory records its last use. The instruction hold is cut pending Jay.

## Decision
- D1: Merge only texts equal after lower-casing, collapsing whitespace and dropping one final full stop, in one scope and type. "O+" and "O-" never merge.
- D2: A merge copies nothing. A row with any confirmed mark is never merged away; one survives, two leave the group alone; otherwise the newest survives. The core step skips rows with consolidation lineage.
- D3: Nothing in a Shared scope is merged or shelved.
- D4: Use comes from the device call log: `memory_retrieve` results and `memory_list` by one id. An appended cold row counts only when it was the sole result. Only use logged after a memory went cold brings it back.
- D5: Cold is its own vault table, never a column on memories. Confirmed, identity and procedural memories never go cold. Search appends the best cold match, labelled in a separate field.
- D6: Each change is a vault row (ids, scope, kind, time, app), exported. Device tools `memory_changes`, `memory_undo`, `memory_tidy` filter by grant; out-of-grant ids read as not found. Undo uses ADR 0092's clear-replaced step. No connector tools.
- D7: Per rolling 24 hours, all triggers: at most 50 memories taken out of service, one automatic pass. An agent's acting `memory_tidy` takes ADR 0092's daily sitting.
- D8: The pass rides only a writing device save from an unscoped connection, with a 250 ms budget for linear work. Over budget or failing, it writes nothing and the save succeeds. `northkeep tidy` has no budget.
- D9: Schema 0.5 to 0.6 adds three tables. ADR 0043 D4 narrows: the model review still writes nothing alone.

## Consequences
- Easier: repeats and unused private memories stop crowding search.
- Harder: a schema step; devices update first.
- Committed to: KNOWN-LIMITS says merging catches only exact repeats, Shared scopes are untouched, and only AI-app use on the device running the pass counts.

## Rejected
- The 0085 normal form or NFKC: both fold symbols that change a fact.
- A `cold_at` column: it enters consolidation snapshot hashes.
- Cold in Shared scopes: pushes skip flag-only changes.
- The hold: held 10 of 12 honest rules, missed 4 of 4 reworded attacks.

## What leaves the machine
To the connected device app: change rows (ids, kinds, times, app names) and one-line excerpts of memories it can already read. To the connector, when on: ADR 0092's sitting claim, no content. New tables stay inside the encrypted vault.

## Links
Design and review log: docs/design/adr-0093-tidies-itself.md · Changes: ADR 0043 · Depends on: ADR 0092 · Extends: ADR 0085
