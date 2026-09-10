# NorthKeep: curation and continuity

Status: milestones 1 and 2 were accepted locally by the owner on 2026-09-10 after the selected-collection contrast correction and visual revision. Release is pending. Milestone 3 has not started.

## Product direction

NorthKeep is a user-owned memory and project vault for people working across AI assistants. Human-directed curation and reliable project continuity are the two primary experiences. Privacy, export, and access boundaries remain foundational. Existing chat and redaction remain available; expanding them is not the current priority.

The primary audience is a person with useful but fragmented memories and ongoing work spread across assistants. Their success is a collection they understand and trust, followed by a handoff another assistant can use. The app retains its existing warm Meridian palette, green actions, serif headings, and familiar controls. This is an Operate surface, extending Memories, not replacing the brand.

## First milestone: a trustworthy memory review

Target: desktop/local web Memories experience, responsive at 390px. The attached `curation-mock.svg` and `curation-states.svg` are approved screen sequences with entirely synthetic data. They are visual designs, not functioning prototypes or claims of shipped behavior. The narrow mock is a composition study; actual 390px verification occurs during implementation.

1. Select a collection and inspect exactly what the review will include. Explain exclusions and local model readiness before starting. Keep search and browsing independent of review progress.
2. Present a compact queue with an evidence-and-proposal workspace. Show full original entries, their collection, source, recorded date, and any known effective date. Recorded date alone does not prove that a fact is newer or more authoritative.
3. Let the user edit a proposed correction before saving. When facts cannot be reconciled, offer a focused question and “Leave unresolved”; do not invent a resolution. Dismiss changes no memory.
4. Apply one explicitly confirmed change, keep its history, and provide a visible receipt. Restore an earlier version by creating a new revision, never by rolling back the entire vault. Refuse restoration when a later change makes it unsafe without review.

No batch destructive changes in this milestone. Duplicate suggestions initially retain explicit per-member choices; a true many-to-one merge is a later atomic operation. No silent model fallback, background provider send, inferred sharing, automatic deletion, or automatic acceptance. Existing API review remains explicitly chosen and consented per run; this milestone improves the on-device path.

### Screen behavior

- Selection: show collection names, counts, private/shared status, review method and exclusions. Collection selection must be enforced server-side, not just a visual filter.
- Running: show scanned/total and useful progress; allow return to browsing. Partial analysis is labeled incomplete, including skipped embeddings and oversized entries. No model result is presented as an exhaustive assessment.
- Review: desktop queue at left, readable source evidence and editable proposed text at right. At 390px, the queue becomes a back destination; one proposal stacks evidence, explanation and editor, followed by full-width actions.
- Uncertain: distinguish a suggestion from a fact and a temporary exception from a durable change. A later timestamp is evidence to examine, not an automatic winner.
- Save: show the exact effect before confirmation. Save retries cannot create duplicate edits. A report refreshed or changed in another window invalidates obsolete actions.
- History: source and before/after remain inspectable. A restore action displays the exact replacement and preserves subsequent history.
- Empty: distinguish no memories, no findings, nothing left to review, and incomplete analysis. Do not say “all correct.”
- Accessibility: semantic headings, text labels, visible keyboard focus, 44px targets, no type below 11px, announced progress and save outcomes. Any dialog traps focus, closes on Escape, and returns focus to its trigger.

## Implementation preparation

Existing uncommitted curator work belongs to the user. Preserve it and review the combined working tree before integration. Do not reset, stash, or overwrite it as a convenience.

Before implementation, add a new ADR extending 0043 and obtain an adversarial code review for the changed review/write boundaries. Keep 0043's existing history intact. The ADR must settle:

- Exact-match semantics: punctuation, signs, decimal points and units can carry meaning. Only genuinely equal text may take a deterministic duplicate path. Similarity produces candidates, never correctness.
- Evidence ownership: every replacement target must be among the explicitly supported sources; all cited sources must be live, selected and within the review's boundaries. Exact quotes alone do not prove a valid conclusion.
- Snapshot identity: bind review and apply to a vault identity, report/run ID and full source revisions. Bind any provider consent to the actual selected entries, not counts alone.
- Durable operations: record operation IDs and affected revisions so vault saves and report updates can recover from partial failures. Idempotent retry must return the original result. An audit entry cannot claim an operation succeeded before persistence succeeds.
- Recovery: record replacement lineage and restore with a new revision only after checking the current head. A “restore” control must not be added until its storage semantics are verified.
- Content handling: source and model text are untrusted, rendered as text; neither may supply action parameters, approval, scope expansion or tool instructions. Reports need vault association, retention and confidentiality treatment consistent with the existing local report design; any crypto change is separately reviewed.

