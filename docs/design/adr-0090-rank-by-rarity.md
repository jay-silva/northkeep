# ADR 0090 design record: rank by rarity

This decision was first drafted as "ADR 0088" on PR 88, then briefly numbered 0089. Another open PR (89) was taking those numbers at the same time, so it settled on 0090, the number of its own PR. The reviews below call it by the number it had then.

## Where it came from
The brain bench (PR 84) found that a search holding the user's name returned only confirmed memories on 0.29.0. Two narrower fixes were built and both failed review (PR 85, ADR 0087): dropping common words lost "Morgan employer", and listing common-only matches last lost an answer made of common words. Jay, 2026-11-23: "What is honestly the best solution to this name bug?" and then "Build the ranking fix."

The cause is not the name. Recency (up to 0.3), type (up to 0.15) and the confirmed boost (0.5) are added to a keyword overlap that is often 0.25 or 0.5. Anything that touches the query at all can outrank a row that matches it well.

## How the rule was chosen
Candidate rules were run, with no model in the loop, against three things. All three are on PR 84 and can be rerun: the cases are in the bench's ranking-cases file and its tests, and the replay tool prints the last column.
- Thirteen hard cases: eight from PR 85's reviews, three from review 1 below (a long answer, with one query word that no memory holds), one from the recheck (a long confirmed answer against fresh notes that repeat the question), and one from the build review (a long unconfirmed answer that holds every query word).
- Three checks the product already makes, rebuilt as rows: a long row against a short exact answer, a confirmed memory against a newer near-copy, and an answer split across two memories among project chatter. The long-row check is counted here in a vault where other memories hold "name"; the next column is the same check as the product first wrote it, with two memories.
- The 348 memory searches agents really made in the bench's 600-session run.

| Rule | Hard cases found (13) | Kept checks (3) | Long-row check, two memories | Recorded searches that return the answer |
| --- | --- | --- | --- | --- |
| As shipped (0.29.0) | 8 | 3 | passes | 275 of 348 |
| Bonuses multiply, words weigh the same | 11 | 3 | passes | 275 |
| Rarity, no prior | 12 | 2 | fails | 275 |
| Rarity, prior of 10, absent words counted, cut subtracted (the first draft) | 8 | 3 | passes | 275 |
| Rarity, prior of 10, absent words weigh nothing, cut multiplies up to half, confirmed memories cut too | 11 | 3 | passes | 275 |
| The same, with confirmed memories not cut (as first built) | 12 | 3 | passes | 275 |
| The same, with the cut at 0.29.0's strength, up to 30% (this ADR) | 13 | 3 | fails | 275 |

No rule gained or lost a recorded search. The recorded misses are wording ("cleaner" against "cleans") and are out of scope here. The last two rows are the trade the build review turned up: the thirteenth hard case against the two-memory check. No rule tried finds both, and the scores that decide each are close (0.70 against 0.65 of the match in one, 0.73 against 0.70 in the other), so a cut tuned to pass both would be fitted to two fixtures.

Why each part is needed:
- Multiplying the bonuses alone loses two cases. One is ten rows, nine confirmed rows that share the name, and an answer that matches one word: only word weights separate those.
- Rarity with no prior swings in tiny vaults: with two rows, a word in one of them outweighs three words in both. The prior of 10 rows keeps weights close to equal until there is enough to count.
- A query word that no row holds would get the largest weight of all and shrink every match. Giving it no weight keeps a typo or a stray word from changing the order.
- The long-row check is a knife edge today (0.75 against 0.73). The design first made the cut firmer, 15% per doubling up to half; the build review showed that loses a long answer holding every query word, so the cut is back at 0.29.0's strength (see Build review). As a multiplier it can never take a score to zero.
- The cut exists to stop long conversation summaries winning on size. A memory the user confirmed is not that, and cutting it halves its confirmed boost too, so it is left whole.

## What reads a score today
- `packages/converse/src/turn.ts:266` keeps memories within 60% of the first result's score. Scores now spread wider, so fewer weak matches pass, and a memory that answers half of a two-part question can be dropped (see Build review, finding 3).
- `packages/mcp-server/src/server.ts:978` and `apps/web/src/api.ts:721` show a relevance number. Its scale changes.
- On the phone only Converse calls `vault.retrieve`; it gets the rule when the phone next ships.

