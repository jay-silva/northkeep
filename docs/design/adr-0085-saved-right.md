# Design record: ADR 0085, Saved right

Milestone 3 of relaunch step 1. Overflow for the ADR.

## Who decides, before and after

| Action | Today | After |
|---|---|---|
| Agent replaces a memory | `memory_edit` (any granted scope, editMemory guards) | same, plus `replaces` on save with the same guards and a same-scope rule |
| Identical save | second row written | no row; existing id returned |
| Close save | second row written | held; the agent chooses `replaces` or `distinct` |
| Which memory wins | nobody | still nobody: NorthKeep never picks (plan, question 19) |
| App name on a save | `mcp` or `connector:<host>` | the name the app gives, labelled as self-reported |

## D3 details

- Normalize: Unicode NFKC, lower case, collapse whitespace, strip punctuation at either end of each word.
- Word floor: Jaccard overlap of the word sets at or above 0.6 (start value, tuned on fictional fixtures). Short memories under four words are compared only for identity, so "Likes coffee" does not block "Likes tea".
- Meaning match (device only, when the local search model runs): cosine at or above 0.9 against the same-scope candidates, reusing ADR 0067's in-memory cache.
- `distinct: true` skips the close check but never the identity check.
- The reply quotes matches from the agent's granted scopes only. The same-scope rule already ensures that; the review should test it.

## D4 details

- Connector ids: rows pushed from a device carry the vault id; rows born on the connector carry `conn_…` until acked. `replaces` accepts either; the device resolves a `conn_` id through the ack mapping it already keeps.
- The envelope (`RowPlain`) gains optional `replaces` and `app`. The connector sets `app` from the authenticated client registration, never from tool arguments.

## O1 for Jay

Replacing a confirmed memory. Recommended: allow it, with an unconfirmed successor. Under question 11, a fact told to an agent counts as confirmed in conversation for everyday facts. The alternative is to refuse until milestone 5 adds the two levels. Refusing keeps the confirmed core fixed, but an agent then cannot correct a stale confirmed fact.

## Acceptance test (draft; final commands land with the code)

On a throwaway vault with two local MCP clients (for example Claude Code and Codex) pointed at it:
1. Tell client A: "Remember that the harbor office moved to Pier 4." Client A saves.
2. Tell client A the same thing again. The vault still holds one row.
3. Tell client A: "The harbor office moved again, to Pier 9." Client A is asked about the near match and saves with `replaces`.
4. Run `northkeep --vault $NK list --scope personal`. One live row says Pier 9 and its source names client A. The Pier 4 row shows as replaced.
5. A fresh client B session asked "where is the harbor office?" answers Pier 9.
