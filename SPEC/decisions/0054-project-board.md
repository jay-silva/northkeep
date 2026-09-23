# ADR 0054: The project board (M-D1)

- **Date:** 2026-09-21, third draft 2026-09-23
- **Status:** Accepted (milestone M-D1): built, reviewed, and Jay's acceptance run passed all ten steps on 2026-09-23 (board over the 30 imported projects: 11,309 bytes). Third draft. Scoped by Jay on
  2026-09-21 in two parts: D1 ships without a model, D2 runs on the local
  model only under his 2026-09-09 local-only decision. Reviewed twice on
  2026-09-21 against the design, NOT CLEARED twice. On 2026-09-23 D2 moved
  to its own draft, ADR 0056, so this ADR now covers D1 only; the second
  pass's required list is answered item by item under "Third draft: the
  required list, answered". D1 is inside the review gate because it
  publishes a claims table. Third draft reviewed 2026-09-23: CLEARED WITH
  WOUNDS (five wounds, one scar); Jay chose to fix all five and narrow the
  Done rule. Recheck 2026-09-23: all closed, one new wound in the gate's
  wording (FR1), fixed in text with the recheck's notes. **Cleared for
  build** on Jay's "Yes do both" (2026-09-23): no third review round,
  because the last fix is wording only; the built code gets its own review.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0048
  (revision-bound writes, Tier-1 return masking), ADR 0052 (provenance,
  session accounting, draft projects)
- **Amends:** ADR 0052 Claim 2, by one sentence (Decision 4 below).
- **Does not touch:** egress, redaction tiers, crypto or key handling, the row
  envelope, sync, the connector, the vault schema, any model. The board
  writes nothing to the vault. No new dependency.

## Context

Thirty-one projects is past the number a person holds in their head.
`project_list` returns one row per project (server.ts:607-632, over
`listProjectViews`, packages/core/src/project-handoff.ts:254-257) and answers
"what exists", not "what needs me". The two questions a weekly review
actually asks are what has gone quiet and what is due, and those are
computable from data the vault already holds. A third question, do two
projects now claim contradicting things, is not computable and needs a
model; that is ADR 0056.

## Decision 1: Five sections, computed without a model

Pure functions in `packages/core`, over `ProjectView` and `ProjectSummary`
data the caller already loaded. No vault handle, no clock beyond an injected
`now`, no I/O, no model, no network.

**Stale.** A project whose state is not Done and whose last activity is
more than `N` days before `now`. `N` is configurable, default 14. Sorted
oldest first, ties by slug.

Last activity is `updated_at`, with one exception. A project whose current
head was written by `northkeep projects import` (row source
`northkeep:project-import`, packages/core/src/vault.ts `importProject`)
carries the import time as `updated_at`, which says nothing about when the
work last moved. For such a head, last activity is the newest date a live
Log entry opens with (entries split the way import splits them, ADR 0053),
ignoring any date after today's UTC day, and `updated_at` only when no
entry has a usable date. A date inside an entry's body, such as a deadline,
is not an entry date, and a future date (a year typo) is not activity. The row says which
it used (`last write` or `last log entry`). `ProjectSummary` gains
`imported: boolean` for this; it is derived from the head's source and is
false after the first ordinary write, when `updated_at` becomes true again.

There is no state field in the code. `ProjectSummary` (project-handoff.ts:77)
carries `project`, `scope`, `title`, `status`, `revision`, `updated_at`,
`conflict`, `last_writer_host` and `draft`, and none of those is a state. So
"not Done" is a convention here: a project is Done when the first line
of Current Status that is not empty once cleaned (the status line the
board displays, Decision 3) begins,
case-insensitively, with the bare word `Done`, `Complete` or `Completed`,
followed by the end of the line or by `.`, `:` or `!`. So `Done.`,
`Complete: shipped 2026-09-01` and `DONE` are Done; `Done with phase 1;
phase 2 blocked` and `Complete rewrite in progress` are not. Anything else
is not Done. The board states the rule in its own
output, because a reader who assumes a state machine will be wrong. A real
state field is a schema question and out of scope.