## Review 1 (2026-11-23, fresh eyes, against code and with the formula implemented in a probe): NOT CLEARED
The reviewer implemented the first draft twice, once as a patched copy of the core package (all 419 core tests passed) and once as pure functions, and reproduced the hard-case score.
1. HIGH. The first draft counted words over every row the app may see, even under a filter. With 60 rows outside the filter that hold a query word, the answer left the top eight, which is the very case that step was meant to fix. Fixed: D1 counts over the rows searched. That also means nothing outside a filter can affect the order.
2. HIGH. A query word no memory holds got the largest weight, shrank every match, and with the subtracted cut wiped out a long answer that 0.29.0 ranks first (answers of 300, 450 and 700 distinct words; AI apps may save up to 8 KB). The same shrinkage let similarity swamp the match in meaning search. Fixed: such a word weighs nothing, and the cut multiplies (D1, D3). The three cases are now hard cases on PR 84.
3. MEDIUM. The draft said a common-word row "cannot outrank one matching a rare word, whatever its bonuses". False: the bonuses multiply by up to 1.95. Twenty recent confirmed rows sharing "harbor" (in a fifth of the vault) still outrank the old note that answers a question about "kayak", a word five rows hold. Fixed: the sentence now states the 1.95 limit, and the case is under "Not fixed". 0.29.0 loses that case too.
4. MEDIUM. A confirmed memory now ranks second to an AI app's note that matches one more word (1.047 against 1.215 in the probe; 0.29.0 has the confirmed one first). Stated in Consequences as a change made on purpose; KNOWN-LIMITS and ADR 0084 are reworded in the build PR. The draft said it amended ADR 0084 D4; the ranking promise is in D5 and Consequences.
5. MEDIUM. A correction saved as a new memory, worded differently, now ranks below the year-old fact that matches one more word. A correction made by editing replaces the old row and is unaffected. Same trade as finding 4; stated in Consequences.
6. The acceptance bar was too weak: the comparison could not be rerun, the bench ran word search only while the Mac searches by meaning, and "in the top eight" hid order. Fixed: the rules and cases are on PR 84 with tests; the ADR's bar now asks for product tests by word and by meaning, on the device and the connector. The build adds: the answer ranks first where 0.29.0 has it first and not by a tie; a filter case with matching rows outside the filter; a long row plus an absent word; a correction worded differently; and the connector's own scorer on the same cases.
7. Smaller: D5 now says a scope or type name is weighed by its rarity among the rows' names; `wordWeights` must sit inside the block the drift test compares, and the "up to 0.3" comments in both copies change with D3; the number 0088 was taken.

Clean: the first draft passed every existing core test; years and file names in a query keep the answer first; weights still separate at 5,000 rows; one-word queries order rows as today; meaning search ranks better than today (a confirmed row with no keyword match scores about 1.44 today, ahead of a keyword answer at about 0.92); nothing leaks from outside the granted scopes; invariant 2 holds as long as counts are never kept between requests; the connector's 1.5 equals the Mac's multiplier when there is no recency or type bonus; the cited line numbers and the phone claim are right.

## Recheck (2026-11-23, the same reviewer, revised formula in the probes and a patched core): CLEARED WITH WOUNDS
Both blocking findings are fixed: the filter case ranks the answer first; the long answers that 0.29.0 finds are found; the meaning-search case ranks the answer first; all 419 core tests pass with the revised formula patched in. The table above was reproduced from the bench sources as it then stood. The replay figure was not rerun by the reviewer.

1. A long confirmed answer lost to short recent notes that only repeat the question. Query "septic test pit results"; the answer is a confirmed 450-word memory, 400 days old; the notes are five-day-old AI notes saying the user asked where the results are. The multiplying cut halved the answer's confirmed boost too: 0.93 against 1.25 for each note. With eight such notes the answer left the top eight; 0.29.0 ranks it first. Fixed: D3 does not cut a confirmed memory. The case is the twelfth hard case, and the rule with confirmed memories cut is in the table for comparison. This fix was made after the recheck and has not had a further review; it is covered by the bench tests.
2. The planned test "the answer ranks first where 0.29.0 has it first" would fail hard case 2: for "Pat employer", this rule puts another person's employer first (0.732 against 0.623), where 0.29.0 has the answer first only by a tie broken by insertion order. Fixed: the test excludes ties, and the case is one of the examples below.
3. D5 was unclear for a query that matches only a scope or type name: read one way it would score nothing and return nothing, where today it returns those rows. Fixed then: D5 said such a word enters the match and the total at half its weight among the names. The build review found that wording wrong too, and D5 now says a word found only in a name counts half (see Build review, finding 2). The build adds a connector test that searches by a scope name.
4. The record misstated the "kayak" case. Corrected above.

