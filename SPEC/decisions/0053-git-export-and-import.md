# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Sixth draft, pending first review. Five reviews, five NOT CLEARED (two 2026-09-21, three
  2026-09-22). After the fifth, Jay approved a design change on 2026-09-22 (a bounded journal set, the index
  lock as a precondition, a status that is never silent), applied below. Nothing is built.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0045 (log rolling), ADR 0048 (revision-bound
  handoffs), ADR 0051 (compaction), ADR 0052 (provenance, draft projects)
- **Does not touch:** egress, redaction tiers, crypto or key handling, the row envelope, sync, the
  connector, the vault schema. No model runs in any path here. No new runtime dependency: git is an external
  program the user already installed, spawned, never linked. Said plainly, because the hardening below can
  read as more than it is: git is a program, NorthKeep runs it, code does run, and the invariant-7 argument
  is "no new networked dependency".

## Context

A project document lives as one `working` memory per `project:<slug>` scope. Jay's working record before
NorthKeep was a git repository of Markdown files, still what he reads outside an agent session, and the two
do not meet: the vault is the truth and the repository is stale. The vault already holds everything the
repository held. `getProjectView` (packages/core/src/project-handoff.ts:219-233) returns the parsed document
with its prior revisions and Log archives, and `listProjectViews` (project-handoff.ts:254-257) returns one
summary row per project, sorted by slug (line 256). That is the index. Missing: a renderer, and a way to
bring an existing folder in.

The vault stays canonical, so a mirror editable back into it would be a second source of truth, and this ADR
refuses to build one. NorthKeep has written no memory plaintext outside the encrypted vault, as the call log
header says (packages/mcp-server/src/log.ts:5-9); export amends that sentence in one narrow place.

Three new files are proposed. `packages/core/src/project-export.ts` holds the pure parts:
`renderProjectFile`, `renderLogFile`, `renderIndexFile` and `parseExportHeader`.
`packages/mcp-server/src/git-plumbing.ts` holds the git runner: `runGit`, `plumbingCommit`, `readRemotes`
and `requireCommitIdentity`. `packages/mcp-server/src/project-export-run.ts` holds everything that needs
both: `exportProjects`, `classifyTarget`, `readJournal`, `writeJournal`, `readExportState`,
`writeExportState`, `exportStatus`, `acquireExportLock` and `importProjects`. Decision 2's evidence is
`scripts/adr-0053-canary.sh`.

## Decision 1: What is rendered, and where (project-export.ts)

A user-chosen repository path holds `projects/<slug>.md` (the live document as the vault stores it,
unmodified apart from the Decision 3 header), `projects/<slug>.log.md` for a project with Log archives, and
`INDEX.md`, one row per project from `listProjectViews`.

The INDEX row is slug, state (`draft` or `active`), one-line status, updated date, last writer host, all
five already on `ProjectSummary` (project-handoff.ts:77), so this ADR adds no field. Every cell escapes `|`
as `\|` and collapses newlines to spaces, so an agent-written status line holding a pipe cannot forge a
column. `ProjectSummary.status` is the whole Current Status body (project-handoff.ts:256), so the renderer
takes `firstNonEmptyLine` (packages/core/src/project-doc.ts:153-159) and cuts to 120 characters.

The same vault state renders byte-identical files. No generation timestamp anywhere. Every date printed
comes from a stored `created_at`, rendered `YYYY-MM-DD` in UTC. Section order is the document's own, because
the body is the stored `content` verbatim, and row order is the slug order line 256 already fixes. Line
endings are `\n`, and the renderer appends the trailing newline `serializeProjectDoc`
(project-doc.ts:137-146) does not return. `<slug>.log.md` is rendered from the archive memories, which
`getProjectView` returns only under `history: true` (project-handoff.ts:228), so the exporter asks for
history. Newest archive first, newest entry first inside each; the inner reversal is deliberate, because
`formatLogArchive` writes entries oldest first (project-doc.ts:267-274). The renderer splits an archive body
with `splitLogEntries` (project-doc.ts:210-225).

A conflicted project (two live heads) renders slug, `conflict`, `two live documents, not exported`, and
empty cells. Its `<slug>.md` is neither written nor removed, and the result names it.

## Decision 2: Plumbing writes (git-plumbing.ts)

NorthKeep writes every mirror file itself with `atomicWrite` (packages/mcp-server/src/fs-safe.ts:31-49),
which resolves an existing file's realpath and writes through it (lines 35-36). It chmods a new mirror file
`0o644` rather than the helper's `0o600` default (line 33), because a mirror lives in a repository the user
may share. NorthKeep's own files under `<NORTHKEEP_HOME>/export` keep `0o600`.

**The repository key.** `<key>` below is the SHA-256 of the UTF-8 bytes of the repository realpath, as 64
lowercase hex characters, never truncated. The temporary index, the journal and the state file are all named
by it, under `<NORTHKEEP_HOME>/export/`, a directory created `0o700`.

Git never touches the working tree. Per file, NorthKeep renders the bytes in memory, hashes them, journals
the blob id, and only then writes the file. All through `execFile` with an args array, in this order:

```
git worktree list --porcelain                   # refuse if HEAD's branch is checked out elsewhere
git read-tree HEAD                              # into a TEMPORARY index, see below
git hash-object --no-filters -- <abs path>      # classifyTarget's diskBlob (Decision 3)
git hash-object -w --no-filters --stdin         # the rendered bytes; journaled, then the file is written
git hash-object --no-filters -- <abs path>      # must equal the journaled blob, or the target is refused
git update-index --add --cacheinfo 100644,<blob>,projects/<slug>.md
git write-tree ; git rev-parse HEAD
git commit-tree <tree> -p <parent>              # message on stdin
git update-ref -m "northkeep export" HEAD <commit> <parent>   # old value always passed
```

