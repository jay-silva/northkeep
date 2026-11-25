# ADR 0094: Welcome: the interview runs in the agent the person already uses

Status: Proposed 2026-11-24 (milestone 8) · Draft: two reviews logged, revised 2026-11-25; third review pending

## Context
A new brain is empty; on 2026-11-24 an agent scored 24 of 25 only after ten facts were saved by hand. The first outside customer works in cloud apps, two of which ignore connect-time instructions. Reviews found the app, not NorthKeep, could set how much an answer counted.

## Decision
- D1: One tool, `welcome_interview`, on the device server and the connector: 21 fixed questions in 7 chunks, asked by the app.
- D2: NorthKeep sets each answer's level by the rule shared with ADR 0092. Questions about work, organizations, advisers, dealings, disputes, companies and properties always wait; so does any answer with a digit, a listed word stem or $ % € £. Waiting answers are saved unconfirmed and listed on the phone (ADR 0095). Others get `confirmed: {by: "chat", app, at}`. An identical answer marks nothing.
- D3: An item saves whole or not at all; a key appears once per call and closes once.
- D4: No chat mark is written until `northkeep unmark` and the phone list's unmark exist.
- D5: Answers go to `about-me`, which no writer defaults to. Progress is "welcome record" rows there, written only by NorthKeep, hidden from every app tool. Every app write path refuses record-shaped text; apps cannot forget a record.
- D6: "Stop" ends offers and answers; "not now" writes nothing. The person's starter line reopens a stopped interview; closed questions stay closed.
- D7: NorthKeep's text travels in its own block or field; saved text is flattened. NorthKeep never asks an app to change its instructions.
- D8: This ADR introduces pending version 5, which adds `chat` to pending rows; clients below it never receive `about-me` rows. Schema step 0.5 to 0.6 makes older device servers exit on their next call. The connector deploys first.

## Consequences
- Easier: a person fills the core in any connected app. With ADR 0096, answers reach the vault while any local NorthKeep server runs unlocked.
- Harder: the rule misfires both ways; on fictional answers it caught 37 of 42 with a listed stem and 1 of 24 without one, and held 13 of 24 harmless ones.
- Trusted: the connector service relays cloud answers and records honestly; the device re-checks each mark against the rule.
- Committed to: builds older than this one stop opening the vault.

## Rejected
- A Mac app screen; a daily offer counter; rewriting the instruction file; an import input.

## What leaves the machine
To each connected app: fixed questions, keys and counts. To the connector, once `about-me` is shared: answers, records, and each chat mark's app name and date, inside the ciphertext.

## Links
Design and review log: docs/design/adr-0094-welcome-interview.md · Depends on: ADRs 0084, 0085, 0092, 0095, 0096 · Amends: 0084 D4