**Dated items.** Each line of the Next Actions and Open Questions bodies
(`ProjectView.next_actions` and `open_questions`, project-handoff.ts:63 and
65) is first split on every line terminator (`\r\n`, `\r`, `\n`, `U+0085`,
`U+2028`, `U+2029`), then made safe and cut to 160 UTF-16 units with
`tameOneLine` (Decision 3). The date sweep runs on the cut line, so every
date the board reports is in the text it shows before masking (Tier-1 may
mask part of the line afterwards; Decision 3). It matches `YYYY-MM-DD` and
month-name dates (`Jan` to `December` with a day, with or without a year),
written month first with the month in title case, so the verb "may" and a
lowercase "march" are not read as dates.
A month-name date without a year resolves to the occurrence nearest `now`:
this year, last year or next year, whichever is closest, ties to the later
one. So `Sep 20` read on 2026-09-23 is 2026-09-20 and shows as overdue at
the top of the list, and `Jan 5` read on 2026-12-20 is 2027-01-05. An
impossible date (`2026-02-30`) is not a match. One row per match: date,
slug and the cut line. Sorted ascending by date, ties by slug then line. Dates in
Decisions and Log are ignored: those are the record, not the plan.

**Open sessions.** Exactly the derivation ADR 0052 Decision 2 defines and
`openSessions` (packages/mcp-server/src/open-sessions.ts:102) already
implements, called once per project scope in the board's result: a session
id that read the project within the last 30 days with no successful write
after the read, current session excluded, newest three per project. Rows
come out of `openSessions` re-serialized, never echoed from the log.

The call log is read with a reader that tells three cases apart:
missing (no file yet, a fresh machine: an empty list is correct), readable,
and unreadable (the file exists and any read error occurs, such as a
permission error or a directory in its place). The existing
`readCallLog` (packages/mcp-server/src/log.ts:94-100) returns `[]` for all
of them, so the board does not use it as it stands: it gains a strict
variant that returns `{ rows }` or `{ unavailable: reason }` and returns
empty rows only when the file does not exist. On unavailable the section
says `unavailable` with the reason and the other sections still render. It
never shows an empty list in that case, because an empty list is a claim
that nothing is open. The same reader replaces the one behind
`project_resume`'s open sessions, whose fallback note at server.ts:723-729
can never fire today because `readCallLog` never throws (review r3, note);
that fix ships ahead of the board as an ADR 0052 bug fix.

**Drafts.** Every project with `draft: true` (ADR 0052 Decision 4), with the
date of its current revision.

**Needs repair.** Two kinds of project cannot be aged or read, and both
are listed by slug under this heading with a reason code, never as stale,
contributing nothing to the other sections:

- `conflict`: more than one current document (`conflict: true`, null
  `updated_at`).
- `unreadable`: `listProjectViews` lists it, but `getProjectView` refuses
  its document (for example duplicate owned sections, project-handoff.ts
  :223). A raw `remember` or a granted `memory_remember` can write such a
  document. The board catches that refusal per project, so one bad document
  never takes the rest of the board with it. Only `ProjectHandoffError`
  refusals are caught this way; any other error still fails the call.

## Decision 2: Two surfaces, both read-only

A `project_board` MCP tool taking only `stale_days`, and
`northkeep projects board [--stale-days N] [--json]` beside the existing
`projects` subcommands in packages/cli. `packages/core` holds only the pure
functions. The tool registration, the call-log read behind open sessions,
payload assembly and rendering live in `packages/mcp-server` and
`packages/cli`. Core gains no call-log reader and no tool.

The board reads projects through core (`listProjectViews`, then
`getProjectView` for each non-conflicted project), never through the
`project_get` or `project_resume` tools, because those tools are what ADR
0052 counts as a read and a board that called them would plant the open
sessions it reports.