`--no-filters` is what stops a clean filter; an owned empty `core.hooksPath` is what stops every hook. Those
are two mechanisms, not one: plumbing alone would still fire `reference-transaction` on `update-ref` and
`post-index-change` on `update-index`. `update-ref` always carries the old value, so a concurrent commit
loses the race rather than being overwritten; the fourth review found the no-old-value form succeeded
against a non-empty HEAD, so it is used only when HEAD was unborn.

The verb allowlist is exactly `rev-parse`, `read-tree`, `hash-object`, `update-index`, `write-tree`,
`commit-tree`, `update-ref`, `ls-tree`, `worktree` (only `worktree list --porcelain`), `var` and `remote`
(only `remote -v`). `diff` and `diff-index` were removed by the third review: `diff` has no `--no-filters`
and runs the repository's clean filter and textconv over the plaintext. No `add`, `commit`, `status`,
`checkout`, `push`, `pull`, `fetch`, `clone`, `init`, `merge` or `tag` is constructed anywhere in the code.
Every invocation runs with this environment and nothing else:

```
PATH=/usr/bin:/bin   HOME=<NORTHKEEP_HOME>
GIT_CONFIG_NOSYSTEM=1   GIT_CONFIG_GLOBAL=<NORTHKEEP_HOME>/empty.gitconfig  (owned, zero bytes)
GIT_ATTR_NOSYSTEM=1  GIT_TERMINAL_PROMPT=0  GIT_OPTIONAL_LOCKS=0
GIT_ASKPASS=/usr/bin/false   SSH_ASKPASS=/usr/bin/false
GIT_INDEX_FILE=<NORTHKEEP_HOME>/export/<key>.index   (omitted only for the reconcile, below)
```

and these `-c` pins, which outrank repository config:

```
-c core.hooksPath=<NORTHKEEP_HOME>/hooks   (owned, empty directory)
-c core.fsmonitor=false  -c core.useBuiltinFSMonitor=false
-c gpg.program=/usr/bin/false  -c commit.gpgsign=false  -c tag.gpgsign=false
-c core.sshCommand=/usr/bin/false  -c credential.helper=  -c diff.external=
-c core.editor=/usr/bin/false  -c sequence.editor=/usr/bin/false  -c core.pager=cat
-c core.askPass=/usr/bin/false  -c core.gitProxy=  -c core.alternateRefsCommand=
-c core.autocrlf=false  -c core.safecrlf=false  -c core.symlinks=false
-c protocol.ext.allow=never  -c uploadpack.packObjectsHook=  -c user.useConfigOnly=true
```

`GIT_AUTHOR_*` and `GIT_COMMITTER_*` are not set, so the identity is the repository's own (Decision 7). `-C
<realpath of the repo>`, resolved with `fs.realpathSync` before the first call, and the resolved path is
what every check and every invocation uses. Per invocation: a 10 second timeout, a bounded `maxBuffer`, and
never while the vault file lock is held. Git 2.31 or newer is required, for `rev-parse
--path-format=absolute` (Decisions 2 and 8).

**Repository preflight,** before anything is written, each refusing the whole run:

1. The path is not a work tree: `rev-parse --show-toplevel` must succeed and equal the resolved path.
   NorthKeep never runs `git init`.
2. The repository is bare (`rev-parse --is-bare-repository`).
3. The path is inside `northkeepHome()` (packages/core/src/platform.ts:7-9) or the vault file's directory,
   by prefix on a separator boundary, or the path is a NorthKeep checkout.
4. `worktree list --porcelain` shows HEAD's branch checked out in another worktree, which the fourth review
   used to move that worktree's branch and leave a file staged there. A linked worktree of the repository
   being exported is allowed and normal.
5. **`<git-dir>/index.lock` exists.** The git dir comes from `rev-parse --path-format=absolute --git-dir`.
   In a linked worktree that is `.git/worktrees/<name>`, which differs from the common dir Decision 8 uses,
   and it is where that worktree's own index and lock live. The refusal names the file: "`<path>` exists.
   Another git process is running, or one crashed. NorthKeep will not export while it exists; remove it once
   no git process is running." NorthKeep never removes it.

**The lock is checked twice,** in preflight and immediately before `update-ref`. If it appeared between,
the run stops there as a failed run: HEAD does not move and the files on disk are journaled residue.

**Per-target containment,** checked per file immediately before that file is written. A failure refuses that
one target and the run continues:

1. `lstat` every path component from the repository root down, `projects` then `projects/<name>`. A symlink
   anywhere refuses the target, because `atomicWrite` resolves and writes through one by design
   (fs-safe.ts:35-36).
2. The target exists and is not a regular file, or has `st_nlink` greater than 1. The fourth review wrote
   through a hard link, changing a file outside `projects/`.
3. `ls-tree HEAD -- projects` reports mode 160000, or a `.git` entry exists under `projects`. The fourth
   review wrote vault plaintext inside a submodule whose remotes Decision 4 never read.
4. `realpath(dirname(target))` must start with `realpath(repo)` plus a separator.

A containment refusal is fixed text naming the failed check and the fix, for example "projects/ is a
symlink; NorthKeep exports only into a real directory inside the repository". It never mentions `--adopt`,
which runs after containment and cannot pass it, and it makes the run a failed run (Decision 10).

**The temporary index, the root commit, and the user's staged work.** `GIT_INDEX_FILE` points at a
NorthKeep-owned index seeded by `read-tree HEAD`, never the repository's own, so the commit carries HEAD's
tree plus the exported files and whatever the user had staged is not in it. When HEAD is unborn, which
`rev-parse --verify HEAD` reports by failing, the index is seeded with `read-tree --empty`, `commit-tree`
runs with no parent and `update-ref HEAD <commit>` with no old value; the canary script runs this path.

**The reconcile.** After `update-ref`, the exporter brings the repository's own index in line with one
`update-index --add --cacheinfo 100644,<blob>,<path>` per exported path, run without `GIT_INDEX_FILE` so git
picks the index. A linked worktree has its own, at `.git/worktrees/<name>/index`, which is why the reconcile
names no index file by path; the canary script runs it there. The reconcile runs on every run that passes
preflight, including one that stops before `commit-tree` because nothing changed, so an index an earlier
run could not refresh is refreshed by the next.

**When the reconcile fails.** Only a lock that appears after the second check can make it fail: then
`update-index` exits 128 after `update-ref` has landed. Nothing is rolled back, because HEAD, the files and
the commit agree. The run reports "committed; working index not refreshed" for those paths and names the
lock. While the lock persists, preflight refuses every later run. Once it is gone, the next run refreshes
the index, and a `git checkout .` made over the stale index meanwhile restores an earlier export, which
Decision 3's journal set recognizes. The reconcile expands a sparse index to a full one, a residual.

There is no checkout step, so a smudge filter has nothing to run on: the working tree files are the ones
NorthKeep wrote. A second export of an unchanged vault makes `write-tree` return HEAD's own tree id and the
exporter stops before `commit-tree`, with no second commit.

## Decision 3: Ownership by header and journal set (project-export-run.ts, `classifyTarget`)

Every generated file opens with one HTML comment, nothing before it:

```
<!-- northkeep: vault <vault_id> project <slug> revision <revision_id> kind document
     The vault is canonical. This file is regenerated. Edits here are not read back. -->