Clean: the long-row check was no longer a knife edge with the firmer cut the design then had (0.973 against 0.845; see Build review for what replaced it); a query whose words are all absent matches nothing; a single rare matching word orders rows as before; words absent inside a filter but present outside it do not matter; meaning search with every query word absent scores 0.7 × similarity × bonuses and never divides by zero (the build keeps the existing guard). A confirmed row at 0.62 similarity still beats an unconfirmed answer at 0.8 there, by less than in 0.29.0.

## The trade, in numbers
"Changed on purpose" in the ADR means these, from the reviewer's probes:
- You confirmed "Pat works at Harbor Rescue" 60 days ago. An AI app saved a note 10 days ago that mentions Pat, an employer and Harbor. Searching "Pat employer Harbor", the note now comes first (1.215 against 1.047). In 0.29.0 the confirmed memory comes first.
- Searching "Pat employer", a memory about another person's employer comes first (0.732), ahead of Pat's confirmed memories (0.623), because "employer" is the rare word and only that memory holds it. Pat's memories follow it.
- A correction saved as a new memory, worded differently from the old fact, can rank just below the year-old fact that matches one more word (1.001 against 1.100). A correction made by editing the memory replaces the old one and is not affected.

In each case both memories are returned; what changes is which is first.

## Build notes (2026-11-23, PR 90)
Jay accepted the ADR on 2026-11-23. Asked to reply "accept the ranking ADR", he wrote "except the ranking ADR", read as accept.

What was built:
- `wordWeights`, `weightedMatch` and the new `lengthPenalty` in both search-rules files, inside the block the drift test compares.
- Device: `Vault.retrieve` and the meaning path score `keywordMatch × bonusFactor` and `(0.7 × similarity + keywordMatch) × bonusFactor` (packages/core/src/vault.ts). A row is admitted exactly as before.
- Connector: `rankSharedEntries` replaces `scoreSharedEntry`, and both search tools call it. The connector had no long-row cut before; it now applies the same one, so the rule is the same in both places.
- Converse is not changed. Its floor is a ratio of the first result's score, so it keeps working; it keeps fewer weak matches.

Tests:
- The thirteen hard cases (the build review added one) run against a real vault by word and by meaning (packages/core/test/adr0090-rank-by-rarity.test.ts, cases in ranking-cases.ts), and against the connector's scorer. The answer must rank first in twelve of them; in "Pat employer" it must be in the first eight.
- What these tests show, measured by putting main's two source files under the same tests: on the device, 9 of the 23 hard-case tests that run fail on main. On the connector, the build reviewer measured that main's scorer already finds eleven of the first twelve cases, and the thirteenth, and misses only "ten memories, nine of them confirmed", so that one case is what shows the connector change. The trade and "not fixed" tests pass on main too; they guard against a regression and do not show a fix. An earlier version of this record said "16 of these tests failed before the change"; that figure did not reproduce and is withdrawn.
- By meaning, three cases are skipped and recorded as not fixed: the 300-word answer, the long confirmed answer against fresh notes, and the long unconfirmed answer holding every query word. All three pad the answer with made-up words. The stand-in for the search model in the tests treats two texts as close when they share words, so the padding makes the answer look unlike the question, and short rows that echo the question score closer. Main loses all three by meaning under the same stand-in. All three pass by word. The ADR's "ready when" line says so; that is a weaker bar than the one Jay accepted, and it is called out in the PR for him.
- New: a filter case with 60 matching rows outside the filter; the cut's values; a long confirmed memory scoring as a short one; the two trades (both memories come back); the two-memory limit (both come back); on the connector, a search by scope name, text against name, a word in both a memory and its scope name, an empty query and a stopword query; and one case through both connector tools.
- Kept checks: two of the three existing ADR 0084 tests are unchanged and pass. The third, "a long unrelated row does not outrank a short exact answer", was changed: see Build review, finding 1.

Checks run on the built code are listed under Build review, after the fixes.

## Build review (2026-11-23, fresh eyes, probes run against the built branch and against main): NOT CLEARED
Probes are fictional. The reviewer ran 65 tests and did not rerun the replay or the full suite.

