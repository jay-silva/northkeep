# Design record: ADR 0085, Saved right

Milestone 3 of relaunch step 1. Overflow for the ADR, plus the review log.

## Who decides, before and after

| Action | Today | After |
|---|---|---|
| Device agent replaces a memory | `memory_edit` (editMemory guards; Tier 1 text refusal in the handler) | the same, plus `replaces` on save with the same guards and a same-scope rule |
| Cloud app replaces a memory | not possible (the connector has no `memory_edit`; forgets wait for the user) | the new memory lands; the replace waits for the user, like a forget |
| Identical save | a second row | no row; the existing id is returned |
| Save whose words are mostly held by a live memory in its scope (two or more shared words carrying 60% of the save's weight; see the 2026-11-24 sections) | a second row | held; up to three listed; the agent chooses `replaces` or `distinct` |
| Other save | saved | saved |
| Which memory wins | nobody | still nobody (plan, question 19) |
| App name on a save | `mcp` or `connector:<host>` | the app's own name, labelled self-reported; on a replace, the replacing app's |

## D1 and D2 primitive changes

`supersedeEntry` (vault.ts) copies the old row's `source` and `metadata`. For actor agent it must instead take the writer's stamp and drop `confirmed`. This also changes `memory_edit`, which is intended. The connector's `client_name` is tamed with `tameHandshakeField` (80 characters, no control or bidi characters) before it is stored. The DCR path stores it unchecked today (provider.ts:82).

## D3 details

- Normalize: Unicode NFC, lower case, collapse whitespace, strip sentence punctuation at word edges (changed after merge; see the last section).
- Hold (rule superseded on 2026-11-24, see the end of this record; the first version held on any two shared non-stopword words): the reply lists the top three by overlap, with ids. Nothing is saved until the agent calls again with `replaces` (one row, old marked replaced) or `distinct: true`. This is where reworded updates ("is now at Pier 9") get caught. An earlier save-then-list version left two live rows when the agent followed its advice (recheck R-D3).
- A capitalized-word rule was dropped: any memory naming the user matched everything.
- Words only on both surfaces. Review 1 measured local meaning match at a 0.9 cosine: it never fired, and no threshold separated updates from distinct facts. The no-local-model rule removes it anyway.
- The reply is built through the return-masking path, never as a thrown error.

## D4 protocol

`RowPlain` gains an optional `replaces`. The new memory is delivered as an ordinary addition. The replace goes into a connector queue of its own, modelled on `pending_forgets`, because a pending row is acked or deduped on the next sync and would lose the link (recheck R-D4). Only clients that announce support (the ADR 0063 `?v=` pattern) read the queue. The desktop lists each entry beside connector forgets, which already need confirmation (`connector-client.ts:431-433`). Applying one needs a primitive that does not exist today: mark an existing row `superseded_by` another existing row. `supersedeEntry` always creates a new row. The phone and older builds never see the queue.

## Jay's answers (2026-11-21)

- O1, replacing a confirmed memory from a device agent: allowed, with an unconfirmed successor ("O1 , yes").
- O2, cloud replaces of unconfirmed, agent-written rows: always wait for confirmation ("O2, no"). Held replaces queue until milestone 5's phone confirmations.

## Acceptance test (draft; the final commands land with the code)

On a throwaway vault and home, with two local MCP clients (for example Claude Code and Codex):

1. Run `export NORTHKEEP_HOME=$(mktemp -d) NK=$NORTHKEEP_HOME/vault.nkv`, run `northkeep --vault $NK init`, and point both clients at it.
2. Tell client A: "Remember that the harbor office is at Pier 4." Say it again. The vault holds one row.
3. Tell client B: "The harbor office is now at Pier 9." Client B's first save is held with the Pier 4 memory listed, and client B saves again with `replaces`.
4. Run `northkeep --vault $NK export`. The Pier 4 row has `superseded_by` set to the Pier 9 row. The Pier 9 row's `source` names client B.
5. A fresh client A session, asked "where is the harbor office?", answers Pier 9.

## Review log

Review 1 (fresh eyes, 2026-11-20): NOT CLEARED.
- Kill shot: a cloud `replaces` would have applied without the confirmation that connector forgets get, on the false premise that `memory_edit` already allowed it (the connector has none). Fixed by D4 holding it.
- Wounds fixed:
  - A replace kept the old app's stamp. Now D1 stamps the writer.
  - The confirmed marker survived. Now ADR 0084 D4 drops it.
  - The near-match missed rewordings. Now the possible-updates list catches them, and the remaining gap is recorded as a limit.
  - Tier 1 refusal: the guard lived in the handler. It is now named in D2.
  - Phone and old builds would have acked and lost the replace. Now the protocol version gate covers them.
  - Connector app names were unchecked. Now they are tamed.
  - The acceptance step could not show a replaced row. It now uses export.
- Accepted scar tissue: reworded updates that share no key words still save as a second row. Milestone 5's conflict check was named as the backstop; see the correction under "What it misses".

Recheck (2026-11-20): CLEARED WITH WOUNDS. The kill shot and the prior wounds are closed. The fix introduced two wounds, both fixed after the recheck and not yet rechecked:
- Save-then-list duplicated rows. D3 now holds the save instead.
- A held cloud replace had no store. D4 now gives it its own connector queue.

Build notes:
- The connector needs its own copy of `tameOneLine`, since core's text-safe module cannot be imported there.
- The cloud path of the save test is not exercised while O2 holds cloud replaces.

Second recheck (2026-11-21, Jay asked for it): CLEARED WITH WOUNDS. The duplicate-row and held-replace wounds are closed. Still open, and introduced by the D3 fix: the hold rule (any two shared non-stopword words) holds most ordinary saves. A two-word name is enough to trigger it, and a project document matches most notes in its scope, though it can never be replaced. Proposed fix, not yet applied, since another round needs Jay's ask: drop project documents and archives from the candidates, as ADR 0084 D3 already does for search, and require the shared words to make up most of the new save's distinctive words, instead of any two. Notes:
- "What leaves the machine" must add that the connector can read the replace queue's entry ids.
- D4 must say whether the old row stays visible to cloud apps while its replace waits.
- The stopword list must be named in code, with a test.

## D3 and D4 revised (2026-11-24)
Jay asked for milestone 3 to start and approved a third review ("Review 85"). The revision below is the text after that review; what the review changed is listed in the next section.

The rule, exactly. Candidates are the live memories in the save's own scope, leaving out project documents, log archives and rows marked as archives, the rows ADR 0084 D3 keeps out of search. Let N be the number of candidates; the save itself is not counted. Words are `searchTerms` of the text (ADR 0084: the named `SEARCH_STOPWORDS` list, plural folding, words of two or more letters or digits). A word's weight is ln((N + 10.5) / (n + 0.5)), where n is the number of candidates holding it. A word no candidate holds has n = 0 and so the highest weight: in a save, the new word is the new information. The save's cover by a candidate is the weight of the save's words that the candidate also holds, divided by the weight of all the save's words. The save is held when some candidate shares at least two words with it and covers at least 60% of it. Only the save's side is measured. This needs one new function beside `wordWeights` in the drift-tested block (ADR 0090 D7), because `wordWeights` gives an absent word no weight.

Measured on the brain bench's fictional vault (130 memories, each tried as a new save against the others in its scope): any two shared words holds most saves, as recheck 2 found. At 40% cover, 38 are held; at 50%, 27; at 60%, 22; at 70%, 17. The bench vault is on PR 84, not on this branch, so the figure cannot be rerun from here until that merges. At 60% the held saves include real updates that repeat the old fact's words ("Rent at 12 Quarry Road is $2,300 a month" against "Rent at 12 Quarry Road went to $2,450 a month…", a security deposit, a holiday roster, a pet and a job each recorded twice) and some that are not updates: two boats on the same route, two companies that share a first name, a series of near-identical build notes, and a short fact whose words all sit inside a longer unrelated one.

What it misses, by design and by measurement:
- An update that shares fewer than two distinctive words with the old fact. "Rent is $2,450" against "Rent is $2,300" shares only "rent"; "My accountant is now Priya Shah" against "My accountant is Leo Marsh" shares only "accountant". Both save as second copies. One shared word cannot be the rule: it would hold almost every save about a known person or place.
- A long update of a short fact, since only the save's side is measured.
- Text with no Latin letters or digits yields no words, so it is saved unchecked.
A later conflict check was meant as the backstop for all three; as drafted on 2026-11-25 (ADR 0092) it does not catch the first, so nothing does today.

How an agent gets through a hold. `distinct: true` always saves; there is no loop. An identical save returns the existing id whether or not `distinct` is set. At privacy Tier 1 a save is allowed but a replace is refused, as `memory_edit` is today, so the hold reply says that `replaces` is not available and offers `distinct` only.

`replaces`, exactly. The target must be a live memory the caller could edit with `memory_edit`. A project document is refused: those change through the project tools. If the call also passes a scope and it differs from the target's scope, it is refused, so text cannot land in a shared scope the agent did not name. The new row is unconfirmed.

D1 in code. The stamp is `mcp:<name>` from the handshake name after `tameOneLine` (80 characters, printable text); a name that tames to nothing is stamped `mcp`. Two places compare `source` to exactly `mcp` and change with it: the Mac app's first-run "try it" step (apps/web/static/index.html) and e2e/m1.test.ts. `isOldAgentNote` already accepts the `mcp:` form.

D4 in code. The connector runs the same check over the shared rows of the save's scope, which it has already decrypted for the request. A cloud `replaces` lands the new memory and queues the replace; cloud apps see both memories until the user confirms. The queue entry names which memory replaces which, and the connector can read that pairing: that is the disclosure, and "What leaves the machine" says so. When a sync renames a pending row's id, the queue entry is re-pointed with it. A queued replace is dropped, and the new memory stays as an ordinary addition, if the old memory was edited or forgotten on a device or its scope was unshared first. The queue is read only by clients on a new protocol version, the existing `?v=` gate.

## Review 3 (2026-11-24, fresh eyes, against the code, with a scratch probe of the rule): CLEARED WITH WOUNDS
1. The record claimed the rule holds a rent change and a new accountant, using paraphrased examples that share one word and are not held. Corrected above; the limit is now stated.
2. Measuring in either direction, as first revised, made a short memory hold every later fact that repeats its words: a three-word memory naming a person held each new fact about that person. Fixed: the save's side only.
3. The rule was not written tightly enough to build: three readings of "highest weight", and whether the save counts in N. Fixed: the formula above.
4. `replaces` could have rewritten a project document, and a scope passed with it was checked against the wrong row. Fixed: both refused.
5. A held save at Tier 1 had no stated way through. Fixed above.
6. The new stamp breaks the first-run step and one end-to-end test that look for exactly `mcp`. Listed above for the build.
7. D4 said nothing about id renames, an old row changed before confirmation, what the queue discloses, or whether the connector runs the check. Fixed above.
8. This record still stated the any-two-words rule in two places, and the acceptance test needed two live AI apps. Fixed: the two places now point here, and the test below is scripted.

Clean: the hold reply stays inside the save's own granted scope; empty scopes and stopword-only saves save without error; the confirmed marker is dropped when an agent replaces; medium-length updates such as a changed build number or a changed amount inside a longer sentence are held.

## Acceptance test (scripted, replaces the draft above)
A script drives two MCP clients against one throwaway vault, with no AI app in the loop:
1. Client A saves "The harbor office is at Pier 4." Saved.
2. Client A saves it again. No new row; the first id comes back.
3. Client B saves "The harbor office is now at Pier 9." Held; the reply lists the Pier 4 memory with its id.
4. Client B saves again with `replaces` set to that id. One live row; the Pier 4 row is marked replaced by it; the new row's source names client B.
5. Client B saves "The harbor office closes at five." with `distinct: true`. Saved as a second live row.
6. Client A retrieves "which pier is the harbor office at". The Pier 9 memory comes first and the Pier 4 memory does not appear. (As first written the question was "where is the harbor office"; that names no word the Pier 9 memory holds and the closing-time memory lacks, so the newer of the two led. The question was changed during the build, 2026-11-24, and the first wording is recorded here.)

## Build (2026-11-24)
Jay said "Build 3". Choices made where the record was silent:
- The reply shapes are the same on both surfaces: `stored` with `already_saved` for an identical save; `held`, `saved: false`, `next` and `possible_updates` for a held one.
- On the device the stamp is `mcp:<name>`; an unnamed client stays `mcp`. `memory_edit` carries the editing app's stamp too. The owner's own edits keep the first writer.
- `replaces` skips the save check, since the app has already answered it. A replace whose text equals the target's answers "already saved".
- On the connector each queued replace has its own id, which the device acks. A second replace of a memory that already has one waiting is refused. The new row is written first and queued second; if the queue write fails, the new memory stays as an ordinary addition.
- The connector drops a queued replace when its scope is unshared, and when a device reads the queue and finds either memory gone or the two in different scopes. An entry whose old or new memory has a forget waiting is kept but not sent.
- The device asks `/client/pending?v=3` and falls back to `v=2` against an older connector. The phone asks `v=2` and never sees the queue.
- On the device a replace is settled without a question, and acked, when either side is gone, is a project document, or the two are in different scopes. It waits when the device has not yet seen one side. An approved one calls `markReplaced`, then acks.
- The app name is stamped on connector memory saves only, not on project writes.
- Text an AI app wrote is cut to one printable line of 120 characters before the sync review shows it in the Mac app or the command line.
- The connector's save now decrypts the rows it can read, so a row that cannot be decrypted fails a save with the same re-encrypt message search already gives.
- The source rule test that requires every vault write in the device server to say it is for an AI app now covers `replaceMemory` and allows the app stamp beside the actor.

Not built: the phone says nothing about a waiting replacement, and the phone and the command line do not show a Cloud app's name. The existing forget preview's first lines are not cut to one printable line the way the new replace lines are.

## Build review (2026-11-24, fresh eyes, against commit 9b40b34, with executed probes): CLEARED WITH WOUNDS
Before it, two checks during the build found and fixed: `replaces` on the device refused a live project document but not an archive; and a second device's ack landing in the middle of a queue read could drop a waiting replace. Each has a test.
1. The Cloud app's name was stored but shown nowhere, so KNOWN-LIMITS claimed a label that did not exist for Cloud saves. Fixed: the Mac app's memory list shows it; KNOWN-LIMITS says where it is and is not shown.
2. A replacement whose first line was invisible characters showed the user an empty quote, pre-checked. Fixed: each line is cut to printable text before one is chosen, and text with nothing readable says "(no readable text)".
3. If the queue write failed after the new memory was saved, the app was told the save failed and a retry stored it twice. Fixed: the reply says the memory is saved as a separate one and not to save it again.
Notes taken up: a device replace with the same text, in any casing, answers "already saved" as the connector does; the source rule test again accepts only the exact forms used; `--yes` help names memory replacements; KNOWN-LIMITS says a waiting replacement is dropped when the old memory is confirmed, edited or forgotten, and that only unaccented letters and digits count as words.
Left as they are: nothing in the database stops two waiting replaces for one memory (the save refuses the second); a dead queue entry is cleared only when a device reads the queue or the scope is unshared; a compromised connector could queue a replace between two memories in an unshared scope, the same gap the forget plan already has.
Not checked: the new table against real hosted Postgres (tests use an in-process Postgres); the names real AI apps report; the 22-of-130 bench figure, since the bench vault is not on this branch.

## Recheck (2026-11-24, a new reviewer, against commit 3c72617): CLEARED WITH WOUNDS
Wounds 1 and 3 closed; nothing new from the fix commit. Still open, and fixed after this recheck without a further review:
1. A first line of filler letters, blank braille or bare accents still showed as a blank quote. Now a line must hold a real letter or digit to be shown.
2. Two published sentences were false: KNOWN-LIMITS said an exact repeat is never stored again without saying "in the same collection", and D1 said every surface labels the app name when only the Mac app does. Both corrected.
Notes taken up: a Cloud retry that sets `replaces` again no longer stores the same text twice; KNOWN-LIMITS says confirming or editing either memory drops a waiting replacement, and that replacing the new memory first drops the older one.
Still not checked: the new table against real hosted Postgres.

## Found after merge (2026-11-25)
The review of ADR 0093 ran the identical-save test on pairs that differ by a symbol. As merged in PR 96 it stripped every non-letter at a word's edges and folded compatibility forms, so "O+" and "O-", "-500" and "500", "$1,450" and "€1,450", and "< 5 mg" and "> 5 mg" compared equal: the second save was answered "already saved" and never stored. Neither build review tried it. Fixed: only full stops, commas, colons, semicolons, question and exclamation marks and quotation marks are dropped at word edges (brackets stay: "(500)" is minus 500 in accounts), and the form is NFC, so a superscript is not a digit. Sixteen differing pairs are a test on both surfaces' shared rule. After a digit a quote, a question mark or an exclamation mark is kept, so 6' and 6" differ, and the rule is a loop so a long run of punctuation cannot slow a save.