```

`kind` is `document`, `log` or `index`, and `INDEX.md` names the vault id and `kind index` with no slug;
both come from `ProjectView` (project-handoff.ts:232). The revision id is informational, for a human reading
the file, and never an ownership test. The fourth review killed the test it used to be: a vault that
advances between a crash and the next run, a vault restored from backup, and ADR 0051 blanking a revision
each made an owned file unrecognizable forever.

**The journal** is `<NORTHKEEP_HOME>/export/<key>.json`. Per exported path it holds the last ten blob ids
NorthKeep wrote there, newest first:

```json
{ "version": 1, "repo": "<resolved realpath>", "vault_id": "<uuid>",
  "paths": { "projects/demo.md": ["<blob id, newest>", "...", "<oldest of at most 10>"],
             "INDEX.md": ["<blob id>"] } }
```

After `hash-object -w --stdin` returns a blob id and before the file is written, the exporter updates that
path's list: a blob already present moves to the front, a new one is prepended, and the list is cut to ten.
So repeated unchanged runs never evict history. The journal is written with `atomicWrite` at `0o600`. A file
that fails to parse, carries another version, or names another realpath or vault reads as empty, and
`--status` says so. Entries for a path NorthKeep removes, such as a log part no longer needed, are kept, so
the part restored from git is still recognized.

The journal is not the record: git and the vault are. It is a hint about what NorthKeep has put on disk.
Deleting it only means residue that HEAD does not hold reads as a hand edit until `--adopt`. It holds no
strike count and no stopped state; those live in Decision 10's state file, so deleting the journal clears
neither.

**The rule.** `classifyTarget(target, { diskBlob, headBlob, journalBlobs, vaultId, slug })` takes the git
results as inputs, because "absent from HEAD" is a git answer no pure renderer can know. `diskBlob` is `git
hash-object --no-filters -- <file>`, `headBlob` is `git rev-parse HEAD:projects/<name>` or null when it
exits non-zero, and `journalBlobs` is that path's list, possibly empty. A target is **ours** when both hold:

- its header parses and names this vault id and, for `kind document` and `kind log`, this slug (`INDEX.md`
  needs the vault id alone);
- `diskBlob` equals `headBlob` or equals any blob in `journalBlobs`.

Anything else there is a **hand edit**: refused by name with the `--adopt` command, reported, and the run
continues. A missing file is neither, and is written. The rule reads no index state.

**What it recognizes, without `--adopt`.** Crash residue between the file write and `update-ref` (the blob
was journaled first). A `git checkout .` over an index a failed reconcile left stale (that index holds an
earlier export's blob). A `git reset --hard` to an older export (the disk matches the new HEAD). A copy of an
old mirror restored over `projects/`, or `git checkout <old> -- projects/x.md`, within the last ten writes of
that path. A stale mirror from another device, which matches `headBlob`. Each self-heals on the next run.

**The bound.** Preflight refuses while a lock exists, so the index lags HEAD by at most one export and its
blob is among the newest two in the journal. Eleven runs under a persistent lock are eleven refusals that
never touch the journal.

**One accepted edge.** A hand-typed file byte-identical to a former render is overwritten. That costs
nothing: the bytes are NorthKeep's own content, header included.

**`--adopt`** is one rule, and it exists only on the CLI: back up anything `classifyTarget` does not call
ours with `backupOnce` (fs-safe.ts:17-22), which copies the file to `<name>.northkeep-bak` and only when no
backup exists, then overwrite. It does not bypass containment. The automatic trigger never adopts
(Decision 10).

**No filter runs during any of this.** `hash-object --no-filters`, `rev-parse HEAD:<path>` and `ls-tree`
consult no attributes (the canary script). `rev-parse HEAD:<path>` returns the link-text blob for a symlink,
a tree id for a directory, a commit id for a gitlink, and exits 128 for an absent path (`headBlob` null);
containment refuses the first three before this runs.

## Decision 4: Remotes (git-plumbing.ts, `readRemotes`)

On first configure the exporter prints the repository's remote list, names and URLs from `git remote -v`,
with the resolved path and the project counts, and stores that list in `export.json` after the user
confirms. On every export it re-reads `git remote -v`; a remote added, removed or re-pointed since the
confirmation refuses the **whole** export until the user re-confirms. The fourth review confirmed `remote
-v` shows `pushurl`, `includeIf` and `insteadOf` rewrites. NorthKeep never adds, removes, renames or pushes
a remote.

## Decision 5: Round trip (project-export.ts, import side)

`<slug>.log.md` carries `kind log` and `INDEX.md` carries `kind index`, so NorthKeep's own export can be
imported back. Import reads the header first: `kind index` is skipped because it is derived, `kind log`
reattaches its entries as ADR 0045 archives of the named slug through the Decision 9 path and creates no
project, `kind document` is an ordinary import, and no header at all is the pre-NorthKeep case.

The header is never written into the vault. Import strips it from the parsed `preamble`
(project-doc.ts:101-126 keeps text before the first heading as preamble), and strips only that comment, so
an ADR 0052 draft line in the same preamble (`PROJECT_DRAFT_LINE_PREFIX`, project-doc.ts:280-284) survives.
A file that merely copies a NorthKeep header is harmless, because import refuses an existing slug anyway.

## Decision 6: Caps in bytes (project-export.ts)

`PROJECT_DOC_MAX_CHARS` is 16,384 UTF-16 code units (project-doc.ts:10), at most 49,152 UTF-8 bytes; the
header is at most 257 bytes (two 36-character uuids, a 40-character slug). The cap is enforced only on write
paths (`assertProjectDocSize`, project-doc.ts:199-203, called from project-handoff.ts:190), so a document
that arrived through sync can be larger. The renderer exports `projects/<slug>.md` whatever its size and
reports one over 65,536 bytes, because refusing would hide the project most in need of reading.

`projects/<slug>.log.md` has no such bound, because a project can hold many archive rows, so it is **split
into numbered parts** with a target of 65,536 bytes each, `<slug>.log.1.md`, `<slug>.log.2.md` and so on,
each carrying its own `kind log` header. The target is a readability choice. Splits happen only on archive
boundaries, so no archive is ever cut, and a single archive larger than the target becomes its own part,
which may exceed the target by at most one archive. That is reachable: the ADR 0045 row cap lets one archive
row reach 64 KiB, which no 65,536-byte part can hold once a header is added. Refusing the project instead
was rejected because `northkeep projects export` must be both idempotent and total. Parts number from 1 with
no zero padding. A part no longer needed is unlinked from disk and dropped with `update-index --force-remove`
in the temporary index and again in the reconcile, so HEAD, the index and the files on disk still agree.
Only a part `classifyTarget` calls ours is ever removed, so a foreign file of that name survives. Nothing
else is built: no read-back, no remote or push, no watcher, and no desktop surface in M-A.

## Decision 7: Identity and commit messages (git-plumbing.ts)

Before anything is written, `requireCommitIdentity` runs `git var GIT_COMMITTER_IDENT` under the Decision 2
environment, which includes `-c user.useConfigOnly=true`. Without that pin git invents a name and email from
the username and hostname; with it, a repository carrying no identity exits 128 with "Committer identity
unknown". NorthKeep refuses that export before writing and names the two `git config` commands that fix it.
NorthKeep never sets `user.name` or `user.email` and never passes `GIT_AUTHOR_*` or `GIT_COMMITTER_*`.
Because `GIT_CONFIG_GLOBAL` points at an empty file, a repository that relied on `~/.gitconfig` must set its
own.

The commit subject is `wrap: <slug> (<host>, model not exposed) - <first line of completed>`, with
`checkpoint:`, `update:` and `create:` as the analogues, and `export: <n> projects (<host>)` for a full run.
`<host>` is `ProjectProvenance.host` from the head's ADR 0052 provenance block (project-handoff.ts:45, read
into `ProjectView.last_writer`, line 74), or `(unknown host)`. `model not exposed` is fixed text, because
ADR 0052 Decision 1 stores `model: null`. The message reaches git on `commit-tree`'s stdin, never as an
argument and never through a shell, for the reason packages/mcp-server/src/connect.ts:235-236 states about
`execFileSync`.

## Decision 8: Concurrency (project-export-run.ts, `acquireExportLock`)

One lock file per repository at `<common dir>/northkeep-export.lock`, the common dir from `git rev-parse
--path-format=absolute --git-common-dir`; the plain form returns a relative `.git` from the main worktree,
which would have put the lock under the process working directory. Every process on that repository, and
every linked worktree of it, contends for one file. It is created `O_EXCL` with this process's pid and start
time, which elected exactly one of eight racers on APFS. It is stale only when the pid is not alive or the
file is older than one hour. The `finally` block removes the lock only when the file still holds this
process's pid. A second export waits up to 30 seconds, then reports that one is already running. This lock
is NorthKeep's own and is not git's `index.lock`, which Decision 2 only ever reads.

## Decision 9: Import safety (project-export-run.ts, `importProjects`)

`northkeep projects import --from <dir> [--write]`. `--dry-run` is the default: without `--write` the
command prints the plan, per file its slug, section map, live document size, archive count and overflow yes
or no, and writes nothing. The source directory is opened read-only and import spawns no git process. `*.md`
in `<dir>`, non-recursive; a name whose stem fails `PROJECT_SLUG_PATTERN` (project-doc.ts:15) is skipped and
listed, and NorthKeep's own `<slug>.log.md` is recognized by its header first (Decision 5). Per importable
file:

1. Parse with `parseProjectDoc` (project-doc.ts:101-126) and strip the header.
2. Map sections: the five known headings (project-doc.ts:25-31) to themselves, `Open Questions / Risks` to
   the `Open Questions` section ADR 0048 owns (`ProjectView.open_questions`, project-handoff.ts:65), and
   `Blueprint` and `Links & Locations` verbatim, as `parseProjectDoc` and `serializeProjectDoc` already
   round-trip any extra heading (project-doc.ts:137-146).
3. Write through the revision-bound create path with `expected_revision: null`, which refuses when a live
   head exists (ADR 0050). An existing slug is refused by name, the run continues, and import never merges.
4. Log entries go in **oldest first** as ADR 0045 archive memories, written directly rather than by
   replaying `project_update`, which would stamp every entry with today's date (`datedBullet`,
   project-doc.ts:334-339). One new core formatter, `formatImportedLogArchive(project, entries,
   sourceFile)`, emits the same `## Log archive: <slug>` first line as `formatLogArchive` (project-doc.ts:20
   and 267-274), because `getProjectView` finds archives by that prefix (project-handoff.ts:226). The newest
   `PROJECT_LOG_KEEP_ENTRIES` (10, project-doc.ts:18) stay live and the rest are archived.
