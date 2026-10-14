# ADR 0043: Memory review pass (unnamed): local report, user-approved supersede

Status: Accepted 2026-08-27 · Review: KEEP WITH PATCHES (design P1 to P8; API addendum AP1 to AP8); 2026-09-09 addendum CLEARED WITH WOUNDS · Corrected 2026-09-24 (ADR 0060 Decision 1; 0.22.0 doc-vs-code pass)

## Context
Claude's audit of Jay's memories found real duplicates, contradictions and stale facts; this pass productizes it, unnamed in product copy. The model is a finder, the user is the judge.

## Decision
- D1: A run reads live entries except `project:*` (Shared included) and writes a local report, never a memory, never synced. Zero vault writes during the run.
- D2: The review session has no tools and no vault handle (P1); output must parse against a pinned schema, `auto_apply` is ignored (P2); memories are delimited data under a pinned prompt (P3).
- D3: Quotes must be verbatim substrings of the cited entry, two for a contradiction, or the proposal is dropped; the UI shows vault text by id (P4, P5).
- D4: Apply is a user action. Accept calls ADR 0015 supersede; a duplicate member can be forgotten (`Vault.forget`); reject and dismiss write nothing. The model cannot apply or forget. Since 0.22.0, "Remove all" forgets one duplicate group after a confirmation listing each member (ADR 0046), and ADR 0047 consolidation supersedes 2 to 8 sources in one confirmed operation. No accept-all, auto-apply or scheduled write.
- D5: Local `qwen2.5:14b`, else `qwen2.5:7b`. Ollama down or neither model is a loud refuse, never an API hop.
- D6: Cluster first (P9): exact normalized-hash duplicates emit with no model call; with `nomic-embed-text`, cosine >= 0.78 forms packs sent to the local model; missing nomic is a loud skip. Review embeddings are RAM-only, never written to the `.nkv`. Undated proposals are off (P10).
- D7: An explicit per-run API path: GUI only, no sticky preference, `bounded` endpoints only. Consent names destination, memory count and per-scope counts, marks Shared scopes as a new egress on top of Cloud Connect, and is bound by a selection fingerprint.

## Consequences
- Limits: the model will miss real defects and invent false ones; P4/P5 make false ones catchable, not the pass complete. Prompt injection cannot be proven absent; P1 to P3 bound it to the report.

## Rejected
- Accept-all, auto-apply, scheduled writes: writes without user action.
- A cloud model for quality: quality stays on-device.

## What leaves the machine
Local path: nothing. API path, per-run consent only, to the named provider: since ADR 0060 Decision 1, content is masked at the panel's tier (1, 2 or 3), secrets in collection names are masked, Tier 3 cuts collection-name dates and the recording date to the year; ids, types and names in collection names leave as written (open item O2). Tier 2 refuses the run if the name model fails. An audit row with the ids precedes the first send.

## Links
Extends: ADRs 0015, 0039 · Amended by: ADRs 0046, 0047, 0060 · Full record: docs/design/adr-0043-memory-curator.md