1. HIGH. A long answer holding every query word was lost by word, on the device and the connector. One unconfirmed memory, a septic design report padded to 600 words; nine short rows that mention a septic pumping; forty notes that share the place name. Searching the place name and "septic", main ranks the report first; the branch as first built left it out of the eight results, because the firmer cut (up to half) put it below eight rows that hold only "septic". Review 1's second finding was the same failure in another form, and this record called it fixed.
   Fixed: D3 puts the cut back at 0.29.0's strength, 10% per doubling up to 30%, still as a multiplier and still not applied to a confirmed memory. The probe is the thirteenth hard case and ranks first by word on the device and the connector.
   What that costs: the existing ADR 0084 check "a long unrelated row does not outrank a short exact answer" then fails as written. Its vault holds two memories: a short answer with three of the four query words, and a 400-line row with all four. "Name" is the word the answer lacks, the long row is the only memory holding it, and two memories are too few to tell that "name" is a common word, so the long row leads 1.030 to 0.973. Main passes the same check by 0.75 to 0.73. With one more memory that holds "name" the answer leads, 1.050 to 1.030, and with twenty, 1.329 to 1.030. The check now seeds twenty such memories, and a new test records that in the two-memory vault both memories come back. Changing an accepted check is Jay's decision; it is called out in the PR.
2. HIGH, connector. A word counted at half its rarity among scope and type names could outweigh the same word in a memory's text: with "harbor" in 21 memories and in one scope name, a row merely filed under that scope outranked every row that says "harbor". Main counts a text match 1 and a name-only match 0.5, so this was a regression.
   Fixed: one set of weights, counted over each row's text and names together. A word in the text counts in full and a word found only in a name counts half, as on main. D5 was reworded to say so. A new connector test covers the reviewer's probe.
3. MEDIUM. Converse can drop a confirmed answer. For "Who is Pat's employer, and where is the boat trailer parked?", with Pat in thirty other rows, the confirmed employer memory scores 0.512 against a floor of 0.521 (60% of the best match) and is left out; main keeps both. Not fixed: recorded in the ADR's Consequences and in KNOWN-LIMITS. Lowering the floor is a separate choice for Jay, since it also lets more weak matches into the chat.
4. MEDIUM. "Up to 1.95 times, and no more" was false for long memories, because a confirmed memory also escapes the cut. Fixed in the ADR and KNOWN-LIMITS: between two rows with the same match, the widest gap is 1.95 against 0.7, which is 2.8 times, on the device; 1.5 against 0.7 on the connector.
5. LOW. The test claims were overstated. Fixed in "Tests" above, with the figures remeasured.
6. LOW. Five comments ran past 40 words or said what the code does. Fixed.

Checks run on the rebuilt code after these fixes:
- Leak gate: passed. Full suite: 3,329 passed. End-to-end: 166 passed; the two that fail are the long-standing milestones-k4 failures on macOS that pass in CI.
- Replay of the 348 recorded searches through the real `vault.retrieve` from the build: 275 return the answer, none gained and none lost against 0.29.0, and all 348 result lists are identical to the bench's "ADR 0090" rule, so the bench models the product exactly.
- The acceptance test below, on a throwaway vault, by meaning and by word: the answer is listed first.

Clean: the drift test covers `wordWeights` and `weightedMatch` and the two copies match; admission is unchanged; no divide-by-zero, NaN, zero or negative score; an empty query, a stopword-only query and ties behave as on main; the connector keeps no count beyond one request; nothing still reads the old score scale.

## Acceptance test (Jay's Mac, throwaway vault)
Twelve confirmed memories that name Pat, one unconfirmed memory with the answer, then a search that names Pat. Success: "Pat's car is a blue hatchback" is the first result. It needs the build from this branch (`pnpm build`); the released 0.29.0 app lists a ledger first.

```bash
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_PASSPHRASE=throwaway-pass NORTHKEEP_NO_KEYCHAIN=1
NK="$NORTHKEEP_HOME/vault.nkv"
northkeep --vault "$NK" init
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do northkeep --vault "$NK" remember "Pat keeps ledger $i in the harbor office" --type identity --confirmed; done
northkeep --vault "$NK" remember "Pat's car is a blue hatchback" --type semantic
northkeep --vault "$NK" search "car vehicle Pat drives" | head -4
```

The first line points every command at a new empty folder, so the real vault is never opened.