5. Anything that still does not fit `PROJECT_DOC_MAX_CHARS` (16,384, project-doc.ts:10) becomes one
   `episodic` memory in the project scope headed `## Import overflow: <slug>`, naming the source file and
   which headings moved. Nothing is dropped and every overflow is reported.

## Decision 10: Trigger, scope, and a stopped state that is never silent (project-export-run.ts)

The writer mirrors its own write after the vault save succeeds and after the vault lock is released: the MCP
server after `project_wrap`, `project_checkpoint`, `project_update` and `project_create`, and the CLI after
`northkeep projects update`, a new subcommand proposed here (`projects` today has only `compact`,
packages/cli/src/index.ts:881-893). `northkeep projects export` is the idempotent full re-render. A failure
of the export never fails the vault write: it is caught and reported.

**The automatic path never adopts.** `--adopt` exists only on the CLI, where a human typed it. When an
automatic export refuses a hand edit, the tool payload names it and prints `northkeep projects export --repo
<path> --adopt`. A containment refusal prints its own fix instead (Decision 2).

**A failed run** is any run that ends in a whole-run refusal (a preflight check, the index lock, a changed
remote list, a missing identity, a path that no longer resolves), in at least one per-target refusal (a hand
edit or a containment check), in "committed; working index not refreshed", or in an error. Any other run is
a success.

