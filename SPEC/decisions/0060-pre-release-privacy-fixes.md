# ADR 0060: Pre-release privacy fixes for 0.22.0 (D2, D3, D4, D6, D7, D8, D9)

Status: Accepted, released in 0.22.0 (2026-09-24) · Review: design and code CLEARED WITH WOUNDS, each rechecked; final fix Jay-approved without another round · Amended 2026-09-25 (PA-F7, PA-F10)

## Context
The 0.22.0 release pass found: cloud review sent memories unredacted (D2); MCP error text reached the model unfenced (D3); `NORTHKEEP_REDACT_TIER=2`/`3` masked nothing (D4); the vault's own server was `strict`, corrupting saves (D6); writes could land unlogged (D7); stale Log text (D8). Recheck found D9: the name model read only 6000 characters.

## Decision
- D1 (D2): Cloud review masks content at the consent panel's tier; only `prepare` handles reach `send`. Per-run tagged tokens restore locally, only from memories listed and validly quoted. A Tier-2 item still degraded after one retry refuses the run before any send; degraded Tier 3 proceeds, labelled deterministic only. A pending audit row with the ids precedes sending.
- D2 (D4): `parseReturnRedactionTier` (MCP and CLI) honors 0 to 3 and refuses any other value. Tiers 2 and 3 mask returns; Tier 3 cuts dates to years except handle fields; degraded Tier 2 returns no content, degraded Tier 3 returns with a note. At tier 1 or more, project writes and content edits are refused; at 2 and 3, `memory_remember` too.
- D3 (D3): Third-party error text is sanitized, capped at 2000 code points and fenced with `wrapUntrusted`.
- D4 (D6): The catalog `vault` entry is `trusted`; custom adds stay `strict` unless an exact command-and-args match with no `env` or `cwd` is confirmed by the user. ADR 0029 screens still run.
- D5 (D7): No pending log row, no tool run.
- D6 (D8): `project_update` text describes Log rolling.
- D7 (D9): The name model reads whole texts in overlapping 6000-character windows; one failed window degrades the text. Tier 3 masks at least what Tier 2 masks on the same text and model.

## Consequences
- Limits: review quality drops over placeholders (R3); masking is only as good as the tier (R2). Collection names are not name-checked (R1, O2), though names detected elsewhere are masked there. Dated handles stay exact over MCP at Tier 3 (R12). The error fence reduces, not removes, injection (R8, R14). Real-provider token handling was observed only on a few Claude models (R10). At Tier 1 `memory_remember` can store a placeholder as literal text (R9).

## Rejected
- Refusing Tier-1 saves containing placeholder shapes (O1).

## What leaves the machine
The original has no egress section; per its decisions: cloud review, to the chosen provider: masked content; ids and types as written; collection names Tier-1 masked, plus detected names, plus dates at Tier 3; `created_at` year-only at Tier 3; for allowlisted Anthropic models, the fixed `REVIEW_OUTPUT_SCHEMA`. Trusted vault server arguments go unmasked into the local vault, leaving later only by existing paths (encrypted sync, user-initiated Share push). MCP returns reach the host masked at the set tier.

## Links
Amends: ADRs 0043 (P3, P8), 0033 (Decision 3), 0052 · Full record: docs/design/adr-0060-pre-release-privacy-fixes.md
