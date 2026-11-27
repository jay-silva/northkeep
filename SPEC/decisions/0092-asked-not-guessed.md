# ADR 0092: Asked, not guessed: the app raises a disagreement it sees, NorthKeep records the answer under trust rules

Status: Proposed 2026-11-24 (milestone 5) · Three reviews logged; revised 2026-11-25 to Jay's "answer the agent and then accept that" · Built 2026-11-27 on draft PRs, awaiting Jay's answers

## Context
A word rule to find disagreeing memories raised 2 bench questions, none real, and missed six. Jay: "The app raises it"; "O2, no"; on 2026-11-25, "just answer the agent and then accept that". His hand test passed with Grok Bot ("He asked me, and I answered") and Muse ("muse asked which one it was as well").

## Decision
- D1: Each search result with two or more memories carries one fixed NorthKeep note, apart from saved text: if two disagree and the user is here, ask, then call `memory_resolve`.
- D2: `memory_resolve` takes two live ids in one collection, the user's words, and first, second, both, or neither with the right fact.
- D3: An answer is accepted in chat, with no tap, only if: neither text has a digit or listed stem; neither memory is user-confirmed or under a waiting Cloud replacement; the winner is not known to be the reporting app's own; under three accepted today, "both" included; no earlier different, undone or declined answer. Else it waits for ADR 0095's phone list.
- D4: Accepted: the winner gets `confirmed: {by: "chat", app, at, question}`; the other is marked replaced, never forgotten. Each is listed on the phone with an Undo that restores what was there.
- D5: A Cloud answer changes nothing on the connector. A pulling device takes it into the vault's `questions` table, maps its ids, re-checks D3, and acknowledges it once the vault push carrying it lands.
- D6: Undo ships first, on ADR 0095's `clearReplaced(id, expectedBy)`.

## Consequences
- Easier: no word rule; an everyday answer needs no tap.
- Harder: a Cloud answer is decided at the Mac's next pull (Sync now, the command line), not instantly; the phone pulls additions only. Until then cloud apps see both memories. Schema 0.5 locks out older phones; pending version 4.
- Committed to: KNOWN-LIMITS lines; trusting the connector to relay answers honestly; a renamed app, or one assistant under two names, escapes the same-app rule.

## Rejected
- NorthKeep's word rule: 0 of 2 real.
- Nothing applies until a phone tap: offered; Jay chose "accept that".
- A writer hash on Cloud rows: rows already carry the app name.
- Quoting memories in the note: saved text in NorthKeep's voice.

## What leaves the machine
To the app: the note and ids of answered pairs. To the connector, Shared scopes only, in ciphertext: the chat mark (app, date), each answered pair's hash, state and date, and a Cloud answer's words until the device's push lands. In the clear: record id, timestamps, pending flag.

## Links
Design and review log: docs/design/adr-0092-asked-not-guessed.md · Depends on: ADRs 0085, 0095 · Shares decisions with 0094
