# ADR 0094: Welcome: the interview runs in the agent the person already uses

Status: Proposed 2026-11-24 (milestone 8) · Draft: three reviews logged, revised 2026-11-25; not yet re-reviewed

## Context
A new brain is empty: on 2026-11-24 an agent scored 24 of 25 only after ten hand-saved facts. The first outside customer runs nothing local, so nothing pulls for him. Jay chose answers accepted in chat for everyday facts.

## Decision
- D1: One tool, `welcome_interview`, on the device server and the connector: 21 fixed questions in 7 chunks, asked by the app. Answers go to `about-me`, which no writer defaults to.
- D2: NorthKeep sets each answer's level with ADR 0092's shared rule. Eleven questions always wait: work, companies, colleagues, advisers, never contact, organizations, dealings, properties, projects, always ask, disputes. On the other ten, a digit, money symbol or listed stem makes it wait.
- D3: Only a device marks `confirmed: {by: "chat", app, at}`: the device server at once, a cloud answer at a device's next pull after re-checking. The connector lifts a marked row only once a device pushed it.
- D4: Every waiting or accepted answer is a `confirm` row in ADR 0092's question table, on ADR 0095's phone list with Yes or Undo. Nothing is marked before `northkeep unmark` and that Undo exist.
- D5: Progress (closed questions, stop, reopen) lives in "welcome record" rows only NorthKeep writes, recognised by the archive mark no app can set, not by text. Apps cannot list, edit or forget them.
- D6: "Stop" ends offers and answers; the starter line reopens; closed questions stay closed.
- D7: NorthKeep's text stays apart from saved text. The offer note ships: Grok Bot passed the hand test.
- D8: Pending version 5 adds the archive mark to pending rows; older clients never receive a record. No schema step.

## Consequences
- Connector only: every cloud app finds his answers at once, unconfirmed; nothing is marked, so nothing needs undoing.
- With the phone: its pull brings answers into his vault, marks those that pass and lists all. Cloud apps see the lift after a device pushes (ADR 0095's open question).
- Harder: the rule misfires both ways (fictional answers: 20 of 24 risky ones without listed words passed; 14 of 24 harmless ones waited).
- Trusted: the connector relays cloud answers honestly; a device re-checks the rule, not that the person spoke.

## Rejected
- Nothing accepted until a phone tap: Jay chose ease, "just answer the agent and then accept that."
- Records recognised by text: the connector cannot clean up forgeries.
- A schema step: an old server could only close or stop, as any app can.
- A Mac app screen; a daily offer counter; imports.

## What leaves the machine
To each connected app: fixed questions, keys and counts. To the connector, once `about-me` is shared: answers, records, and ADR 0092's chat field, inside the ciphertext.

## Links
Design and review log: docs/design/adr-0094-welcome-interview.md · Depends on: ADRs 0084, 0085, 0092, 0095 · Amends: 0084 D4
