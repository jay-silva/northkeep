# ADR 0094: Welcome: the interview runs in the agent the person already uses

Status: Proposed 2026-11-24 (relaunch step 1, milestone 8) · Draft: not reviewed, not accepted

## Context
A new brain is empty. On 2026-11-24 an agent scored 24 of 25 only after about ten plain facts were saved by hand. The first outside customer will not type facts into a form or open the Mac app; two of his apps ignore connect-time instructions and have no "new chat". Nothing in the repo runs an interview.

## Decision
- D1: One new tool, `welcome_interview`, on the device server and the Cloud connector. Each call takes answers and returns the next questions. NorthKeep holds the script and the place; the agent talks. No Mac app screen.
- D2: Seven chunks, at most six questions each, fixed in code, no model. Chunk 1 alone captures the ten facts.
- D3: Progress is kept as small "Welcome record" rows in the interview's scope, added and never rewritten, which search skips. No schema step.
- D4: Everyday answers are saved as confirmed in conversation, with the app and date. Ownership, money, accounts and legal answers are saved unconfirmed and listed for the person to confirm in NorthKeep. Only this tool sets the conversation mark. This amends ADR 0084 D4.
- D5: Every answer passes ADR 0085's save check. A held answer goes back to the agent to ask "same or different"; NorthKeep never picks.
- D6: It starts from a line the person sends once, shown in setup and on the connect page, or from a one-line offer added to a search result, at most daily per surface.
- D7: Past chats: only what the app already remembers, on request, each item accepted or skipped. Mailboxes are out.
- D8: The device server refreshes NorthKeep's own unedited instruction block at start, without the Mac app.

## Consequences
- Easier: a new person fills the core in five minutes in any connected app, resuming in another.
- Harder: a connected app can mark an everyday fact confirmed by claiming the person said it.
- Committed to: KNOWN-LIMITS says the conversation mark is the app's word and the mail rule is advice. The review gate applies: D4 changes who decides; D1 changes the connector.

## Rejected
- A Mac app screen: the owner rarely opens it; a cloud-only person has none.
- A progress table or `vault_meta` key: the connector sees neither, and older builds refuse a newer schema.
- One progress row rewritten each time: cloud replaces wait for the person (ADR 0085 D4).
- All answers unconfirmed: nobody would confirm them.
- Reading mail now: a new reader of untrusted text needs its own review.

## What leaves the machine
To each connected app: the fixed questions and a count of answers awaiting confirmation. To the connector, shared scopes only, inside the existing ciphertext: Welcome record rows, plus two new fields per row (conversation mark, question key). No new recipient.

## Links
Design: docs/design/adr-0094-welcome-interview.md · Depends on: ADRs 0084, 0085 · Amends: 0084 D4