Likely touch points: `packages/librarian/src/reviewCluster.ts`, `review.ts`, `reviewSchema.ts`, `reviewReport.ts`, `reviewApply.ts`; local web review handlers and Memories view; core version history only where required. Reuse current authentication/session gates. Every new route must state its gate. No new network dependency is planned.

### Acceptance and quality evidence

Use a session-created vault with synthetic examples and isolated configuration. Do not import production credentials or run tests against the owner's vault. Before delegating executable work, create and verify an isolated worktree without environment files; include the existing curator changes without secrets.

The quality set includes exact repeats, paraphrases, merely related facts, signed/decimal values, temporal exceptions, opposing statements, and unresolved questions. Include unrelated-target citations, instruction-like source text, unavailable embeddings, long entries, overlapping runs and interrupted saves. Report false duplicate suggestions, unsupported corrections, missed planted issues, and abstentions separately. Retrieval/packing coverage and model judgment are evaluated separately.

Acceptance requires: zero memory changes while reviewing; selected collection enforced; no false deterministic duplicate for changed numeric meaning; unsupported target rejected; edits applied exactly as shown once; dismissed memories unchanged; old reports refused; previous version inspectable and safely restorable; partial results visibly labeled; no unexpected network send; search usable during review. Perform a real local model run with synthetic data, then review its results manually rather than relying only on model mocks. Test every changed write path, typecheck, and inspect desktop and 390px layouts. Jay completes the same short workflow and confirms it passed before the next milestone begins.

## Subsequent milestones

2. **Organize meaning, accepted locally 2026-09-10:** user-directed consolidation with source lineage and focused instructions. Model suggestions are previewed, exact writes are confirmed, and recovery is implemented. Cross-scope moves, splitting, and shared destinations remain outside this milestone.
3. **Reliable project handoff:** paired resume/checkpoint/wrap workflow; distinguish session history, current state and durable memories. Record completed work, evidence, open questions, next actions and accessible artifacts. Save receipts and client-read revision checks prevent stale status overwrites. Test a real handoff between two supported clients, including failure to access an artifact. Draft skill text for approval before installing or changing instruction channels.
4. **Project-aware curation and concurrent work:** curate project knowledge without treating the canonical working document as an ordinary duplicate. Link conclusions to session evidence. Add task ownership, conflict handling and append-only session events only after sequential handoffs pass. Shared memory alone is not a simultaneous coordination guarantee.

After the first loop is accepted, align navigation and onboarding around Memories and Projects, retaining existing privacy controls. Update public positioning and compatibility claims only after verification and release approval. Do not claim universal access to a platform's native memory or automatic availability of referenced artifacts.

## Success measures

Use opt-in user observation and synthetic evaluation; do not add telemetry. Track proposal usefulness, correction effort, preserved meaning, successful recovery, and repeated curation sessions. For continuity, track whether a second assistant resumes accurately without pasted context. Memory count is not the success metric.

## Read-only implementation gap review

Independent reviewer inspected the current working tree without executing project code or accessing data/services. Parent checked the relevant paths. These are source-level findings, not executed reproductions or a completed adversarial review of a future implementation:

1. `reviewCluster.ts:31`: punctuation/symbol removal maps “1.5” and “15”, or “+10” and “-10”, to identical normalized strings. `review.ts:120` emits those groups without model judgment. This is unsuitable as an exact semantic duplicate signal.
2. `reviewSchema.ts:252`: contradiction evidence and replacement target are not required to identify the same entries. `reviewApply.ts:71` applies the resulting replacement. Require target-linked evidence and show full original text.
3. `reviewReport.ts:25`: one report filename; `api.ts:1620` actions identify a proposal without a run ID. `api.ts:1651` saves the vault before the report, creating a partial-failure window. Version-bound operations and recovery must precede a trustworthy receipt/restore experience.
4. `review.ts:126`: exact groups are removed from later semantic comparison. Embedding failures skip entries, while report counts can still describe the full selection. Preserve representatives and expose real coverage.
5. `api.ts:1867`: provider consent selection fingerprints are based on scope metadata/count, not full entry identity/content. Strengthen the existing consent path before claiming that only the reviewed snapshot can leave.

The duplicate action also allows every member to be forgotten. The initial improved UI should expose a retained original explicitly and prevent accidental removal of the last member. A true merge with a new retained result remains milestone 2.

Design-session validation was source inspection and independent review only. Implementation verification is recorded in ADR 0046; approval of the mock does not constitute acceptance of the implemented product. No production writes or release are authorized by this milestone.
