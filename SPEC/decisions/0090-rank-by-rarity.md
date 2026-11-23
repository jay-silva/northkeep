# ADR 0090: Search weighs words by rarity, and bonuses scale with the match

Status: Proposed 2026-11-23 (Jay: "Build the ranking fix.") · Review 1: NOT CLEARED, revised; recheck: CLEARED WITH WOUNDS, fixed · Not built

## Context
0.29.0 scores a memory as the share of query words it holds, plus up to 0.3 for recency, 0.15 for type and 0.5 if confirmed. The extras outweigh the match: one word of four is worth 0.25. A query with the user's name returned eight confirmed memories, not the answer. Two narrower fixes failed review (PR 85).

## Decision
- D1: Each query word is weighted by its rarity among the rows searched: ln((N + 10.5) / (n + 0.5)), N rows, n holding the word. The 10 steadies small vaults. A word in no row weighs nothing. The match is weight matched over total query weight.
- D2: Recency, type and the confirmed boost multiply the match: match × (1 + recency + type + confirmed), at today's values.
- D3: The long-row cut becomes a multiplier: 15% off per doubling past 64 distinct words, up to half. A confirmed memory is not cut.
- D4: Search by meaning: (0.7 × similarity + match) × (1 + the same bonuses). Admission is unchanged.
- D5: The connector applies the same weights to the shared rows it decrypts for the request. A word in a scope or type name counts at half its weight among those names, in the match and the total. Confirmed multiplies by 1.5.
- D6: Unchanged: stopwords, plural folding, the paperwork skip, old AI session notes last, result counts.
- D7: One `wordWeights` function in both search-rules files, in the drift-tested block.

## Consequences
- Easier: a memory sharing only a common word, such as the user's name, no longer outranks one matching a rare word. Bonuses lift a score at most 1.95 times.
- Changed on purpose: a confirmed or newer memory wins when matches are close, but no longer beats one matching a weighty extra word, which can be the wrong one (examples in the record). The build PR rewords KNOWN-LIMITS and ADR 0084.
- Harder: scores change scale; Converse keeps fewer weak matches.
- Not fixed: many confirmed memories sharing a middling word can still crowd out an answer; "cleaner" still does not find "cleans".
- Ready when the bench's hard cases and kept checks pass as product tests, by word and meaning, on device and connector; existing tests pass; replay loses none of 275 searches.

## Rejected
- PR 85's designs: each lost a right answer.
- Equal weights with multiplied bonuses: loses two hard cases.
- Cutting long confirmed memories: fresh notes repeating the question outranked them (recheck).
- No prior: breaks two existing checks.
- Counting absent words: wiped out long answers (review 1).
- Counting the whole vault under a filter: crowding returned (review 1).

## What leaves the machine
Nothing new. The connector counts, in memory for one request and never kept, how many rows it already decrypts hold each query word.

## Links
Supersedes: parked ADR 0087 (PR 85) · Amends: ADR 0084 D5, Consequences · Record: docs/design/adr-0090-rank-by-rarity.md
