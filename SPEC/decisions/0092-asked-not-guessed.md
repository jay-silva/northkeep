# ADR 0092: Asked, not guessed: the app raises a disagreement it sees, NorthKeep records the answer under trust rules

Status: Proposed 2026-11-24 (milestone 5) · Draft: approach changed 2026-11-25 on Jay's word ("The app raises it"); two reviews logged; third review pending

## Context
Search returns memories that disagree. A word rule to find them raised 2 questions on the 130-memory bench, none real, and missed six real ones. Jay: "The app raises it"; "Chat counts"; "O1, yes"; "O2, no". Today a Cloud row loses its writer after one sync.

## Decision
- D1: Invite, not detect. Each search result with two or more memories carries one fixed NorthKeep note, apart from saved text: if two disagree and the user is here, ask, then call `memory_resolve`. It lists answered pairs by id.
- D2: `memory_resolve` takes two ids, the user's words, and first, second, both, or neither with the right fact. Both must be live, readable by this app, in one collection, unanswered.
- D3: NorthKeep sets the level by the shared rule. Level 2 (a user-confirmed memory, a waiting Cloud replacement, a digit among the differing words, a listed word) waits for ADR 0095's phone list.
- D4: An answer favouring a memory the answering app or an unknown writer wrote waits; so do answers past three applied a day, and "neither". Otherwise the winner gets `confirmed: {by: "chat", app, at, question}` and the other is marked replaced, never forgotten.
- D5: A Cloud save records a hash of its OAuth client id in the row ciphertext; the vault keeps it; pushes carry it back.
- D6: A Cloud answer changes nothing on the connector. The device applies it at a pull (ADR 0096 included) after re-checking it against its own rows, at most three a pull.
- D7: Undo ships first: `undo-answer`, `unmark`, the phone list.

## Consequences
- Easier: no word rule to be wrong; the note quotes no app text.
- Harder: a disagreement no app raises stays; schema 0.4 to 0.5 retires older servers and phones, so a phone release ships with it; pending version 4.
- Committed to: KNOWN-LIMITS lines; trusting the connector to relay answers honestly (Jay's call).

## Rejected
- NorthKeep's word rule, or a "these share most words" hint: 2 raised, 0 real, 6 missed.
- A daily sitting: no queue left to ration.
- Quoting both memories in the note: saved text in NorthKeep's voice.
- Checking the app was shown both ids: one search shows any.

## What leaves the machine
To the connected app: the note, and ids of answered pairs among its results. To the connector, Shared scopes only, inside ciphertext: each row's writer, the chat mark (app name, date), each answered pair's hash, state and date, a Cloud answer's words until the device takes them. In the clear: a record id, timestamps, a pending flag.

## Links
Design and review log: docs/design/adr-0092-asked-not-guessed.md · Depends on: ADRs 0085, 0095, 0096 · Shares decisions with 0094
