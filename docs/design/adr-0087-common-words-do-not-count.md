# ADR 0087 design record: common words and search order

## How it was found
The brain bench (PR 84) ran 78 trial sessions against a fictional vault on 0.29.0. In three designs the agent answered "What car do I drive?" with "I don't have a record", after searching "car vehicle Morgan drives". The same question with "the user" in place of the name found the car.

Reproduced on a throwaway vault through `Vault.retrieve`: the eight results were all confirmed memories scoring about 1.1 (one word of four matched, plus recency, type and the 0.5 confirmed boost). The memory with the answer scored about 0.6.

## First design: drop common words (rejected)
`countedTerms` dropped any query word found in more than a quarter of the rows.

Review 1 (against code; it listed findings and gave no verdict): (1) "name birthday" returned nothing, because the name was dropped and no row held the other word; (2) the draft folded the rule into ADR 0084 and cut two still-true lines to fit; (3) the status implied it shipped in 0.29.0; (4) on the connector a common word also stopped matching a scope name. All four were patched.

Review 2 (fresh eyes, against code): NOT CLEARED.
1. HIGH. One unrelated row holding the rarer word wiped out the answer: "Morgan employer" returned only "Ryan's employer is Southcoast", where 0.29.0 returned the confirmed "Morgan works at ..." first. Dropping a word can never be safe.
2. MEDIUM. The crowding remained with the name in 20 to 25% of rows, under a scope filter that left fewer than 20 rows, and with a nickname.
3. MEDIUM. Search by meaning: a confirmed row that matches only the name but sits above the meaning threshold keeps its boost.
4. LOW. Confirmed rows sharing a rarer word (a street name) can still fill every result.
5. LOW. One connector test passed without the fix.

## Second design: order, not removal
`rareTerms` returns the query words that are not common (20 or more rows, in more than 10% of them). Common words still count toward the match and the score. Rows are sorted first by whether they matched a rarer word, then as before.

- Review 2 finding 1: fixed. The name's rows are still returned, after the row with the rarer word. Tested on both sides.
- Finding 2: the threshold is 10% not 25%, which is safe now that nothing is dropped; commonness is measured on the whole vault under a filter. A nickname under 10% is still treated as rare (KNOWN-LIMITS).
- Finding 3: a row below the meaning threshold that is present only for a common word is demoted. A row at or above it is not; no real similarity scores were measured (KNOWN-LIMITS).
- Finding 4: not fixed; KNOWN-LIMITS says so in the reviewer's words.
- Finding 5: the connector test now uses an answer that 0.29.0 does not return.

Why not remove the boost from name-only matches, as review 2 suggested: a confirmed identity row saved today scores 0.25 + 0.3 + 0.15 without the boost, above an older two-word match at 0.5 + 0.1. Recency and type are flat as well, so only an ordering rule holds.

In the fictional vault the name is in 42% of memories; the words above 10% are "cabin", "heron", "2026", "note", "run" and "corgi".

A check of the second design found that on the connector a scope or type name always counted as a rarer match, so "personal" in a query brought the crowding back. Fixed: commonness is measured for scope and type names too, apart from the text, with a test.

With the rule switched off (row minimum raised), nine of the ten new tests fail. The tenth, "the name still counts when it is the only word", passes either way; it guards against the first design.

## Recheck of the second design (2026-11-23, fresh eyes, against code): NOT CLEARED
1. HIGH. An answer made only of common words is pushed out by one padding word. About 100 rows; "heron", "cabin" and "corgi" each in 12 to 13% of them; the answer is "The corgi at Heron Cabin is called Biscuit"; nine unrelated rows contain "dog". The query "heron cabin corgi dog" returns eight "dog" rows and not the answer, which 0.29.0 lists first. Agents pad queries with synonyms, so this is likely. Same on the connector.
2. MEDIUM. The ADR's first Consequences line was false for that reason. Reworded.
3. LOW. Results are no longer in descending score order, and packages/converse/src/turn.ts:265 sets its relevance floor from the first row and stops at the first row below it. ADR 0084 D8 already broke that assumption; this makes it common. Not fixed.
4. LOW. "Every new test fails with the rule off" was false for one test. Corrected above.
5. LOW. "Pat employer" lists another person's employer first, and the test asserts it.
6. LOW. Wording: commonness under a filter is measured over the scopes the app may see, not the whole vault; a word in exactly 10% of rows counts as rare; ADR 0084's status says recheck 2's wounds were fixed, but its cap (instruction delivery unverified until D0 runs) is not something code fixes.

Clean: review 2's seven cases; the sort is a consistent order; the return shape; the drift block; D3; the result counts; cost is linear (about 25 ms by keyword at 5,000 rows).

The reviewer suggested demoting only confirmed rows that matched common words alone. Replayed below as "Fix 3": it loses confirmed answers about a named property.

## Replay of real searches (the bench's replay tool, PR 84)
The 600-session bench run recorded 348 memory searches on questions whose answer is a memory. Each rule was replayed on them, with no model in the loop.

| Rule | Searches that returned the answer | Gained | Lost |
| --- | --- | --- | --- |
| As shipped (0.29.0) | 275 of 348 | | |
| Fix 1: drop common words | 275 | 0 | 0 |
| Fix 2: common-only matches last (this ADR) | 275 | 0 | 0 |
| Fix 3: confirmed common-only matches last | 279 | 8 | 5 |
| Fix 4: weigh every word by rarity, bonuses scale with the match | 275 | 0 | 0 |

Only 6 of the run's 456 searches named the user, and in none did a fix change whether the answer came back. So the defect is real and reproducible, but rare with this agent, and neither rejected design lost an answer on real searches. The 73 searches that miss under every rule miss for other reasons: different wording ("cleaner" against "cleans"), and confirmed rows about a named property crowding out the answer.

## Where this stands
Two designs, two NOT CLEARED verdicts. Under Jay's rules a further change of approach is his decision. The code on this branch is the second design, with its tests, kept for reference.

## Measured on the bench
The first design, on 200 sessions: today's search 83 of 100 (84 before), look-first 93 (91 before). The second design: 83 and 94. All are inside run-to-run noise. The unit tests show the defect and the fix; the bench at this size cannot.