**The state file** is `<NORTHKEEP_HOME>/export/<key>.state.json`, beside the journal and separate from it:

```json
{ "version": 1, "repo": "<resolved realpath>", "consecutive_failures": 0, "stopped_since": null,
  "last_error": null, "last_success": { "at": "<ISO 8601>", "commit": "<commit id>" },
  "refused": [ { "path": "projects/x.md", "reason": "hand edit" } ] }
```

It is written with `atomicWrite` at `0o600` after every run. A failed automatic run increments the count;
any successful run resets it, clears `stopped_since` and empties `refused`. After three consecutive failed
automatic runs the trigger stops. Deleting the journal clears neither the count nor the stopped state.

**Stopped is never silent.** While stopped, every vault write that would have exported skips the export and
carries an `export` object in its tool payload: `{ "state": "stopped", "repo", "stopped_since",
"last_error", "run": "northkeep projects export --repo <path>" }`. Every string in it is NorthKeep's fixed
text, an ISO time, or the path NorthKeep resolved; no git stderr and no file content reaches a tool payload.
The CLI prints the same. A failed run short of three carries it with `"state": "failing"` and the refusals.

**`northkeep projects export --status`** prints, without exporting: the configured repository, the last
successful export time and commit, the failure count, `stopped since <time>` or `active`, the refused paths
with reasons, and whether the journal was readable. Only a successful hand run resumes a stopped trigger.

Export runs only when a repository is configured, in a new sidecar `<NORTHKEEP_HOME>/export.json` beside
`sync.json` (packages/sync/src/config.ts:42-44) and `connector.json`
(packages/sync/src/connector-config.ts:31-33). It holds the resolved path, the Decision 4 remote list and
the confirmation, and no secret. An absent file means the feature is off, which is the default, and there is
no default path.

## Decision 11: Privacy (stated, not enforced by code)

Unshared projects are exported, because they are the majority and a mirror that omitted them would be worse
than no mirror. The file is as private as the folder the user chose. Nothing leaves the machine: no network
call exists in either path, and a remote the user later pushes to is the user's own action. Invariant #1 is
unchanged, because it bounds what leaves the machine. Invariant #7 is unchanged: git is a program the user
installed, and what Decision 2 buys is that the repository cannot choose which code it runs.

The "no plaintext on disk outside the vault" property is amended, for project scopes only, opt-in, at a path
the user chose. The sentence lives in the call log header (packages/mcp-server/src/log.ts:5-9), the call log
itself stays content-free, and KNOWN-LIMITS.md carries the amended sentence and the residuals before this
ships. The journal and state file hold blob ids, paths and times, never content. Tier-1 return masking
(ADR 0048) does not apply here: masking a mirror of the user's own vault to the user's own disk would write
corrupted text the user would read as real.

## Twelve-month post-mortems

**The vault is restored from backup.** The header test is vault id and slug and the blob test is HEAD plus
the journal set, so every file is still ours and the next export writes the restored content. Git history
holds what the mirror said before.

**The repository is moved.** `export.json` names a path that no longer resolves. After three failed writes
the trigger stops and every later write carries the status naming the old path. Reconfiguring re-asks the
Decision 4 confirmation; the journal and state file keyed by the old realpath are never read again.

**A second Mac, or the repository in a cloud-synced folder.** The lock is per machine, so two machines
exporting one synced folder can interleave commits, and the plaintext sits in a folder something else copies
off the machine. Neither is detected. The supported shape is one machine per repository path.

