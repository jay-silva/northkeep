# ADR 0051: Compact project history; the sync cap stays at 4 MB

- **Date:** 2026-09-21
- **Status:** Accepted by Jay ("Do option 1 and raise the cap to 8 MB",
  then "make it automatic", 2026-09-21). Option 1 and automatic
  compaction implemented the same day; the cap raise was found impossible
  on the current transport (Decision 3) and is not done.
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
meant in practice. Decision 4 makes it automatic; the command remains.

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

## Decision 3: The sync cap stays at 4 MB, because the platform caps it at 4.5 MB

Jay asked for 8 MB. Before changing the constant, the deployed sync
server was probed read-only with a throwaway token: a 3 MB body reached
our code (our own 404 for an unknown path), a 5 MB body was refused by
Vercel with `FUNCTION_PAYLOAD_TOO_LARGE` before our handler ran. Vercel
functions cap request bodies at 4.5 MB. That is where ADR 0009's "~4 MB"
came from, and why it named Vercel Blob as the scale path.

So an 8 MB `MAX_BLOB_BYTES` would be a false claim: a vault between
4.5 MB and 8 MB would pass our check and fail one layer earlier with a
platform error the app cannot explain. The constant stays at 4 MB, with
about half a megabyte of headroom under the platform limit for headers
and framing. Raising the real ceiling needs a different transport
(client uploads to Vercel Blob, or chunked uploads reassembled
server-side). That adds a networked path and a dependency, so it needs
its own ADR and an adversarial review, and it is not part of this
decision. Compaction is what keeps the vault under the cap.

## Decision 4: Compaction is automatic (Jay, "make it automatic", 2026-09-21)

Manual compaction would have left every other user's vault growing the
way Jay's did until it hit the cap. So the rule runs at the moment
history is created. Whenever a `working` row in a slug-valid project
scope is superseded, by the local project tools, a `memory_edit`, or a
hosted update arriving through the fold, the vault compacts that one
project immediately: keep the newest five revisions plus any a handoff
receipt names, blank the rest, and `VACUUM` only when something was
blanked. History is therefore bounded at all times, per project, on
every device that writes.

Why this shape and not a threshold: a size trigger fires at an
unpredictable moment and still lets history pile up; a setting first is
not a fix. Five is the same number the manual command keeps, so an
automatic run never removes anything a manual run would have kept. The
manual command stays for vaults that already carry history and for a
different keep count. Existing vaults compact on their next project
write.

The automatic path does not verify the chain on every write (the manual
command still checks before and after); the chain is unaffected because
blanking uses the forget tombstone, which the chain already tolerates.
`lastAutoCompaction()` lets a surface report what a write blanked; no
surface shows it yet.

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

  **Correction 2026-09-24 (release 0.22.0 doc-vs-code pass):** "The user
  chooses when" predates Decision 4 and is no longer true. Compaction runs
  automatically whenever a project document is superseded: `writeProject`
  calls `autoCompactScope` (packages/core/src/vault.ts:898) and so does the
  generic supersede path used by `editMemory` and the connector fold
  (packages/core/src/vault.ts:1458, packages/sync/src/connector-client.ts:344),
  always with the default keep of five (packages/core/src/vault.ts:165). The
  user chooses only when to run the manual command, for example with a
  different `--keep`.
- The vault file tracks live content plus a bounded history instead of
  growing without limit.
- Handoff receipts keep their referenced revisions, so replay stays exact.

## Addendum (2026-09-21, ADR 0052): compacted revisions keep their writer block

Decision 1 step 3 said a blanked revision is tombstoned exactly as `forget`
does, `metadata = NULL` included. ADR 0052 then put the writer of a project
write in that same metadata, under `northkeep_provenance_v1`, so compaction
was deleting the provenance of every revision beyond the newest five: the one
record ADR 0052 publishes was the first thing history lost.

From now on a blanked revision keeps only that block. Content is still
emptied, the forget tombstone is still stamped, and every other key, the
ADR 0048 handoff receipt included, is still removed. A revision written with
no writer still ends with `metadata` null. This holds on both paths, the
manual `northkeep projects compact` and the automatic per-supersession
compaction of Decision 4, because they share one blanking step. The reported
`bytes_freed` still counts content bytes only.

`verifyChain` never re-hashed a forgotten row, so a surviving block does not
break the chain. It now also checks the shape of what a forgotten row carries:
`metadata` must be null, or an object whose single key is
`northkeep_provenance_v1` holding a block a reader accepts. Any other
surviving key, and any malformed block, fails verification.

The limit of that check, stated plainly: once a revision is blanked its
content is gone, so its entry hash cannot be recomputed, and swapping one
well-formed host or session id for another well-formed one on a blanked row is
not detectable. Tamper evidence through the hash chain covers the writer block
for as long as the revision keeps its text. After compaction the surviving
block is structurally checked, not hash-verified.
