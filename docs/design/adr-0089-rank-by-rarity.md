# ADR 0089 design record: rank by rarity

This decision was first drafted as "ADR 0088" on PR 88. Another open PR had taken that number, so it was renumbered before review 1's fixes went in.

## Where it came from
The brain bench (PR 84) found that a search holding the user's name returned only confirmed memories on 0.29.0. Two narrower fixes were built and both failed review (PR 85, ADR 0087): dropping common words lost "Morgan employer", and listing common-only matches last lost an answer made of common words. Jay, 2026-11-23: "What is honestly the best solution to this name bug?" and then "Build the ranking fix."

The cause is not the name. Recency (up to 0.3), type (up to 0.15) and the confirmed boost (0.5) are added to a keyword overlap that is often 0.25 or 0.5. Anything that touches the query at all can outrank a row that matches it well.

## How the rule was chosen
Candidate rules were run, with no model in the loop, against three things. All three are on PR 84 and can be rerun: the cases are in the bench's ranking-cases file and its tests, and the replay tool prints the last column.
- Eleven hard cases: eight from PR 85's reviews and three from review 1 below (a long answer, with one query word that no memory holds).
- Three checks the product already makes, rebuilt as rows: a long row against a short exact answer, a confirmed memory against a newer near-copy, and an answer split across two memories among project chatter.
- The 348 memory searches agents really made in the bench's 600-session run.

| Rule | Hard cases found (11) | Kept checks (3) | Recorded searches that return the answer |
| --- | --- | --- | --- |
| As shipped (0.29.0) | 6 | 3 | 275 of 348 |
| Bonuses multiply, words weigh the same | 10 | 3 | 275 |
| Rarity, no prior | 11 | 1 | 275 |
| Rarity, prior of 10, absent words counted, cut subtracted (the first draft) | 8 | 3 | 275 |
| Rarity, prior of 10, absent words weigh nothing, cut multiplies (this ADR) | 11 | 3 | 275 |

No rule gained or lost a recorded search. The recorded misses are wording ("cleaner" against "cleans") and are out of scope here.

Why each part is needed:
- Multiplying the bonuses alone loses one case: ten rows, nine confirmed rows that share the name, and an answer that matches one word. Only word weights separate those.
- Rarity with no prior swings in tiny vaults: with two rows, a word in one of them outweighs three words in both. The prior of 10 rows keeps weights close to equal until there is enough to count.
- A query word that no row holds would get the largest weight of all and shrink every match. Giving it no weight keeps a typo or a stray word from changing the order.
- The long-row check is a knife edge today (0.75 against 0.74), so the cut is made firmer. As a multiplier it can never take a score to zero.

## What reads a score today
- `packages/converse/src/turn.ts:266` keeps memories within 60% of the first result's score. Scores now spread wider, so fewer weak matches pass.
- `packages/mcp-server/src/server.ts:978` and `apps/web/src/api.ts:721` show a relevance number. Its scale changes.
- On the phone only Converse calls `vault.retrieve`; it gets the rule when the phone next ships.

## Review 1 (2026-11-23, fresh eyes, against code and with the formula implemented in a probe): NOT CLEARED
The reviewer implemented the first draft twice, once as a patched copy of the core package (all 419 core tests passed) and once as pure functions, and reproduced the hard-case score.
1. HIGH. The first draft counted words over every row the app may see, even under a filter. With 60 rows outside the filter that hold a query word, the answer left the top eight, which is the very case that step was meant to fix. Fixed: D1 counts over the rows searched. That also means nothing outside a filter can affect the order.
2. HIGH. A query word no memory holds got the largest weight, shrank every match, and with the subtracted cut wiped out a long answer that 0.29.0 ranks first (answers of 300, 450 and 700 distinct words; AI apps may save up to 8 KB). The same shrinkage let similarity swamp the match in meaning search. Fixed: such a word weighs nothing, and the cut multiplies (D1, D3). The three cases are now hard cases on PR 84.
3. MEDIUM. The draft said a common-word row "cannot outrank one matching a rare word, whatever its bonuses". False: the bonuses multiply by up to 1.95. Twenty recent confirmed rows sharing "harbor" (in a fifth of the vault) still outrank an old note that alone holds "kayak". Fixed: the sentence now states the 1.95 limit, and the case is under "Not fixed". 0.29.0 loses that case too.
4. MEDIUM. A confirmed memory now ranks second to an AI app's note that matches one more word (1.047 against 1.215 in the probe; 0.29.0 has the confirmed one first). Stated in Consequences as a change made on purpose; KNOWN-LIMITS and ADR 0084 are reworded in the build PR. The draft said it amended ADR 0084 D4; the ranking promise is in D5 and Consequences.
5. MEDIUM. A correction saved as a new memory, worded differently, now ranks below the year-old fact that matches one more word. A correction made by editing replaces the old row and is unaffected. Same trade as finding 4; stated in Consequences.
6. The acceptance bar was too weak: the comparison could not be rerun, the bench ran word search only while the Mac searches by meaning, and "in the top eight" hid order. Fixed: the rules and cases are on PR 84 with tests; the ADR's bar now asks for product tests by word and by meaning, on the device and the connector. The build adds: the answer ranks first where 0.29.0 has it first; a filter case with matching rows outside the filter; a long row plus an absent word; a correction worded differently; and the connector's own scorer on the same cases.
7. Smaller: D5 now says a scope or type name is weighed by its rarity among the rows' names; `wordWeights` must sit inside the block the drift test compares, and the "up to 0.3" comments in both copies change with D3; the number 0088 was taken.

Clean: the first draft passed every existing core test; years and file names in a query keep the answer first; weights still separate at 5,000 rows; one-word queries order rows as today; meaning search ranks better than today (a confirmed row with no keyword match scores about 1.44 today, ahead of a keyword answer at about 0.92); nothing leaks from outside the granted scopes; invariant 2 holds as long as counts are never kept between requests; the connector's 1.5 equals the Mac's multiplier when there is no recency or type bonus; the cited line numbers and the phone claim are right.

## Recheck
Not yet run.