**History is rewritten, for example with `git filter-repo`.** If the mirror bytes are untouched the blob ids
do not change and nothing notices. If `projects/` is rewritten or dropped, affected files class as hand edits
until `--adopt`, which backs each up. NorthKeep cannot tell a deliberate rewrite from damage.

**The user edits `INDEX.md` by hand, or a crashed editor leaves `index.lock`.** Each run refuses, by path or
in preflight, naming the fix. After three the trigger stops and every write says so, until the user reverts
the edit or removes the lock and runs `northkeep projects export` (with `--adopt` for the edit).

## Threats

Each is a finding from one of the five reviews, with its mitigation and its residual.

**A repository that names a program:** a `.gitattributes` filter, hooks, `gpg.program`, `core.sshCommand`,
`core.fsmonitor`, `post-index-change` and `reference-transaction` under plumbing, and `~/.gitconfig` when
only `GIT_CONFIG_NOSYSTEM=1` is set. Mitigated by the Decision 2 allowlist, `--no-filters`, an owned empty
`core.hooksPath`, the pins and an owned empty `GIT_CONFIG_GLOBAL`, checked by the canary script against five
attribute sources, 17 program keys, 21 driver keys, 24 hooks in each of two hook directories, an included
config file and a worktree config. Residual: the pins are a list, and a future git could add a key.

**Bytes written outside the confirmed repository** through a symlink, a hard link, a submodule or nested
repository, or a non-regular target. Mitigated by per-target containment. Residual: a component swapped
between the `lstat` and the write is a race NorthKeep does not close.

**A hand edit destroyed, or a mirror wedged so only a human can clear it.** Mitigated by Decision 3's blob
comparison against HEAD and a ten-blob journal set, and by refusing any run while `index.lock` exists.
Residual: an edit the user committed is overwritten by the next export, by design, and is in git history.

**Two writers, or a branch checked out elsewhere.** Mitigated by the Decision 8 lock and the preflight
`worktree list --porcelain` check. Residual: two machines sharing one folder, stated as unsupported.

**A mirror that rots unnoticed.** Mitigated by Decision 10: every write while stopped carries the status,
and `--status` reports it on demand.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| Two exports of an unchanged vault produce byte-identical files and one commit | `renderProjectFile` / `renderIndexFile`: no timestamp, dates from stored `created_at`, slug order from project-handoff.ts:256; `exportProjects` stops when `write-tree` returns HEAD's tree |
| No program named by repository, global or system config runs, including on the ownership check | `runGit`: the env and `-c` list in Decision 2, with `--no-filters` and an owned empty `core.hooksPath`; `scripts/adr-0053-canary.sh` in Acceptance step 2 |
| NorthKeep never creates a remote and never pushes | `runGit` rejects any verb outside the Decision 2 allowlist; a recording shim asserts the verbs seen across every trigger are a subset of it |
| A file NorthKeep cannot prove it wrote is never overwritten without `--adopt`, and never without a backup | `classifyTarget`: header vault and slug, plus `diskBlob` equal to `headBlob` or a blob in the path's journal set; `backupOnce` on the one `--adopt` path, which the automatic trigger cannot reach |
| One fault never wedges the mirror | journal written before the file; preflight refuses on `index.lock`; tests replay the crash window, a lock appearing before the reconcile then `checkout .`, `reset --hard` to an older export, and a restored old mirror, and assert the next run heals with no refusal |
| The user's staged work is never committed by an export | `plumbingCommit` seeds a temporary `GIT_INDEX_FILE` from `read-tree HEAD`; test stages an unrelated file and asserts it is absent from the commit and still staged after |
| No byte is written outside the repository whose remotes were confirmed | preflight plus per-target containment: component `lstat`, regular file, `st_nlink` 1, no gitlink or nested `.git`, and `realpath(dirname)` under `realpath(repo)`; one test per refusal and its message |
| An export refuses while HEAD's branch is checked out in another worktree, or while `index.lock` exists | `worktree list --porcelain` in preflight; the lock checked in preflight and before `update-ref`; tests assert no commit and no file written |
| A stopped mirror is never silent | the state file; every tool payload after three failures carries `export.state: "stopped"`; test makes four writes and asserts the fourth payload |
| Export sends nothing off the machine and runs no model | No network or model call in either path; a test stubs network syscalls to throw and acceptance runs with Ollama stopped |
| No export header ever reaches the vault | `importProjects` strips it from the preamble; test round-trips an export and asserts no stored content contains `<!-- northkeep:` |

## Residual (documented, accepted)

- **The journal can be lost.** Residue that HEAD never recorded then classes as a hand edit and needs
  `--adopt`, which backs the file up first. The strike count survives in the state file.
- **A restore older than ten writes.** `git checkout <old> -- projects/x.md`, or a copied mirror, more than
  ten writes of that path back, classes as a hand edit. `reset --hard` never does, because HEAD moves with it.
- **Archives beyond 20 are not mirrored.** `getProjectView` slices archives at
  `PROJECT_REVISION_SUMMARY_LIMIT` (20, project-handoff.ts:24 and 228), so a project with more loses its
  oldest from the log files. They stay in the vault.
- **The mirror is stale between writes from other devices**, and readable by anything that can read the
  folder: Spotlight, Time Machine, a cloud folder sync, or a remote.
- **A conflicted project is never exported**, and its last good `<slug>.md` stays on disk, older than its
  header says. The INDEX row says `conflict`.
- **The reconcile writes the repository's index**, which expands a sparse index to a full one.
- **Case-insensitive filesystems.** Slugs differing only in case would collide on APFS; the slug pattern is
  lowercase (project-doc.ts:15), so this is unreachable today.
