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

## Open questions for Jay

- O1: replacing a confirmed memory from a device agent. Recommended: allow, with an unconfirmed successor. The alternative is to refuse until milestone 5.
- O2: cloud replaces of unconfirmed, agent-written rows. Recommended: hold them in milestone 3 and revisit with milestone 5's phone confirmations. Because Jay rarely opens the app, held replaces will queue until then.

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
