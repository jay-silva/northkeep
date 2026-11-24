# Design record: ADR 0085, Saved right

Milestone 3 of relaunch step 1. Overflow for the ADR, plus the review log.

## Who decides, before and after

| Action | Today | After |
|---|---|---|
| Device agent replaces a memory | `memory_edit` (editMemory guards; Tier 1 text refusal in the handler) | the same, plus `replaces` on save with the same guards and a same-scope rule |
| Cloud app replaces a memory | not possible (the connector has no `memory_edit`; forgets wait for the user) | the new memory lands; the replace waits for the user, like a forget |
| Identical save | a second row | no row; the existing id is returned |
| Save sharing 2+ key words with a live memory in its scope | a second row | held; up to three listed; the agent chooses `replaces` or `distinct` |
| Other save | saved | saved |
| Which memory wins | nobody | still nobody (plan, question 19) |
| App name on a save | `mcp` or `connector:<host>` | the app's own name, labelled self-reported; on a replace, the replacing app's |

## D1 and D2 primitive changes

`supersedeEntry` (vault.ts) copies the old row's `source` and `metadata`. For actor agent it must instead take the writer's stamp and drop `confirmed`. This also changes `memory_edit`, which is intended. The connector's `client_name` is tamed with `tameHandshakeField` (80 characters, no control or bidi characters) before it is stored. The DCR path stores it unchecked today (provider.ts:82).

## D3 details

- Normalize: Unicode NFKC, lower case, collapse whitespace, strip punctuation at word edges.
- Hold: the save shares two or more non-stopword words with a live memory in its scope. The reply lists the top three by overlap, with ids. Nothing is saved until the agent calls again with `replaces` (one row, old marked replaced) or `distinct: true`. This is where reworded updates ("is now at Pier 9") get caught. An earlier save-then-list version left two live rows when the agent followed its advice (recheck R-D3).
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
- Accepted scar tissue: reworded updates that share no key words still save as a second row. Milestone 5's conflict check is the backstop.

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
Jay asked for milestone 3 to start and approved a third review ("Review 85"). The revision applies the fix recheck 2 proposed, with a measured threshold.

The rule. A save is compared with live memories in its own scope, leaving out project documents, log archives and rows marked as archives, the same rows ADR 0084 D3 keeps out of search. Words are the search terms of ADR 0084 (`searchTerms`, with the named `SEARCH_STOPWORDS` list, which already has a test), weighed by rarity among those rows as in ADR 0090, except that a word no other memory holds counts at the highest weight, because in a save the new word is the new information. The save is held when it shares at least two words with a memory and the shared words carry at least 60% of the weight of either the new save or that memory. Either direction counts because an update is often longer than the fact it replaces: "the accountant is now Priya Shah at Shah & Lowe, since August" covers most of "the accountant is Leo Marsh", not the reverse.

Measured on the brain bench's fictional vault (130 memories, each tried as a new save against the others in its scope, one direction): any two shared words holds most saves, as recheck 2 found. At 40% of weight, 38 are held; at 50%, 27; at 60%, 22; at 70%, 17. At 60% the real updates in that vault are all held: a rent change, a deposit change, a new accountant, a changed holiday roster, a dog recorded twice, a job recorded twice. So are some that are not updates: two boats on the same route, two companies that share a first name, a nine-item series of near-identical build notes, and a short fact whose words all sit inside a longer unrelated one. A hold costs the agent one more call with `distinct: true`; a missed hold leaves two copies. The threshold favours the hold. It is a constant in one place and is expected to move once real saves are seen.

Not solved by words: an update that shares no distinctive word with the fact it replaces. Milestone 5 is the backstop, as before.

D4 now says the old memory stays visible to cloud apps, beside the new one, while a cloud replace waits for the user. "What leaves the machine" now says the connector can read the replace queue's entry ids.