- **Commit identity is git's,** and git 2.31 or newer is required.

## Acceptance (Jay, from the CLI)

Throwaway vault and repository, `NORTHKEEP_HOME` set on every command. Step 6 copies the command repo.

```bash
export NORTHKEEP_HOME=$(mktemp -d); LAB=$(mktemp -d); R=$LAB/mirror
export NK=~/Claude/Projects/NorthKeep/northkeep/packages/cli/dist/index.js
mkdir -p $R && git -C $R init -q   # unborn HEAD on purpose, see step 1
git -C $R config user.email you@example.com; git -C $R config user.name Jay
node $NK init && node $NK projects export --repo $R   # prints path, remotes, counts; asks once
```

1. **A root commit, then a byte-identical double export.** `cp -R $R/projects $LAB/a`, export again: `diff
   -r $LAB/a $R/projects` is silent, `git -C $R log --oneline | wc -l` is 1, `git -C $R status --short` empty.
2. **Nothing the repo names ever runs.** From the NorthKeep repository, `bash scripts/adr-0053-canary.sh`
   prints `(none)` under "canaries fired", `equal` on every blob line, `result: PASS`, and exits 0.
3. **A hand edit is refused, and faults heal.** `echo "note" >> $R/projects/demo.md`, export: refused with the
   `--adopt` command, edit intact, others exported. `git -C $R checkout -- projects/demo.md`, export:
   overwritten silently. Delete `$NORTHKEEP_HOME/export/<key>.json` and repeat: HEAD's blob alone heals it,
   and `--status` still shows the failure count.
4. **Crash residue.** Kill the exporter after the file write and before `update-ref`
   (`NORTHKEEP_EXPORT_CRASH=1`), write to the vault twice more, export: nothing is refused.
5. **History moves.** Three vault writes, `git -C $R reset --hard HEAD~2`, export: no refusal. Copy `$LAB/a`
   over `$R/projects`, export: recognized through the journal set, no refusal.
6. **A copy of the command repo, imported then adopted.** `cp -R ~/Claude/Projects/Command\ Repo $LAB/cr`,
   work only there. The import dry run prints a 31-row plan, writes nothing, and leaves `git -C $LAB/cr
   status --short` empty. Re-run with `--write`, export with `--adopt`: every overwritten file has a
   `.northkeep-bak` beside it.
7. **Containment.** A symlinked `projects/x.md`, a symlinked `projects/`, a hard-linked `projects/demo.md`, a
   `projects` submodule in a second copy, a directory named `projects/demo.md`: each refused with its fixed
   message and no `--adopt` hint, the others export, nothing is written outside `$R`.
8. **A remote added after the confirmation.** `git -C $R remote add mirror $LAB/bare.git`, export: the whole
   run refuses until re-confirmed; then `git -C $R log --oneline` shows the new commit and nothing is pushed.
9. **Refusals, each writing nothing:** a path inside `$NORTHKEEP_HOME`, a non-work-tree, a bare repository,
   `user.email` unset, a concurrent export, and HEAD's branch checked out elsewhere (`git -C $R worktree add
   --force $LAB/w2 $(git -C $R branch --show-current)`).
10. **The index lock.** Stage an edit to `$R/README.md`, run a `projects update`: `git -C $R show --stat HEAD`
    omits it and it stays staged. `touch $R/.git/index.lock`, `projects update`: refused before any write,
    naming the file. Remove it. With `NORTHKEEP_EXPORT_LOCK_BEFORE_RECONCILE=1` (creates the lock after
    `update-ref`), `projects update` reports "committed; working index not refreshed", and one more write is
    refused. Remove the lock, `git -C $R checkout .`, export: no refusal, status shows only README.md.
11. **A linked worktree.** `git -C $R worktree add $LAB/wt -b wtb`, export there with a `projects update`: the
    commit lands, `git -C $LAB/wt status --short` is clean, the lock is at `$R/.git/northkeep-export.lock`,
    and `touch $R/.git/worktrees/wt/index.lock` refuses the next run.
12. **The automatic path never adopts, stops, and says so.** A headerless `$R/projects/stranger.md` and three
    vault writes: each payload names it with the `--adopt` command. The fourth and fifth carry
    `export.state: "stopped"`. `--status` prints the repo, last success time and commit, 3 failures,
    `stopped since`, and `stranger.md: hand edit`. A hand `export --adopt` resumes the trigger, `--status`
    shows 0 and `active`, and `stranger.md.northkeep-bak` exists.
13. **Zero model tokens.** Stop Ollama and repeat steps 1 and 6.

**Canary output while this draft was written,** run twice on git 2.54.0 (Apple Git-157), APFS, as
`TMPDIR=<scratch> bash scripts/adr-0053-canary.sh`. Both exited 0 and `diff` found the two outputs
identical; each deleted its temp directory. The first:

```
git: git version 2.54.0 (Apple Git-157)
hostile: 24 hooks in each of .git/hooks and core.hooksPath, 17 program keys, 21 driver keys, 5 attribute sources
main repository:
  git-dir=repo/.git common-dir=repo/.git
  projects/s1.md disk=b6aac8346241 head=b6aac8346241 sha1=b6aac8346241 equal
  projects/s2.md disk=a5c4c6bde061 head=a5c4c6bde061 sha1=a5c4c6bde061 equal
  projects/s3.md disk=5fa4ec4f9aa7 head=5fa4ec4f9aa7 sha1=5fa4ec4f9aa7 equal
  projects/s4.md disk=a62414760618 head=a62414760618 sha1=a62414760618 equal
  INDEX.md disk=bd63d675a1ae head=bd63d675a1ae sha1=bd63d675a1ae equal
