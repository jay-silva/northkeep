# ADR 0051: Compact project history, and an 8 MB sync cap

- **Date:** 2026-09-21
- **Status:** Accepted by Jay ("Do option 1 and raise the cap to 8 MB",
  2026-09-21). Implemented the same day.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0045 (log
  rolling), ADR 0048 (handoff receipts)
- **Does not touch:** the connector, redaction, crypto or key handling,
  the row envelope, what leaves the machine. This is a retention change
  inside the vault plus a server cap. No adversarial review is required
  under the CLAUDE.md gate; it is stated here so nobody wonders.

## Context

On 2026-09-21 the vault on Jay's Mac was 4.37 MB against the sync
server's 4 MB blob cap, so whole-vault sync stopped and the app said so.
A read-only count showed where the bytes were:

| Rows | Count | Content bytes |
|---|---|---|
| Live memories | 906 | 583,247 |
| Superseded project documents (`working` in `project:*`) | 297 | 2,728,681 |
| Other superseded rows | 31 | 15,647 |
| Forgotten rows | 59 | 0 |

Every `project_update` keeps the full prior document as a superseded row
(ADR 0039 Decision 1). A busy project's document is 13 KB, and it is
updated several times a day by agents, so history grows by tens of
kilobytes a day per active project and never shrinks. KNOWN-LIMITS
already named this. The live content is a tenth of the file.

## Decision 1: Compact project history by blanking old superseded revisions

A new vault operation, `compactProjectHistory`, runs per project scope
or across every project scope:

1. Consider only rows in slug-valid `project:*` scopes with
   `type = 'working'`, `superseded_at` set, and `forgotten_at` null.
   Live documents, Log archives, episodic notes, non-project scopes and
   already-forgotten rows are never candidates.
2. Order the candidates newest first by `created_at`. Keep the newest
   `keep` of them (default 5). Also keep any candidate whose id appears
   as `base_revision` or `result_id` in a project-handoff receipt
   (ADR 0048 metadata) on any row in the scope, so receipt replay and
   lineage checks keep working.
3. Blank the rest exactly the way `forget` does: `content = ''`,
   `metadata = NULL`, `forgotten_at` stamped. The row stays; the hash
   chain is untouched, because `verifyChain` already treats a forgotten
   row as blanked by design. Export stays complete and canonical: the
   blanked revisions appear as forgotten rows, as any forgotten memory
   does.
4. `VACUUM` before the save so the serialised image shrinks. A save
   without it would keep the freed pages inside the file.

The result reports rows blanked, content bytes freed, and the vault file
size after the save.

What is lost: the text of project revisions older than the newest five.
The live document, its Log archives (separate episodic rows), and the
newest five revisions remain, which is what "recoverable in history" has
meant in practice. Compaction is not automatic; the user runs it.

## Decision 2: Surfaces

- CLI: `northkeep projects compact [--project <slug>] [--keep <n>]`
  prints what would be blanked (per project: candidates, kept, to blank,
  bytes) and does nothing unless `--yes` is given.
- Desktop API: `POST /api/projects/compact` with `{project?, keep?,
  dry_run?}` behind the existing session gate, returning the same
  numbers. The Projects page button that calls it ships after Jay
  approves a mock (RULES: design before build); until then the CLI is
  the surface.
- Mobile: none. The phone receives the compacted vault through sync.

## Decision 3: The sync cap becomes 8 MB

`MAX_BLOB_BYTES` in the sync server goes from 4 MB to 8 MB, and every
place that quotes the number to the user (desktop status, mobile, CLI,
KNOWN-LIMITS) follows. This is a bridge, not the fix: at the observed
growth rate it buys months, and compaction is what keeps the file small.
The Vercel request body limit and Neon row size were checked to allow
8 MB before this was chosen.

## Acceptance (Jay)

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && node packages/cli/dist/index.js projects compact
```

Expect a per-project table and no change. Then with `--yes`: expect
roughly 290 rows blanked and about 2.5 MB freed, the vault file well under
4 MB, `northkeep verify` (chain) clean, and the desktop Status card back
to "in sync" after the automatic push. `project_get northkeep` with
`history: true` still returns the Log archives.

## Consequences

- Old project revisions beyond the newest five are gone once compacted.
  The user chooses when.
- The vault file tracks live content plus a bounded history instead of
  growing without limit.
- Handoff receipts keep their referenced revisions, so replay stays exact.
