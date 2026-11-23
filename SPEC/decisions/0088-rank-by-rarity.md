# ADR 0088: Search weighs words by rarity, and bonuses scale with the match

Status: Proposed 2026-11-23 (Jay: "Build the ranking fix.") · Review: see the design record · Not built

## Context
0.29.0 scores a memory as the share of query words it holds, plus up to 0.3 for recency, 0.15 for type and 0.5 if confirmed. The extras outweigh the match: one word of four is worth 0.25. A query holding the user's name returned eight confirmed memories and not the answer (KNOWN-LIMITS). Two narrower fixes failed review (PR 85).

## Decision
- D1: Each query word is weighted by how rare it is: ln((N + 10.5) / (n + 0.5)), where N rows are searched and n hold the word. The 10 steadies small vaults. Keyword overlap is the weight matched over the weight of all query words.
- D2: Recency, type and the confirmed boost multiply the match instead of adding to it: overlap × (1 + recency + type + confirmed), at today's values.
- D3: The long-row cut grows to 0.15 per doubling past 64 distinct words, up to 0.5 (from 0.1 and 0.3).
- D4: Search by meaning scores (0.7 × similarity + overlap) × (1 + the same bonuses). Which rows are admitted does not change.
- D5: Under a type or scope filter, N and n are counted over every row the app may see.
- D6: The connector uses the same weights over the shared rows it decrypts for the request. A scope or type name still counts half, weighted by how rare that name is. Confirmed multiplies by 1.5.
- D7: Unchanged: stopwords, plural folding, the paperwork skip, old AI session notes last (ADR 0084 D3, D5, D8), and result counts.
- D8: One `wordWeights` function in both search-rules files, inside the drift-tested block.

## Consequences
- Easier: a row matching only a common word cannot outrank one matching a rare word, whatever its bonuses.
- Harder: scores change scale. Converse keeps memories within 60% of the best score, so it drops more weak matches. The relevance number shown to AI apps and in the Mac app changes.
- Not fixed: confirmed memories that match the question as well as the answer does still rank first. Words must still match: "cleaner" does not find "cleans".
- Ready when: the eight hard cases from PR 85's reviews pass as tests, existing search tests pass, and the bench's replay loses none of the 275 recorded searches that find the answer today.

## Rejected
- PR 85's designs: each lost a right answer.
- Multiplying bonuses with equal word weights: finds seven of the eight hard cases.
- Rarity with no prior: breaks two existing tests on small vaults.
- Counting repeats of a word in a row (full BM25): presence is enough; D3 handles long rows.

## What leaves the machine
Nothing new. The connector counts, in memory for one request, how many rows it already decrypts contain each query word. It stores and logs nothing from that.

## Links
Supersedes: the parked ADR 0087 (PR 85) · Amends: ADR 0084 D4 · Design and review record: docs/design/adr-0088-rank-by-rarity.md