**The connection grant.** The MCP tool runs inside the same `run()` wrapper
as every other project tool (server.ts, the `run(ctx, tool, ...)` path) and
passes the connection's granted scopes as `allowedScopes` to both
`listProjectViews` and `getProjectView`. Open sessions are computed only for
project scopes already in the granted result, so a call-log row about a
scope outside the grant never reaches the payload. The CLI is the owner
surface, like `projects export`: it runs on the unlocked vault with no
connection and so no grant to narrow, and it passes `undefined`, which is
the owner's full view. That difference is stated, not implied.

**What the board returns.** Slugs, dates, revision ids, session ids, hosts,
one-line statuses and dated lines. Never a whole document, never a Log, never
a Decisions body, never a `content` field.

## Decision 3: Every string is made safe and capped before it is returned

Every text field in the payload, from any source, passes through
`tameOneLine` (packages/mcp-server/src/text-safe.ts), the sanitizer ADR 0052
closed its injection findings with, and then has the data-fence markers
`===BEGIN MEMORY DATA===` and `===END MEMORY DATA===` removed in one linear
pass that also removes any marker the removal assembles (nested, or joined
across a collapsed space), so the output never contains either marker. No board
output is placed inside that fence today; removing them anyway means an
agent that pastes the board into a curator prompt cannot close the fence
early. It removes (not substitutes) Unicode
`Cc` and `Cf`, `U+2028` and `U+2029` and unpaired surrogates, collapses
whitespace to one space, and cuts at a UTF-16 cap without splitting a pair.
Caps: the status line 120, a dated line 160, a host 80. Slugs are already
`^[a-z0-9-]{1,40}$` (`PROJECT_SLUG_PATTERN`, project-doc.ts:15); dates,
revision ids and session ids are emitted by the board, not copied from
text. The text fields therefore cannot carry ANSI escapes, a bare CR, a line
separator or a bidi override into a terminal, a model context or the JSON
output. `tameOneLine` moves into `packages/core` so the pure functions and
the CLI share it; mcp-server re-exports it so its existing callers do not
change.

**Row caps are absolute, not per project.** Each section returns at most 50
rows plus `total` and `shown`, so a busy board states what it left out
instead of dropping it silently. Open sessions keep the newest three per
project and then the newest 50 overall. With every text field capped and
every section capped, the payload has a ceiling that holds for any number of
projects and any document size.

