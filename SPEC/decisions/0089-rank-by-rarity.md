# ADR 0089: Search weighs words by rarity, and bonuses scale with the match

Status: Proposed 2026-11-23 (Jay: "Build the ranking fix.") · Review 1: NOT CLEARED, revised; recheck in the design record · Not built

## Context
0.29.0 scores a memory as the share of query words it holds, plus up to 0.3 for recency, 0.15 for type and 0.5 if confirmed. The extras outweigh the match: one word of four is worth 0.25. A query holding the user's name returned eight confirmed memories, not the answer (KNOWN-LIMITS). Two narrower fixes failed review (PR 85).

## Decision
- D1: Each query word is weighted by how rare it is among the rows searched: ln((N + 10.5) / (n + 0.5)), N rows, n holding the word. The 10 steadies small vaults. A word no row holds weighs nothing. The match is weight matched over total query weight.
- D2: Recency, type and the confirmed boost multiply the match: match × (1 + recency + type + confirmed), at today's values.
- D3: The long-row cut becomes a multiplier: 15% off per doubling past 64 distinct words, up to half.
- D4: Search by meaning scores (0.7 × similarity + match) × (1 + the same bonuses). Admission is unchanged.
- D5: The connector applies the same weights to the shared rows it decrypts for the request. A scope or type name still counts half, weighted by its rarity among those names. Confirmed multiplies by 1.5.
- D6: Unchanged: stopwords, plural folding, the paperwork skip, old AI session notes last (ADR 0084 D3, D5, D8), and result counts.
- D7: One `wordWeights` function in both search-rules files, inside the drift-tested block.

## Consequences
- Easier: a memory sharing only a common word, such as the user's name, no longer outranks one matching a rare word. Bonuses lift a score at most 1.95 times.
- Changed on purpose: a confirmed or newer memory wins when matches are close, but no longer beats one that matches a weighty extra word. KNOWN-LIMITS and ADR 0084's "confirmed facts outrank guesses" are reworded in the build PR.
- Harder: scores change scale, and Converse keeps fewer weak matches.
- Not fixed: many confirmed memories sharing a middling word can still crowd out an answer; words must still match ("cleaner" does not find "cleans").
- Ready when the bench's hard cases and kept checks pass as product tests, by word and by meaning, on device and connector; existing tests pass; replay loses none of 275 recorded searches.

## Rejected
- PR 85's designs: each lost a right answer.
- Equal word weights with multiplied bonuses: loses one hard case.
- Rarity with no prior: breaks two existing checks.
- Counting a word no row holds: it wiped out long answers (review 1).
- Counting over the whole vault under a filter: brought the crowding back (review 1).

## What leaves the machine
Nothing new. The connector counts, in memory for one request and never kept, how many rows it already decrypts contain each query word.

## Links
Supersedes: parked ADR 0087 (PR 85) · Amends: ADR 0084 D5, Consequences · Record: docs/design/adr-0089-rank-by-rarity.md
