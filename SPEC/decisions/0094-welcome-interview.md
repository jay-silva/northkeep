# ADR 0094: Welcome: the interview runs in the agent the person already uses

Status: Proposed 2026-11-24 (milestone 8) · Draft: review 1 NOT CLEARED 2026-11-25, revised, recheck pending

## Context
A new brain is empty; on 2026-11-24 an agent scored 24 of 25 only after ten facts were saved by hand. The first outside customer works only in cloud apps, two of which ignore connect-time instructions. Review 1 found the app, not NorthKeep, chose how much each answer counted.

## Decision
- D1: One tool, `welcome_interview`, on the device server and the connector: a fixed script of 21 questions in 7 chunks, asked by the app.
- D2: NorthKeep decides each answer's level. Answers are accepted only for open questions, and none once the interview ends. Company and property questions wait for the person. On other questions, a fixed list of ownership, money, account and legal words, or $, %, € or £, makes the answer wait. Others get `confirmed: {by: "chat", app, at}`, ranked between unconfirmed and confirmed. An identical answer marks nothing. Facts an app recalls go through `memory_remember`, unconfirmed. Chat marks ship only once ADR 0092's undo exists.
- D3: Answers go to a new collection, `about-me`, that no writer defaults to. Sharing it states how many memories it shares.
- D4: Progress is a "welcome record" row in `about-me`: fixed words and question keys, recognized by its text, hidden from every agent tool and the save check.
- D5: Answers pass ADR 0085's save check; a held answer leaves its question open.
- D6: NorthKeep's own text travels in its own block. Connector memory lines are flattened. An answer is one line of at most 300 characters, not opening with "NorthKeep".
- D7: It starts from a line the person sends (shown in setup and on the connect page) or a note on an empty `memory_retrieve` result. NorthKeep never asks an app to change its instructions.
- D8: Connector rows carry `chat` inside the ciphertext, on push and pending v4 (ADR 0092). The connector deploys first and withholds marked rows and records from older clients.

## Consequences
- Easier: a person fills the core in any connected app.
- Harder: an ownership fact with no listed word, filed under an everyday question, still gets the chat mark; the list misfires both ways.
- Committed to: KNOWN-LIMITS says cloud answers reach the vault only on a pull, and ownership answers need `northkeep confirm` in a terminal.

## Rejected
- A Mac app screen; a progress table the connector cannot see.
- A daily offer counter: a connector database change.
- Rewriting the instruction file at start: the dismissal lives in the Mac app's browser storage.
- An import path inside the tool; reading mail.

## What leaves the machine
To each connected app: fixed questions, ids and counts. To the connector, once `about-me` is shared: answers, records, and app and date per marked row, inside the ciphertext.

## Links
Design and review log: docs/design/adr-0094-welcome-interview.md · Depends on: ADRs 0084, 0085, 0092 (undo, chat mark) · Amends: 0084 D4