**The ceiling is 131,072 bytes (128 KiB), measured on the MCP wire**: the UTF-8 bytes of
the complete JSON-RPC response carrying the `project_board` result, as the
server emits it (`ok()` pretty-prints the payload into a text content item,
which the transport then JSON-encodes again). That is the largest
serialization in the product; the CLI's `--json` is smaller and is held to
the same ceiling. It is a measured claim, not cap arithmetic: a test builds
the saturating case (at least 110 projects, so every section is over its
cap at once: 50 stale, 50 with drafts, 50 needing repair, and dated items
and open sessions from the stale ones; every text field at its cap in the
widest form it can take after sanitizing: 3-byte CJK, and quote and
backslash text that JSON escapes twice on the wire), runs it with Tier-1
masking off and on, and asserts the wire bytes are under the ceiling. The
recheck measured 125,857 bytes for that shape with the fields this draft
defines, so the margin is about 5 KB and any new per-row field has to pass
the same test. **Measured at build (2026-09-23): 117,890 bytes**, the
maximum over the saturating fixture's two variants: every field in `"` and
`\`, the 4-byte form, with each dated line opening on the shortest date the
sweep matches (117,890 with Tier-1 off and on alike), and a mixed variant
with CJK and email text that grows under masking (108,556 off, 107,906 on),
in `packages/mcp-server/test/project-board.test.ts`. The CLI's `--json` for
the widest variant measured 77,733 bytes. The built rows carry exactly the
fields Decision 1 lists; the recheck's 125,857 came from the reviewer's own
reading of the row shapes, whose size script is not in the repository, so
the two figures are not the same fixture. No figure is claimed for a typical
board; acceptance step 2 measures the real one.

**Document size does not reach the payload.** The second pass found that
`PROJECT_DOC_MAX_CHARS` is enforced only on the project tool path, so a
`remember --scope project:x` can store a document of any size. For D1 that
is a cost question, not a bound question: every output field is cut after it
is read, so a 60,000-character document yields the same capped rows as a
small one. A test stores a 60,000-character document through the raw memory
path and asserts the board's ceiling and caps still hold. Enforcing the cap
on every project-scope write is still wanted and is a prerequisite of ADR
0056, where a model has to read the whole document; it is not a
prerequisite of D1.

**Tier-1 masking.** `project_board` output goes through
`maskProjectPayload` like every other project tool (server.ts:132-147).
Slugs, dates, revision ids, session ids and hosts are identifier keys and
stay exact; the key `date` is added to `projectIdentifierKeys` for that.
Status lines and dated lines are masked when the setting is on. Masking runs
after the caps, so under Tier-1 a masked field can exceed its cap (the
review saw 120 units become 179) and a dated line can lose the date it was
found in (two adjacent ISO dates can mask as a card number). The `date`
field itself stays exact, and the wire ceiling is tested with masking on. The CLI
masks the same way when `NORTHKEEP_REDACT_TIER=1` is set.

## Decision 4: The board is audited, and it is not a project read

The second pass called the board an invisible reader. It is not invisible:
the MCP tool runs through `run()`, so every call appends a call-log row with
`tool: "project_board"`, its `stale_days` and the scopes whose text it
returned in `disclosed_scopes`, and it refuses like every other tool when
the call log cannot be written. What it is not is a project read in ADR 0052
Claim 2's sense, and deliberately so: a read there means a session loaded a
document it could act on and write back, and the board returns only one-line
excerpts. Counting it would open a session on every project each time
someone looked at the board.

ADR 0052 Claim 2 gains this sentence: "`project_board` calls are logged but
are not reads for this claim; only `project_get` and `project_resume` open
a session." `READ_TOOLS` in open-sessions.ts:29 stays as it is, and a test
asserts that a board call opens no session. The CLI board, like every CLI
and GUI read, writes no call-log row, which ADR 0052 Claim 2 already scopes
out ("through a local MCP server").

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| The board runs no model and makes no network call | Pure functions in core with no Ollama or fetch import; test runs the board with `fetch` stubbed to throw |
| The board writes nothing to the vault | Both entry points take a reader; test hashes a current-schema vault file before and after a CLI run and an MCP run (opening an older vault can run a schema migration, which is the open path's write, not the board's) |
| The board never returns a whole project document | Output types carry no `content` field; test asserts a planted 16 KB document's body is absent from the payload |
| Every text field is stripped of `Cc`, `Cf`, `U+2028`, `U+2029`, unpaired surrogates and the data-fence markers, and capped before masking | `tameOneLine` plus fence removal on every text field; test plants ANSI escapes, bare CR, `U+2028`, `U+0085`, a bidi override, a lone surrogate and `===END MEMORY DATA===` in a status and a Next Actions line, and asserts none survives in the JSON or the rendered text |
| The MCP response is under 131,072 bytes on the wire for any number of projects and any document size | Absolute row caps and field caps (Decision 3); saturating test with at least 110 projects, CJK and escape-heavy text, Tier-1 off and on, measuring the JSON-RPC response bytes; second test with a 60,000-character document stored through the raw memory path |
| One unreadable document never hides the other projects | Per-project catch of `ProjectHandoffError` (Decision 1, Needs repair); test plants a duplicate-section document through the raw memory path beside healthy projects and asserts it is listed as `unreadable` and every other section still renders |
| An imported project is aged from its newest Log date, not the import time | Decision 1, Stale; test imports a project whose newest Log entry is 40 days old and asserts it is stale at the default window with `last log entry` |
| A connection sees only projects in its grant, in every section | `allowedScopes` on both core reads; open sessions only for granted scopes; test with a narrowed grant and a call-log row about an ungranted project |
| An unreadable call log never shows as "no open sessions", and a missing one shows as none | Strict reader (Decision 1). Over MCP the only unreadable state that reaches the handler is a log the process can append to but not read, since an unappendable log refuses the call in `run()` (Decision 4); the tests use a real write-only (`0200`) log file, never a stubbed reader, and assert `unavailable` with the other sections present on `project_board` and the unreadable note on `project_resume` (shipped in 106fae3). CLI tests also use `chmod 000` and a directory at the log path, since the CLI appends nothing. A test with no log file asserts an empty list |
| A board call is logged and opens no session | Decision 4; test calls `project_board`, asserts one call-log row with `disclosed_scopes`, and asserts `openSessions` is unchanged |
| `project_board` output respects Tier-1 masking | `maskProjectPayload`; seeded-secret test over every text field, and identifiers asserted exact |

## What this deliberately does not build

- No state field, no status enum, no schema change. "Done" is a text
  convention.
- No board writes. The board never marks a project stale in the document,
  never nudges, never auto-wraps (ADR 0052 Decision 2 refuses auto-wrap).
- No scheduled or background run. The board runs when asked.
- No desktop, web or mobile surface in M-D1.
- No ranking, scoring or prioritising. Sorting is by date and slug, which are
  facts, not judgements.
- No model, in any form. That is ADR 0056.

## Residual (documented, accepted)

- **"Done" is a text convention, wrong in both directions.** "Finished the
  migration" is not Done to the board, and "Done." on a project that
  reopened without its status being rewritten is. The rule is narrow on
  purpose (bare word, then end or punctuation) so ordinary sentences that
  begin with "Done with" or "Complete rewrite" stay active. The output
  names the rule.
- **Open sessions are per machine and per MCP path.** The call log is local;
  a session from claude.ai through the connector is invisible to the board.
- **The caps can hide work.** Past 50 rows a section shows the first 50 in
  its sort order and states the total.
- **One stale window for every project** until `--stale-days` is passed.
- **The Log's layout is chosen from its first line**, as import chooses it
  (accepted 2026-09-23, code recheck SR2). A bold-date Log that opens with a
  prose line reads as undated, so the project is aged from its import, and a
  bold-date entry inside a dash Log is ignored. None of the 33 archived
  command-repo projects has either layout.
- **Month names are read only as `Sep 20`**: month first, title case.
  `sep 20`, `SEP 20` and `20 Sep` produce no dated item. Accepted so that
  ordinary words such as "may" and "march" are never dates.
- **"Next Tuesday" and "Q3" are not dates** to the sweep, and a month-name
  date without a year more than six months from `now` resolves to the
  nearer year, which can be the wrong one.
- **Imported projects are aged from their Log.** An imported project whose
  live Log has no readable date is aged from the import, so it cannot go
  stale for `N` days after the import. The recheck, measured before the
  2026-09-23 import fix, found 4 of the 33 command-repo projects in that state (bobby-hood, ledger, wine-cellar,
  wine-purchases-13mo); bobby-hood and ledger had every dated entry moved
  to archives because their documents were over the cap. The live Log is
  also only as good as ADR 0053's import. Since the import fix of
  2026-09-23 (ADR 0053 addendum), a partly dated Log keeps the source's
  sequence turned newest first by the direction its dated entries run, so
  that direction is inferred and undated entries are never placed by date;
  a Log written as headings is stored as dash entries the board reads, one
  per dated heading (undated headings are text of the entry above).
  Projects imported before that fix keep the old shape until deleted and
  imported again.
- **A large document costs time, not payload.** Until ADR 0056's
  prerequisite lands, a document stored past the cap through the raw memory
  path is read in full to find its dates.

## Acceptance (Jay, from the CLI)

Against a throwaway vault, with `NORTHKEEP_HOME` set so nothing touches the
real one. The exact script ships as `scripts/adr-0054-acceptance.sh` with the
build; the steps are:

1. **The board, default.** Import the command-repo projects into the
   throwaway vault (ADR 0053), run `northkeep projects board`: five sections,
   the Done rule stated, no model started.
2. **Size.** `northkeep projects board --json | wc -c`: record the figure;
   it must be under the 131,072-byte ceiling.
3. **Stale window.** `--stale-days 1` lists nearly every imported project
   (their Log dates are older than a day) with `last log entry`;
   `--stale-days 3650` lists none.
4. **Zero writes.** Hash the vault file, run the board twice, hash again:
   identical.
5. **Dated items.** Add `- 2026-10-15 renew the Dartmouth listing` to one
   project's Next Actions and a dated line to another's Open Questions: both
   appear, in date order, with their slugs.
6. **Open sessions.** Read a project from Claude Code and quit without
   writing: the board lists it with one open session. Run the board from the
   MCP tool: no new open session appears.
7. **Drafts.** Create a draft project: it appears under Drafts. Wrap it once:
   it leaves.
8. **Hostile text.** Put an ANSI color escape and a `U+2028` into a Current
   Status: the board's line shows neither and the terminal is not recolored.
9. **Needs repair.** Store a document with two `## Current Status` headings
   into a new project scope with `northkeep remember --scope project:broken
   --type working`: the board lists `broken` as `unreadable` and every other
   section still renders.
