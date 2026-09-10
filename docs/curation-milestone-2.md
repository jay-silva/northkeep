# Milestone 2: organize without losing meaning

Status: implemented, integrated, and accepted locally by the owner on 2026-09-10. Owner selected C's main sidebar, A's vertical suggestions queue and Source memories/Proposed memory terminology, then accepted the completed functionality and visual revision. Milestones 1 and 2 are not released.

## User outcome

Turn several overlapping memories into one useful, accurate memory while retaining the originals as inspectable history. Fewer entries is not inherently better: independent facts and contextual exceptions should remain distinct.

Approved entry: choose a private collection, then inspect suggestions and optionally provide a focused instruction such as “Consolidate my writing preferences, but preserve exceptions.” The instruction guides drafting only; it grants no permission to change memories or expand the selection.

Composition references: `.impeccable/mocks/curation-2-a.png` (queue and evidence workbench), `curation-2-b.png` (focused sequential review), and `curation-2-c.png` (comparison and sidebar). The owner selected C's sidebar form blended with A's vertical queue and Source memories/Proposed memory language. Built-in image generation used synthetic content and the existing UI as a brand reference; exact prompts accompany each image. Generated images are not executable screens or accessibility evidence. Keep real destinations rather than invented Home navigation. Explanation stays outside the editor, speculative character counts are omitted, and confirmation freezes exact text. Mobile and appearance checks apply to the built implementation.

## Approved workflow

1. Select a collection and optionally narrow the included memories. Show the selected count, privacy status and excluded project documents.
2. Generate candidate groups, with full source text and a concrete explanation of why each group might benefit from consolidation. Related does not mean redundant.
3. Inspect one group in the existing evidence/editor workspace. Show a proposed replacement, editable verbatim, alongside which sources it would supersede. Allow removing a source from the group, which invalidates the old draft until reviewed again. Provide “Keep separate” and a focused clarification when meaning is uncertain.
4. Preview the exact result: selected originals become history; one new memory becomes active in the same collection. No model runs during save. Confirm one group at a time.
5. Inspect the result's source lineage and local change receipt. Offer restoration as a new compensating operation only while all affected heads remain compatible; never roll back unrelated work.

Inherit the approved warm palette, typography and queue/detail layout. Use C's main sidebar form and A's vertical scrollable suggestions list, with Source memories/Proposed memory labels. Keep explanation outside the editable content. The owner's subsequent navigation revision removes Legacy chat, combines collection browsing with Memories, and places Desktop and Cloud under a collapsed Connect group. Existing stored data and connection/settings access remain intact. At 390px, retain the queue/back pattern and stack full source evidence before the replacement editor. Preview dialogs must preserve readable selection states in both themes, trap focus and return focus on Escape.

## Scope boundary

Start with bounded, same-type groups inside one private, non-project collection. No cross-collection moves, shared destinations, automatic sharing, autonomous saves, bulk acceptance, or project-document consolidation. Broader organization, splitting and project handoffs remain separate work. Removing the Legacy chat destination does not delete its stored data or remove import support.

A source-linked consolidation is the first complete organization operation. Topic-only grouping must not silently move memories into scopes, since scopes also control disclosure.

## Engineering conditions before implementation

- A pre-implementation ADR and adversarial source review must define the new many-to-one mutation, metadata provenance, disclosure checks and grouped restoration.
- Preserve the encrypted vault format if existing fields can represent the operation faithfully. Do not infer backward compatibility from unchanged columns alone: test older-reader behavior with multiple originals pointing at one result.
- Add an all-or-nothing core operation, not a loop of separately saved edits or a remember-plus-forget sequence. Validate every full source snapshot before mutation. Preserve original content and avoid arbitrarily inheriting one source's dates or confidence as authority for the whole result.
- Extend strict report/receipt validation and crash reconciliation deliberately for many-to-one cardinality; the milestone-1 receipts assume narrower actions. Bind exact wording, source membership and destination to each operation ID.
- Preserve source lineage through vault export/import independently of the local plaintext review receipts. The local receipts remain nonportable unless separately redesigned.
- Enforce private-only selection again at save, not only when drafting: a collection's sharing status may change while a draft is open. Grouped restoration should derive its source content from encrypted vault history wherever possible rather than require a larger plaintext sidecar. Settle portable recovery versus local workflow receipts explicitly in the ADR.
- Verify generation makes zero vault writes; stale groups refuse; retries apply once; interruption cannot leave half a group replaced; restoration refuses after incompatible changes. Include contradictory qualifiers, numbers, dates and instruction-like source text in model evaluation.
- Before release, demonstrate old release to new version and back, export/import and isolated sync compatibility with disposable data. Never use an existing user's vault as the test fixture.

## Delivery sequence

Workflow and the C-sidebar/A-workbench blend are approved. ADR 0047 and pre-implementation review preceded the core operation, local proposals and interface. Final safety checks and owner acceptance completed this local milestone on 2026-09-10. No deployment, new cloud provider or project-coordination milestone is authorized by this work.

## Read-only feasibility review

GPT-5.6 Sol inspected the existing core, report/session and API source before implementation. The initial feasibility review suggested manual groups; the owner subsequently selected automatic suggestions plus focused instructions. ADR 0047 records the separate adversarial review and implementation contract. Milestone-1 report files remain unchanged by this workflow; M2 proposals stay in memory and recovery lineage stays inside the encrypted vault.

## Verification record, 2026-09-10

RULES 2026-09-07.1. Owner authorization: “make it happen,” following approval of the blended composition. Work used an isolated checkout, no environment secrets, and newly created sample vaults. No existing local vault was used for tests, and no release or deployment was performed. The NorthKeep project status was successfully updated separately at handoff.

The full regression run passed 1,525 tests with one existing skip. The final scoped contrast correction passed all 21 UI checks. Eight real HTTP curation tests passed, including exact save/retry, lock/reopen and restoration. Core, librarian, web and CLI TypeScript builds passed. Version 0.21.0 core successfully opened/exported/saved after consolidation and after restoration. Complete JSON export/rebuild and encrypted-file replication have separate core tests; neither is a live hosted-sync or packaged mobile certification.

The actual installed qwen2.5:14b model was called with five synthetic memories and made zero vault writes. It retained a technical-review exception, returned a rejected singleton, and raised a question for distinct numeric preferences. The response is mirrored in a regression test. This is evidence of validation behavior, not a claim of excellent general model accuracy.

Desktop and 390px browser checks exercised five vertical suggestions, exact preview, Escape/focus return, save, history and restoration. This was the verification evidence available before acceptance; later navigation and visual checks are recorded in `docs/navigation-acceptance.md`. Run `docs/consolidation-acceptance.md` for a safe sample. The owner accepted the completed local functionality and visual revision on 2026-09-10.
