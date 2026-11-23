# ADR 0087: A memory that matches only a common word ranks after one that matches a rarer word

Status: Proposed 2026-11-23, NOT CLEARED and parked: do not merge · Review 1: four findings; review 2: NOT CLEARED, redesigned; recheck: NOT CLEARED (design record) · Jay decides the next approach

## Context
In 0.29.0 a confirmed memory gets a flat boost once it matches one query word (ADR 0084 D4, D5). On the brain bench (PR 84) an agent searched "car vehicle Morgan drives". The user's name is in every confirmed memory of that fictional vault, so each matched one word, took the boost, and filled all eight results. The memory holding the answer matched two words and was not returned.

## Decision
- D1: A query word is common when 20 or more rows are searched and more than a tenth of them contain it. On the device a type or scope filter does not change this: commonness is measured on every row the app may see.
- D2: A common word still counts toward a match and its score. But a row that matches only common words is listed after every row that matches a rarer word. Within each group the order is as before.
- D3: This comes before ADR 0084 D8. An old AI session note that matches a rarer word is listed before a fresh row that matches only a common one.
- D4: Search by meaning: a row at or above the meaning threshold is not demoted, whatever words it matched.
- D5: One function, `rareTerms`, in both search-rules files, inside the block the drift test compares. The connector applies it in `rankSharedEntries`, which both of its search tools call; there a scope or type name counts as a rarer match when few rows carry it.

## Consequences
- Easier: a query that names the user no longer loses an answer that matches a rarer word.
- Worse, found on recheck: an answer made only of common words is pushed out when eight unrelated rows match one rarer word in the query.
- Not fixed, in KNOWN-LIMITS: the boost is flat, so confirmed memories that share a rarer word with the question can still fill every result; a nickname in under a tenth of memories counts as rare; in search by meaning, rows close in meaning keep their boost.

## Rejected
- Dropping common words from the query: review 2 showed it loses a right answer ("Morgan employer" returned only another person's employer).
- Weighting every word by rarity (BM25): a ranking rewrite. The bench should score it first.
- Removing the boost from name-only matches: recency and type are flat too.

## What leaves the machine
Nothing new. The connector counts, in memory and for one request, how many of the rows it already decrypts to rank contain each query word. It stores and logs nothing from that.

## Links
Amends: ADR 0084 · Design and review record: docs/design/adr-0087-common-words-do-not-count.md
