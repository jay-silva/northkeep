# ADR 0092: Asked, not guessed: conflicts noticed, asked through the agent in use, answered at two levels

Status: Proposed 2026-11-24 (milestone 5) · Draft: review 1 NOT CLEARED 2026-11-25, revised, recheck pending

## Context
Two live memories can disagree, and search serves both. The plan: the app in use asks once, cleanup is rationed, NorthKeep never picks. Grok Bot and Muse ignore connect-time instructions. Jay: "Chat counts" for everyday facts; "O1, yes"; "O2, no". Today a Cloud row loses its writer after one sync, and nothing undoes a replace.

## Decision
- D1: Notice, words only, one collection. The newer memory must meet ADR 0085's 60% rule against the older; then their whole-word `saveNormalForm` lists must differ, add a negation, or, for a newer longer memory containing the other, add a name or number. Never two episodic memories.
- D2: Writer. A Cloud save records a hash of its OAuth client id inside the row ciphertext; the vault keeps it in `metadata.connector.writer`; pushes carry it back. An unknown writer counts as the answering app.
- D3: Queue. A `questions` table (schema 0.4 to 0.5), keyed by a hash of both texts, exported. Shared pairs mirror to the connector as ciphertext and travel like rows.
- D4: Delivery. A separate NorthKeep block or field on search and save results, memory text folded to one fenced line; one tool, `memory_resolve`.
- D5: Levels. `confirmed: {by: "chat"}` ranks between none and `by: "user"`. Money, ownership, accounts, legal words, a user-confirmed memory, or a waiting Cloud replacement make level 2: only NorthKeep itself settles it.
- D6: Level 1 on the device applies at once; the chosen memory gets the chat mark unless the answering app wrote it. A Cloud answer applies at the next pull, rechecked, without a further yes; never for the app's own memory. "Neither" saves the fact unconfirmed and waits.
- D7: Undo ships first: a command and a Mac app action.
- D8: Ration. One sitting a day, three questions, per account.

## Consequences
- Easier: disagreements surface where Jay already is.
- Harder: a schema step retires running older servers.
- Committed to: re-measuring on the bench vault before shipping; KNOWN-LIMITS on word-only misses, reported answers, Cloud answers waiting for a pull, renamed device apps.

## Rejected
- Questions in connect-time instructions: two apps ignore them.
- NorthKeep preferring the newer memory: the plan forbids it.
- A background pull: changes who decides; deferred.
- Cloud replacements in the queue: they stay in ADR 0085's review.
- `searchTerms` for differences: drops single digits and "not".

## What leaves the machine
To the connected app: the question block, quoting two memories it can read. To the connector, Shared scopes only, inside ciphertext: question records (pair hash, ids, state, answer, quoted words, answering app and client hash), each row's writer kind, the chat mark. In the clear: a random question id, timestamps, the ration day, the device's UTC offset.

## Links
Design and review log: docs/design/adr-0092-asked-not-guessed.md · Depends on: ADRs 0084, 0085, 0090 · Shares decisions with 0093, 0094
