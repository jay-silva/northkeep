# ADR 0054: The project board (M-D1)

Status: Accepted 2026-09-23 (M-D1); Jay's acceptance passed all ten steps · Review: design NOT CLEARED twice, third draft CLEARED WITH WOUNDS (fixed); code review CLEARED WITH WOUNDS, recheck CLEARED · The model half moved to ADR 0056 · Corrected 2026-09-24

## Context
With 31 projects, `project_list` answers "what exists", not "what needs me". What is quiet and what is due are computable without a model. Review-gated because it publishes a claims table.

## Decision
- D1: Five sections, pure functions in `packages/core` (no I/O, model or network):
  - Stale: not Done, no activity for `N` days (default 14). Imported heads are aged from their newest past Log entry date.
  - Dated items: `YYYY-MM-DD` and month-first dates in Next Actions and Open Questions; yearless dates resolve to the nearest occurrence; checked tasks give no row.
  - Open sessions: ADR 0052's `openSessions` (30 days, newest three per project), read with `readCallLogStrict`; an unreadable log shows `unavailable`, never an empty list.
  - Drafts; Needs repair (`conflict`, `unreadable`, caught per project).
  - Done: the status line begins with bare `Done`, `Complete` or `Completed`, then end of line or `.`, `:`, `!`. The output states this rule.
- D2: Read-only: MCP `project_board` (`stale_days`) and `northkeep projects board [--stale-days N] [--json]`, reading through core, never `project_get` or `project_resume`. MCP passes the grant as `allowedScopes`; the CLI is the owner's full view.
- D3: Every text field passes `tameOneLine` and fence-marker removal. Caps: status 120, dated line 160, host 80 UTF-16 units; 50 rows per section with `total` and `shown`. Ceiling 131,072 bytes on the MCP wire, tested by a saturating fixture (117,948 measured on 0b95c01). Never a whole document, Log, Decisions body or `content` field. Tier-1 masking (`maskProjectPayload`) runs after the caps.
- D4: Calls are logged through `run()` but are not reads: ADR 0052 Claim 2 gains "`project_board` calls are logged but are not reads for this claim; only `project_get` and `project_resume` open a session."

## Consequences
- Committed to: a tested claims table (no model or network; zero vault writes on a current-schema vault; hostile-text stripping; wire ceiling; grant narrowing; strict log reading; masking).
- Limits: "Done" is wrong in both directions. Open sessions are per machine; connector sessions are invisible. Caps can hide work past 50 rows. Under Tier-1 a masked field can exceed its cap or lose its date. Month names read only as `Sep 20`. An imported project with no readable Log date is aged from its import. Oversized raw documents cost time, not payload.

## Rejected
- Reading via `project_get` / `project_resume`: would plant the open sessions it reports.
- A state field, schema change, board writes, background runs, ranking, any model.

## What leaves the machine
The original states the board does not touch egress, redaction tiers, crypto, sync, the connector, the vault schema or any model, adds no dependency, and makes no network call.

## Links
Full record: docs/design/adr-0054-project-board.md · Extends: ADRs 0039, 0048, 0052 · Amends: ADR 0052 Claim 2 · Related: ADRs 0053, 0056
