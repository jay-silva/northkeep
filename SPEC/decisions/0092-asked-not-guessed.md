# ADR 0092: Asked, not guessed: conflicts noticed, asked through the agent in use, answered at two levels

Status: Proposed 2026-11-24 (milestone 5) · Draft: not reviewed, not accepted · D5: Jay, 2026-11-24, "Chat counts"

## Context
Two live memories can state different facts, and search serves both. The plan: the agent asks once at the moment of use, cleanup comes through that agent under a daily ration, NorthKeep never picks. Grok Bot and Muse ignore connect-time instructions and reach NorthKeep only through the Cloud connector. Jay rarely opens the Mac app; no local model.

## Decision
- D1: Notice, words only. Two live memories may conflict when they pass ADR 0085's near-match rule and each holds a word or number the other lacks, or only one holds a negation. Checked at save and among search results, device and connector.
- D2: Queue. A `questions` table in the vault (schema 0.4 to 0.5), exported. Each pair is asked about once. A question whose memories are both in Shared scopes is copied to the connector as ciphertext holding ids only.
- D3: Delivery. A fixed block appended to `memory_retrieve` and `search` results, not the connect-time instructions. One new tool, `memory_resolve`, on both servers.
- D4: Two levels. `confirmed: {by: "chat", app, at}` is new and ranks between unconfirmed and `by: "user"`, which is unchanged and set only in NorthKeep itself. A pair naming ownership, money, accounts or legal matters, touching a `by: "user"` memory, or holding a waiting cloud replace changes nothing until confirmed in NorthKeep itself.
- D5: A chat answer to a question NorthKeep opened applies at once for everyday facts, from cloud apps too. The losing memory is marked replaced, never forgotten. A cloud app cannot settle a question in favour of a memory it wrote.
- D6: Ration. One sitting a day, at most three cleanup questions, counted once per account: on the connector when it is on, otherwise in the vault. A device that cannot reach the count offers none.

## Consequences
- Easier: disagreements surface where Jay already is.
- Harder: a schema step retires running older servers; a new connector tool is a production deploy.
- Committed to: KNOWN-LIMITS says word matching misses conflicts sharing no distinctive word, flags some pairs that agree, and that an agent can report an answer the user never gave.

## Rejected
- Questions in connect-time instructions: two apps ignore them.
- Silently preferring the newer memory: the plan forbids it.
- A ration counter per app: each would ask three.
- A chat answer setting `by: "user"`: an agent could promote its own memory.

## What leaves the machine
To the connected app: the question block, quoting two memories it can already read. To the connector, Shared scopes only: question records inside ciphertext (ids, state, answering app, the user's quoted words). In the clear there: a random question id, timestamps, the ration count, the device's UTC offset.

## Links
Design: docs/design/adr-0092-asked-not-guessed.md · Depends on: ADRs 0084, 0085, 0090