10. **Month dates.** Add a Next Actions line of the form `- <Mon> <D> file
    the renewal` naming a date three days before today (for example
    `- Sep 20` when run on 2026-09-23). It appears at the top of Dated items
    with that date's own year, which is last year when run in the first
    three days of January.

## Third draft: the required list, answered

The second pass required, before a third draft:

1. *Enforce the document cap on every project-scope write as a core
   invariant.* Moved to ADR 0056 as its prerequisite 1. D1's payload no
   longer depends on it (Decision 3, "Document size does not reach the
   payload"), and a test proves that with a 60,000-character document.
2. *Chunk on code-point boundaries with a hard cap.* D2 only; ADR 0056
   prerequisite 2. D1 cuts every string with `tameOneLine`, which already
   cuts on code points.
3. *Sanitize every string entering a model context or a report.* D1:
   Decision 3, with a claim and a test. D2's model-input variant: ADR 0056
   prerequisite 3.
4. *Pass `allowedScopes` on every board read.* Decision 2, including open
   sessions; the CLI's owner view is stated as such.
5. *Log board reads as project reads, or amend ADR 0052 Claim 2.* Decision 4
   does both halves that matter: the board is logged as a tool call, and
   Claim 2 is amended to say it is not a project read.
6. *Restate the payload bound in bytes from a saturating fixture.* Decision
   3: 131,072 bytes on the MCP wire, asserted by a saturating test, measured figure recorded at
   build. The fixture includes every flesh wound's case: CJK, JSON-escaped
   characters and control characters (which are now removed before
   serialization rather than escaped).

Flesh wounds 2 (the `refuseProjectWriteUnderTier1` citation) and 3
(surrogate-splitting chunks) belonged to D2's accept and chunking text and
moved with it.

## Adversarial review (2026-09-21, against the design)

Neither half is built, so the attack was against the prose and the cited code.
Verdict: **NOT CLEARED**.

**Findings.**

1. "D1 needs no adversarial review" is wrong on the gate's own wording: D1
   publishes a claims table, and publishing a claim is a gated act.
2. The 8 KB target was asserted, not computed. Open sessions alone, at three per
   project across 31 projects, are about 20 KB.
3. A board that read projects through `project_get` or `project_resume` would
   write the call log rows that ADR 0052 Decision 2 counts as reads, so the
   board would plant the open sessions it reports.
4. D1 was placed in `packages/core` as four pure functions, but open sessions
   need the call log, which core does not read. The placement would have pulled
   a file reader into core.
5. Pass A inherits the ordinary review's size skip: entries over
   `MAX_REVIEW_ENTRY_CHARS`, 12,000 (review.ts:24), are dropped at
   review.ts:200-204 and counted at 234 and 276, while a project document may
   run to 16,384 (project-doc.ts:10). The largest documents would never be read.
6. Accept had no stated behaviour under Tier-1 masking, where the text the user
   read is not the text in the vault.
7. ADR 0050 lets a connected app author project text, which D2 then feeds to a
   model. The threat list named only locally written documents.
8. Six stale citations: `project_list`, `listProjectViews`, `ProjectSummary`,
   the two `ProjectView` section fields, and the Current Status read.

**Binding amendments (applied above).** The Status block and Decision 3 put D1
inside the gate (1). Decision 1 states the caps, the four subtotals and the
computed bound, labelled computed rather than measured, and the claims table and
acceptance moved with it (2). Decision 1 states that the board reads core
directly and never the two tools (3), and that core holds only the pure
functions while the board lives in mcp-server and cli (4). Decision 2 states the
chunking rule (5) and the Tier-1 refusal with its existing message (6). Threats
names the ADR 0050 path with the same verbatim-quote defence (7). Every citation
was re-opened and corrected (8).

**Residual.** Real payload sizes and real model behaviour, unreachable until D1
and D2 exist. The pair-explosion bound stays an open question, as Threats says.

## Adversarial review (2026-09-21, second pass, against the amended design)

Neither half is built, so the attack was again against the prose and the cited
code, with the cap arithmetic run against real fixtures. Verdict: **NOT
CLEARED**.

**Kill shots.** (1) `PROJECT_DOC_MAX_CHARS` is enforced only inside
`applyProjectUpdate` (project-handoff.ts:171) by way of
`assertProjectDocSize` (project-doc.ts:199-203), so `remember --scope
project:x` stores a working document of any size. Executed: a 60,113-character
document that `listProjectViews` (project-handoff.ts:250-252) returns and the
board would read. Every D1 size claim rests on a cap that is not an invariant.
(2) Decision 2's chunking rule leaves a chunk that is still over the limit when
a section has no inner boundary, and `splitReviewPack`
(packages/librarian/src/reviewCluster.ts:130) drops such a member into
`skipped` at 144-147. Pass A's "never skips a document for size" claim fails
on exactly the documents it was written for. (3) `project_board` puts
unsanitized project text into a model context and a report, and nothing in the
ADR specifies a class: ANSI escapes, bare CR, `U+2028` and fence markers all
pass through, which is the class ADR 0052 has just had to close twice.

**Flesh wounds.** (1) The payload bound fails its own saturating test:
42,519 bytes of ASCII against "about 40 KB", 65,959 with CJK text, and 101,119
once control characters are counted. (2) The `refuseProjectWriteUnderTier1`
citation pointed at `assertGrantedScope`; the function is at server.ts:342-349.
(3) Chunking on code-unit boundaries splits a surrogate pair and corrupts the
text either side. (4) Board reads call `listProjectViews` and `getProjectView`
without `allowedScopes`, so they bypass the connection grant that every tool
path asserts. (5) The board is an invisible reader: it reads projects and
writes no call-log row, which erodes ADR 0052 Claim 2 from the other side.

**Required before the next draft.** A third draft must: enforce the document
cap on every write into a project scope as a core invariant, which is a
prerequisite and needs its own small ADR or an addendum to ADR 0039, not a line
here; chunk on code-point boundaries with a hard cap and a stated rule for
text that offers no break; sanitize every string entering a model context or a
report with the same class ADR 0052 now uses (Unicode `Cc` and `Cf`, `U+2028`
and `U+2029`, plus the data-fence markers); pass `allowedScopes` on every board
read; and either log board reads as project reads or amend ADR 0052 Claim 2 to
say the board does not count. The payload bound is restated in bytes from a
saturating fixture, never from cap arithmetic.

**Residual.** Real model behaviour and the pair-explosion bound, unreachable
until D2 exists.

## Adversarial review (2026-09-23, third draft, first review)

Fresh-eyes review against the draft and the cited code, attacks executed
in an isolated worktree with a throwaway home. Verdict: **CLEARED WITH
WOUNDS**. Full verdict and scripts: `Reviews/adr-0054/r3-first-review.md`.

**Held under attack.** `tameOneLine` stripped every hostile class fed to
it; both core reads narrow to the grant; the board path leaves vault bytes
identical; `run()` refuses on an unwritable call log and a board-shaped row
opens no session; a 59,512-character raw document does not reach the
payload; 250 saturated rows came to about 122 KB on the wire.

**Wounds.** (1) `readCallLog` returns `[]` on every error, so `unavailable`
was unreachable, and shipped `project_resume` has the same dead fallback.
(2) `getProjectView` refuses a duplicate-section document that
`listProjectViews` lists as healthy, which would refuse the whole board.
(3) Import stamps `updated_at`, so imported projects could not go stale and
acceptance step 3 failed after step 1. (4) A yearless month date resolved to
the next occurrence, so an overdue item jumped a year ahead. (5) The move to
ADR 0056 dropped D2's no-write claim, its does-not-touch boundary, two
acceptance steps and two non-goals.

**Scar tissue.** The Done rule counted "Done with phase 1" and "Complete
rewrite in progress" as Done.

**Amendments (Jay, 2026-09-23: "fix narrow").** (1) A strict call-log
reader separating missing, readable and unreadable; the same reader fixes
`project_resume`, shipped first. (2) A Needs repair section with
`conflict` and `unreadable`, caught per project. (3) Imported heads are aged
from their newest Log date, via `ProjectSummary.imported`. (4) Yearless
dates resolve to the nearest occurrence. (5) The dropped items restored to
ADR 0056. Scar: the Done rule narrowed to the bare word followed by end or
`.`, `:`, `!`, with both directions recorded as residual. Notes taken: fence
markers removed from board text; the ceiling defined on the MCP wire with a
110-project fixture; the 8 KB figure dropped; masking-after-caps and the
current-schema condition on the zero-write test stated; the sweep runs on
the cut line.

## Recheck (2026-09-23)

All five wounds and the scar closed, with executed evidence (full verdict:
`Reviews/adr-0054/r3-recheck.md`). One new wound, FR1: the claims row
planned MCP tests with a `chmod 000` log and a directory at the log path,
both of which make `run()` refuse before any payload exists, so the tests
would pass vacuously while the one state that reaches the handler, a
write-only log, went unnamed. Fixed in the row, which now names the
write-only case and forbids a stubbed reader; the shipped `project_resume`
fix (106fae3) already tests it that way. Notes taken: fence removal repeats
to a fixed point, the ceiling is stated in bytes with the measured 125,857,
step 10 no longer breaks at month starts, and the import fallback residual
names the four affected projects. Verdict after the text fix: cleared for
build.

## Code review of the build (2026-09-23)

Fresh-eyes review of `106fae3..d09dce2` (`Reviews/adr-0054/md1-code-review.md`):
**CLEARED WITH WOUNDS**. Every claims-table row held under independent
attack. One wound: an imported project with any future-dated Log line never
went stale, because the newest Log date was read from every Log line rather
than each entry's opening date and was not bounded by today. The archived
command repo holds this pattern (a fleetstat deadline, several bobby-hood
dates). One scar: month names only as `Sep 20`, now recorded above and in
KNOWN-LIMITS. Fixes on Jay's "yes" (2026-09-23): per-entry Log dates bounded
by today; the Done rule reads the displayed (cleaned) line, so a leading
zero-width character cannot split rule and display; fence-marker removal is
one linear pass (nested markers had cost one pass per level, 10 s on a
336,000-character document). One recheck follows.

Recheck of the fix round (`Reviews/adr-0054/md1-code-recheck.md`):
**CLEARED**. FW1 closed on core, MCP and both CLI forms; the zero-width
Done case and the slow fence case closed (10,171 ms to 183 ms). One scar
introduced by the fix, SR2, accepted by Jay on 2026-09-23 ("1 accepted"): the Log's shape is
chosen from its first non-empty line, as import chooses it, so a bold-date
Log that opens with a prose line reads as undated (aged from the import)
and a bold-date entry inside a dash Log is ignored. None of the 33 archived
command-repo projects has either shape (checked read-only, 2026-09-23).
Wording drift fixed: the Done rule text and Decision 3's fence sentence.

