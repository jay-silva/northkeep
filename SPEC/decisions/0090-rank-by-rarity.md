# ADR 0090: Search weighs words by rarity, and bonuses scale with the match

Status: Accepted 2026-11-23 (Jay: "except the ranking ADR", read as accept) · Design reviews: NOT CLEARED, then CLEARED WITH WOUNDS · Build review: NOT CLEARED, then CLEARED WITH WOUNDS · Released in 0.30.0

## Context
0.29.0 adds up to 0.95 for recency, type and confirmation to the share of query words a memory holds, and the extras outweigh the match. A query with the user's name returned eight confirmed memories, not the answer.

## Decision
- D1: Each query word is weighted by its rarity among the rows searched: ln((N + 10.5) / (n + 0.5)), N rows, n holding the word. The 10 steadies small vaults. A word in no row weighs nothing. The match is the share of query weight a row holds.
- D2: The bonuses multiply the match: match × (1 + recency + type + confirmed), at today's values.
- D3: The long-row cut keeps today's strength (10% per doubling past 64 distinct words, up to 30%) as a multiplier. A confirmed memory is not cut.
- D4: Search by meaning: (0.7 × similarity + match) × (1 + the same bonuses). Admission is unchanged.
- D5: The connector weighs the rows it decrypts the same way. A word found only in a scope or type name counts half. Confirmed multiplies by 1.5.
- D6: Unchanged: stopwords, plural folding, the paperwork skip, old AI notes last, result counts.
- D7: One `wordWeights` in both search-rules files' drift-tested block.

## Consequences
- Easier: a memory sharing only a common word no longer outranks one matching a rare word.
- Changed on purpose: a confirmed or newer memory wins close matches, but no longer beats one matching a weighty extra word, sometimes wrongly (record). Bonuses lift a score at most 1.95 times, or 2.8 against a long unconfirmed memory, which is also cut.
- Lost against 0.29.0: short rows holding a question's rarest word can push a long unconfirmed answer out of the results; a long row holding every word can lead a short answer lacking a rarer one; Converse can drop a confirmed answer to half of a two-part question.
- Not fixed: confirmed memories sharing a middling word can crowd out an answer; "cleaner" does not find "cleans"; by meaning, short rows echoing the question can outrank a long answer.
- Ready when the hard cases pass on device and connector, by word and (three padded cases aside) by meaning; existing tests pass, the long-row check with "name" made common; replay loses none of 275 searches.

## Rejected
- PR 85's designs: each lost a right answer.
- Equal weights; no prior: each fails two cases.
- Cutting long confirmed memories: notes repeating the question outranked them.
- A cut of up to half: lost a long answer holding every query word.
- Counting absent words, or rows outside a filter.

## What leaves the machine
Nothing new. The connector counts, in memory for one request, the decrypted rows holding each query word.

## Links
Supersedes: parked ADR 0087 (PR 85) · Amends: ADR 0084 D5, Consequences · Record: docs/design/adr-0090-rank-by-rarity.md