linked worktree:
  git-dir=repo/.git/worktrees/wt common-dir=repo/.git
  projects/s3.md disk=6bbd5892472b head=6bbd5892472b sha1=6bbd5892472b equal
fresh repository:
  git-dir=root/.git common-dir=root/.git
  unborn HEAD: root-commit path
  projects/root.md disk=c64e1f69d9f7 head=c64e1f69d9f7 sha1=c64e1f69d9f7 equal
canaries fired:
  (none)
controls (must fire):
  filter.a1.clean filter.a2.clean filter.a3.clean filter.a4.clean filter.a5.clean hook:core.hooksPath/reference-transaction
result: PASS
```

The five attribute sources: (1) a root `.gitattributes` committed in HEAD, (2) an untracked
`projects/.gitattributes`, (3) `.git/info/attributes`, (4) `core.attributesFile`, and (5) a global
`~/.config/git/attributes` in a stand-in home, since the pinned `HOME` is what keeps the real one out. The
`sha1` column is `shasum` over `blob <size>\0<bytes>`, independent of git, so nothing was converted. Three
caveats. Mutations show the script can fail: without the `core.hooksPath` pin it reports
`reference-transaction` and `post-index-change`; without `--no-filters` on the ownership check it reports
`filter.a1.clean`, `filter.a2.clean` and `filter.nkp.process`. Git 2.54 does not apply sources 3 and 4 to an
absolute path at all, so their controls use a relative path; `--no-filters` is the mechanism, not that
quirk. And the transport keys (`credential.helper`, `core.sshCommand`, `ssh.variant`, `core.gitProxy`,
`protocol.ext`, `uploadpack.packObjectsHook`) are unreachable anyway, since no allowed verb opens a transport.

## Adversarial review (2026-09-22, recheck of the fifth draft)

Executed on git 2.54.0 (Apple Git-157), APFS. Verdict: **NOT CLEARED**. The lab repositories it cited were
deleted with the reviewer's scratchpad; `scripts/adr-0053-canary.sh` replaces them as the standing evidence.

**What closed.** The crash window with a vault advance; a journal naming a garbage-collected blob; a branch
staged in another worktree; containment against a symlinked target, a directory, a hard link and a
`projects` gitlink; the fourth review's five flesh wounds; `worktree list --porcelain` under the pinned
environment, nothing fired; and a journal from another vault, refused by the vault-id test.

**What did not close.**

- **Kill shot, carried from the fourth review.** A stale `.git/index.lock` persisted across two landed
  exports whose reconciles failed. After clearing it, `git checkout .` restored a blob matching neither HEAD
  nor the one-blob journal: a hand edit forever. "The next run heals it" was false. Closed by preflight item
  5 and the second lock check (the index lags at most one export) and Decision 3's ten-blob journal set.
- **Flesh wound.** A containment refusal printed the `--adopt` command, which cannot pass containment, and
  whether an all-refused run counted as a strike was undefined. Closed by Decision 2's fixed refusal messages
  and Decision 10's definition of a failed run.
- **Flesh wound.** After three failures the trigger said so once, with no status verb. Closed by Decision
  10's state file, the per-write `export` payload and `--status`.
- **Notes.** "Only a class 1 part" survived in Decision 6; it now reads "a part `classifyTarget` calls
  ours". The journal doubled as the strike counter; the count now lives in the state file. The repository
  hash was unspecified; it is SHA-256, 64 hex characters.

**Found while writing this draft.** The fifth draft hashed each file after writing it, so a crash between
the write and the journal left unrecognized residue; the blob now comes from `hash-object -w --stdin` and is
journaled first. A no-change run skipped the reconcile, so a stale index stayed stale; it now always runs.

## Earlier reviews

**Fourth draft (2026-09-22), NOT CLEARED,** on git 2.54.0 (Apple Git-157), APFS, macOS 26.6. What held: the
allowlisted verbs under the pinned environment fired no canary against nineteen config keys, nine hooks plus
`core.hooksPath` and five attribute sources; blob ids equalled an independent SHA-1; `commit-tree` did not
sign under a canary `gpg.program`; the unborn-HEAD path worked; `O_EXCL` elected one of eight racers; and
`owned()` (project-handoff.ts:131-133) returning the empty string for a missing section means Decision 9's
heading map cannot break `getProjectView`. Kill shots: a single fault (the crash window with a vault
advance, a stale `index.lock` leaving `MM`, another worktree's staged change) wedged the mirror, and a
`projects/` submodule took plaintext into another repository. Flesh wounds: a false `index.lock` sentence,
an unguarded `update-ref`, a wrong reason for a linked worktree's index, an ownership signature that could
not see git results, and a lock that was stale on an OR, removed by the wrong process, and placed by a
relative `--git-common-dir`. Scar tissue: a hard-link write, sparse-index expansion, the header size, the 64
KiB row cap, post-mortems.

**Third draft (2026-09-22), NOT CLEARED.** `git diff --quiet HEAD` as the cleanliness check handed the
plaintext to the clean filter and textconv, and hung on a process-filter canary; an owned-looking file
absent from HEAD read clean. Also: no root-commit path, wrong UTF-16 arithmetic, and `--adopt` promised but
not granted. `remote -v` showing `pushurl`, `includeIf` and `insteadOf`, and the identity pins, held.

**First and second drafts (2026-09-21), both NOT CLEARED.** Eight stale citations, hooks treated as the only
program a repository names, `~/.gitconfig` in play, `git status --porcelain` as an ownership test that would
have overwritten 31 hand-written files, a `.gitattributes` filter running on `add`, `--adopt` keeping no
backup, and an export that did not round trip. The third draft answered with plumbing writes, `backupOnce`,
remote re-checks, round-tripping headers, and stripping the header on import.
