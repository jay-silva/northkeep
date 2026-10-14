# ADR 0056: Cross-project contradictions on the local model (M-D2)

Status: Draft, NOT CLEARED, 2026-09-23 · Split from ADR 0054 Decision 2; reviewed twice there 2026-09-21, NOT CLEARED · Does not build until the five required items are met and a review clears it

## Context
Project documents can contradict each other; the ordinary review excludes `project:` scopes (review.ts:70-72). Project text is written by agents and, under ADR 0050, by connected apps, so it is untrusted input in front of a model whose output then goes to a human review surface. That trips the review gate twice.

## Decision (proposed, not cleared)
- Required before the next draft: (1) enforce `PROJECT_DOC_MAX_CHARS` on every write into a project scope as a core invariant, including rows arriving by sync or connector; (2) chunk on code-point boundaries with a hard cap, with a rule for a section with no break; (3) sanitize every string entering model context or a report (Unicode `Cc`, `Cf`, `U+2028`, `U+2029`, unpaired surrogates, and the `===BEGIN MEMORY DATA===` / `===END MEMORY DATA===` markers) with a multi-line variant of `tameOneLine`; (4) pass `allowedScopes` on every read; (5) a measured bound on pair explosion.
- D1: Pass A extracts claims per document; each needs a verbatim quote and entry id (ADR 0043 P4, P5) or is dropped. Documents over `MAX_REVIEW_ENTRY_CHARS` (12,000) are chunked, never skipped for size.
- D2: Pass B compares claim lists. Same-project pairs, and findings naming any id that is not a live entry in the selected project scopes, are dropped and counted.
- D3: Model policy is ADR 0043 Decision 4 unchanged: `qwen2.5:14b`, then `qwen2.5:7b`, then a loud refuse. Never a cloud model, no API fallback (Jay, 2026-09-09).
- D4: The pass writes nothing during a run. Accept is one user action on one finding, via `project_update` with the `expected_revision` the board read; a stale revision refuses without mutation. Refused under Tier-1 (`refuseProjectWriteUnderTier1`). No accept-all, threshold or auto-apply (ADR 0043 P6).
- D5: Lifts the project-scope exclusion for this pass only.

## Consequences
- Limits: prompt injection is mitigated (fenced data, verbatim quotes, vault text shown by id, user-only accept), not solved; an attacker who can write two project documents can still spend the user's attention. Recall is unknown; a local 14B model will miss contradictions, and output must not imply completeness. Pair coverage is bounded by an unvalidated prefilter and cap; the run must report pairs compared and skipped.
- Out of scope: merge or dedupe, scheduled runs, any GUI surface (MCP tool and CLI only), any API model.

## Rejected
- Comparing whole documents: 31 at 16,384 characters is about 500 KB, past any local pack.
- Accepting via raw ADR 0015 supersede: bypasses ADR 0048 revision checks.

## What leaves the machine
Proposed, not built. The original states it does not touch egress, redaction, crypto, sync or the connector; local Ollama only, no new dependency.

## Links
Full record: docs/design/adr-0056-local-model-contradictions.md · Depends on: ADRs 0054, 0043, 0048, 0050 · Supersedes in part: the review pass project-scope exclusion
