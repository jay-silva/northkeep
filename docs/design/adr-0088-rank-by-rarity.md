# ADR 0088 design record: rank by rarity

## Where it came from
The brain bench (PR 84) found that a search holding the user's name returned only confirmed memories on 0.29.0. Two narrower fixes were built and both failed review (PR 85, ADR 0087): dropping common words lost "Morgan employer", and listing common-only matches last lost an answer made of common words. Jay, 2026-11-23: "What is honestly the best solution to this name bug?" and then "Build the ranking fix."

The cause is not the name. Recency (up to 0.3), type (up to 0.15) and the confirmed boost (0.5) are added to a keyword overlap that is often 0.25 or 0.5. Anything that touches the query at all can outrank a row that matches it well.

## How the rule was chosen
Seven candidate rules were run, with no model in the loop, against three things:
- the eight hard cases collected from PR 85's reviews (each one a way a fix attempt lost the answer);
- three existing product tests, rebuilt as rows: a long row against a short exact answer, a confirmed memory against a newer near-copy, and an answer split across two memories among project chatter;
- the 348 memory searches agents really made in the bench's 600-session run.

| Rule | Hard cases found (8) | Existing tests kept (3) | Recorded searches that return the answer |
| --- | --- | --- | --- |
| As shipped (0.29.0) | 3 | 3 | 275 of 348 |
| Bonuses multiply, words weigh the same | 7 | 3 | 275 |
| Rarity weights, no prior | 8 | 1 | 275 |
| Rarity weights, prior of 10 rows | 8 | 2 | 275 |
| Rarity weights, prior of 20 rows | 8 | 2 | 275 |
| Prior of 10, long-row cut 0.15 up to 0.5 (this ADR) | 8 | 3 | 275 |
| Prior of 10, long-row cut as a multiplier | 8 | 3 | 275 |

No rule gained or lost a recorded search. The recorded misses are wording ("cleaner" against "cleans") and are out of scope here.

Why each part is needed:
- Multiplying the bonuses alone finds seven hard cases. It loses the eighth: ten rows left after a filter, nine confirmed rows that share the name, and an answer that matches one word. Only word weights separate those.
- Rarity with no prior swings in tiny vaults: with two rows, a word in one of them outweighs three words in both. The prior of 10 rows keeps weights close to equal until there is enough to count.
- The long-row test is a knife edge today (0.75 against 0.74). Any weighting tips it, so the cut for long rows is made firmer. Subtracting was kept over multiplying because it changes two constants and nothing else.

## What reads a score today
- `packages/converse/src/turn.ts:266` keeps memories within 60% of the first result's score. Scores now spread wider, so fewer weak matches pass.
- `packages/mcp-server/src/server.ts:978` and `apps/web/src/api.ts:721` show a relevance number. Its scale changes.
- The phone calls `vault.retrieve` and gets the rule when it next ships.

## Review
Not yet run.
