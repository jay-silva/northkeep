# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Fourth draft, pending adversarial review. Three reviews, three NOT CLEARED verdicts: two on
  2026-09-21 against the first and second drafts, one on 2026-09-22 against the third. That review is
  recorded below and its amendments, approved by Jay on 2026-09-22, are applied in the Decisions themselves.
  Nothing is built.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0045 (log rolling), ADR 0048 (revision-bound
  handoffs), ADR 0051 (compaction), ADR 0052 (provenance, draft projects)
- **Does not touch:** egress, redaction tiers, crypto or key handling, the row envelope, sync, the
  connector, the vault schema. No model runs in any path here. No new runtime dependency: git is an external
  program the user already installed, spawned, never linked. Said plainly, because the hardening below can
  read as more than it is: git is a program, NorthKeep runs it, and code does run. The invariant-7 argument
  is "no new networked dependency", not "no code runs".

## Context

A project document lives as one `working` memory per `project:<slug>` scope. Jay's working record before
NorthKeep was a git repository of Markdown files, still what he reads outside an agent session, and the two
do not meet: the vault is the truth and the repository is stale. The vault already holds everything the
repository held. `getProjectView` (packages/core/src/project-handoff.ts:219-233) returns the parsed document
with its prior revisions and Log archives, and `listProjectViews` (project-handoff.ts:254-257) returns one
summary row per project, sorted by slug (line 256). That is the index. Missing: a renderer, and a way to
bring an existing folder in.

The vault stays canonical, so a mirror editable back into it would be a second source of truth and a merge
problem, and this ADR refuses to build one. NorthKeep has written no memory plaintext outside the encrypted
vault, as the call log header says (packages/mcp-server/src/log.ts:5-9); export amends that sentence
deliberately, in one narrow place.

Three new files are proposed: `packages/core/src/project-export.ts` for the pure renderers,
`packages/mcp-server/src/git-plumbing.ts` for the git runner (`runGit`, `plumbingCommit`, `readRemotes`,
`requireCommitIdentity`), and `packages/mcp-server/src/project-export-run.ts` for the orchestration
(`exportProjects`, `acquireExportLock`, `importProjects`).

## Decision 1: What is rendered, and where (project-export.ts)

A user-chosen repository path holds `projects/<slug>.md` (the live document as the vault stores it,
unmodified apart from the Decision 3 header), `projects/<slug>.log.md` for a project with Log archives, and
`INDEX.md`, one row per project from `listProjectViews`.

The INDEX row is slug, state (`draft` or `active`), one-line status, updated date, last writer host.
`ProjectSummary` (project-handoff.ts:77) carries all five, `last_writer_host` and `draft` having landed with
ADR 0052, so this ADR adds no field. Every cell escapes `|` as `\|` and collapses newlines to spaces, so an
agent-written status line holding a pipe cannot forge a column. `ProjectSummary.status` is the whole Current
Status body (project-handoff.ts:256), so the renderer takes `firstNonEmptyLine`
(packages/core/src/project-doc.ts:153-159) and cuts to 120 characters with an ellipsis.

The same vault state renders byte-identical files. No generation timestamp anywhere. Every date printed
comes from a stored `created_at`, rendered `YYYY-MM-DD` in UTC. Section order is the document's own, because
the body is the stored `content` verbatim, and row order is the slug order line 256 already fixes. Line
endings are `\n`, and the renderer appends the trailing newline `serializeProjectDoc`
(project-doc.ts:137-146) does not return. `<slug>.log.md` is rendered from the archive memories, which
`getProjectView` returns only under `history: true` (project-handoff.ts:228), so the exporter asks for
history. Newest archive first, newest entry first inside each; the inner reversal is deliberate, because
`formatLogArchive` writes entries oldest first (project-doc.ts:267-274). The renderer splits an archive body
with `splitLogEntries` (project-doc.ts:210-225).

A conflicted project (`conflict: true`, two live heads) renders slug, `conflict`, the fixed text `two live
documents, not exported`, and empty cells; its `<slug>.md` is neither written nor removed, and the result
names it.

## Decision 2: Plumbing writes (git-plumbing.ts)

NorthKeep writes every file itself with `atomicWrite` (packages/mcp-server/src/fs-safe.ts:31-49), which
resolves an existing file's realpath and writes through it (lines 35-36) so no reader sees half a file. A
new mirror is chmodded `0o644` rather than the helper's `0o600` default (line 33), because a mirror lives in
a repository the user may share.

Git never touches the working tree. The bytes on disk are recorded with plumbing, in this order, all through
`execFile` with an args array:

```
git read-tree HEAD                              # into a TEMPORARY index, see below
git hash-object -w --no-filters -- <abs path>   # per file
git update-index --add --cacheinfo 100644,<blob>,projects/<slug>.md
git write-tree ; git rev-parse HEAD
git commit-tree <tree> -p <parent>              # message on stdin
git update-ref -m "northkeep export" HEAD <commit> <parent>
```

`--no-filters` is what stops a clean filter; an owned empty `core.hooksPath` is what stops every hook. Those
are two mechanisms, not one: plumbing alone would still fire `reference-transaction` on `update-ref` and
`post-index-change` on `update-index`.

The verb allowlist is exactly `rev-parse`, `read-tree`, `hash-object`, `update-index`, `write-tree`,
`commit-tree`, `update-ref`, `ls-tree`, `var` and `remote`. `diff` and `diff-index` were removed by the
third review: `diff` has no `--no-filters` and runs the repository's clean filter and textconv over the
plaintext. No `add`, `commit`, `status`, `checkout`, `push`, `pull`, `fetch`, `clone`, `init`, `merge` or
`tag` is constructed anywhere in the code, and `remote` is only ever `remote -v` (Decision 4). Every
invocation runs with this environment and nothing else:

```
PATH=/usr/bin:/bin   HOME=<NORTHKEEP_HOME>
GIT_CONFIG_NOSYSTEM=1   GIT_CONFIG_GLOBAL=<NORTHKEEP_HOME>/empty.gitconfig  (owned, zero bytes)
GIT_ATTR_NOSYSTEM=1  GIT_TERMINAL_PROMPT=0  GIT_OPTIONAL_LOCKS=0
GIT_ASKPASS=/usr/bin/false   SSH_ASKPASS=/usr/bin/false
GIT_INDEX_FILE=<NORTHKEEP_HOME>/export/<hash of repo path>.index
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
never while the vault file lock is held.

Refusals before anything is written: the path is not a work tree (`rev-parse --show-toplevel` must succeed
and equal the resolved path, and NorthKeep never runs `git init`); the repository is bare (`rev-parse
--is-bare-repository` is true); the path is inside `northkeepHome()` (packages/core/src/platform.ts:7-9) or
the vault file's directory, by prefix on a separator boundary; the path is a NorthKeep checkout, detected by
a `packages/core/package.json` naming `@northkeep/core`; or `projects/` or any target is a symlink, by
`lstat`, because `atomicWrite` would write through it by design. A linked worktree is allowed. Its `.git` is
a file and it has no `.git/index` of its own, which is why nothing below ever writes an index file by path.

**The temporary index, the root commit, and the user's staged work.** `GIT_INDEX_FILE` points at a
NorthKeep-owned index seeded by `read-tree HEAD`, never at the repository's own index, so the commit carries
HEAD's tree plus the exported files and whatever the user had staged is not in it. When HEAD is unborn,
which `rev-parse --verify HEAD` reports by failing, the temporary index is seeded with `read-tree --empty`,
`commit-tree` runs with no parent, and `update-ref HEAD <commit>` with no old value; executed against a
fresh `git init`. After `update-ref` the exporter reconciles the repository's own index with one
`update-index --add --cacheinfo 100644,<blob>,<path>` per exported path, run without `GIT_INDEX_FILE` so it
lands on the default index. It never writes or renames an index file by path, which is what makes it correct
in a linked worktree and safe around `.git/index.lock`, since `update-index` takes that lock itself.
Executed: the user's staged change survives, is absent from the export commit, and every exported path
agrees with HEAD. Decision 3's refusals are what make touching the index safe: no path is written or staged
unless it is provably NorthKeep's and already identical to HEAD.

There is no checkout step, so a smudge filter has nothing to run on: the working tree files are the ones
NorthKeep wrote. After each export, HEAD, the index and the files on disk agree for every exported path. A
second export of an unchanged vault makes `write-tree` return HEAD's own tree id and the exporter stops
before `commit-tree`; verified, no second commit.

## Decision 3: Ownership by header, cleanliness by blob (project-export.ts)

Every generated file opens with one HTML comment, nothing before it:

```
<!-- northkeep: vault <vault_id> project <slug> revision <revision_id> kind document
     The vault is canonical. This file is regenerated. Edits here are not read back. -->
```

`kind` is `document`, `log` or `index`. A `kind log` header names the same vault id and slug and the
project's current revision id at render time, so it classes exactly like the document. `INDEX.md` is derived
from every project, so its header names the vault id and `kind index` with no slug and no revision, and
`ownershipOf` classes it by vault id alone. `vault_id` and `revision` come from `ProjectView`
(project-handoff.ts:232, the head row's id). `ownershipOf(file, view)` returns one of four classes.

1. **Ours.** The header parses, the vault id matches, the slug matches, and the revision id is this
   project's current `revision` or one of the ids in `ProjectView.revisions` (project-handoff.ts:229).
   Overwrite, subject to the cleanliness check below.
2. **Unknown.** The header parses but names another vault, or a revision in neither place, which includes a
   revision ADR 0051 blanked. Refused and reported: NorthKeep cannot prove it wrote it.
3. **No header.** Not NorthKeep's. Refused and reported.
4. **Unrecorded.** The file is on disk but absent from HEAD, so git has no record of it whatever its header
   says. This is reachable: a crash between `commit-tree` and `update-ref`, or a first export that failed
   after writing, leaves exactly this. It is overwritten only when its bytes equal a fresh render of the
   current revision, which proves it is NorthKeep's own residue. Otherwise it is refused and reported.

`--adopt` is one rule and covers classes 2, 3 and 4: back up anything not provably NorthKeep's with
`backupOnce` (fs-safe.ts:17-22), which copies the file to `<name>.northkeep-bak` and only when no backup
exists, then overwrite.

**Cleanliness, without running a filter.** The third review's kill shot: `git diff --quiet HEAD -- <file>`
runs the clean filter and textconv over the plaintext, has no `--no-filters`, and `GIT_ATTR_NOSYSTEM` does
not reach an in-repo `.gitattributes`; a filter canary hung it. So no `diff` verb exists here. Before
overwriting a class 1 file the exporter compares blob ids, `git hash-object --no-filters -- <file>` against
`git rev-parse HEAD:projects/<name>`, neither of which consults attributes. Equal means the file on disk is
exactly what HEAD records and it is overwritten; not equal means a hand edit the user has not committed, and
that one file is refused by name while the rest proceeds. Executed against the hostile repository: both
commands fired no canary and agreed on the blob id, while `diff --quiet HEAD` hung on the filter handshake.

A class 1 file whose blob matches HEAD but whose bytes differ from a fresh render of the current revision is
simply stale, the normal case after another device wrote, and it is overwritten. A hand edit the user
committed is overwritten by the next export, by design, and git history is the recovery, which is true here
because every previous state was committed by NorthKeep in the same run that wrote it. Nothing uncommitted
is ever overwritten, in the tracked case by the blob check and in the untracked case by class 4.

## Decision 4: Remotes (git-plumbing.ts, `readRemotes`)

On first configure the exporter prints the repository's remote list, names and URLs from `git remote -v`,
with the resolved path and the project counts, and stores that list in `export.json` under `NORTHKEEP_HOME`
after the user confirms. On every export it re-reads `git remote -v` and compares; a remote added, removed
or re-pointed since the confirmation refuses the **whole** export until the user re-confirms. NorthKeep
never adds, removes, renames or pushes a remote, and no code path constructs `push`, `fetch`, `pull` or
`remote add`.

## Decision 5: Round trip (project-export.ts, import side)

`<slug>.log.md` carries `kind log` and `INDEX.md` carries `kind index`, so NorthKeep's own export can be
imported back. Import reads the header first: `kind index` is skipped silently because it is derived, `kind
log` reattaches its entries as ADR 0045 archive memories of the named slug through the Decision 9 archive
path and creates no project, `kind document` is an ordinary import of that slug, and no header at all is the
pre-NorthKeep case.

The header is never written into the vault. Import strips it from the parsed `preamble`
(project-doc.ts:101-126 keeps text before the first heading as preamble), and strips only that comment, so
an ADR 0052 draft line in the same preamble (`PROJECT_DRAFT_LINE_PREFIX`, project-doc.ts:280-284) survives.
A file that merely copies a NorthKeep header is harmless, because import refuses an existing slug anyway.

## Decision 6: Caps in bytes (project-export.ts)

Two numbers, stated plainly, because the third review found the arithmetic wrong. `PROJECT_DOC_MAX_CHARS` is
16,384 (project-doc.ts:10) and JavaScript counts UTF-16 code units, so the largest legal document is 3 x
16,384 = 49,152 UTF-8 bytes; plus a header of about 234 bytes, `projects/<slug>.md` is always well under 64
KiB and needs no file cap. A document that somehow renders larger is refused by name.

`projects/<slug>.log.md` has no such bound, because a project can hold many archive rows, so it is **split
into numbered parts** with a target of 65,536 bytes each, `<slug>.log.1.md`, `<slug>.log.2.md` and so on,
each carrying its own `kind log` header. The target is a readability choice, not a rule inherited from
anywhere. Splits happen only on archive boundaries, so no archive is ever cut, and a single archive larger
than the target becomes its own part, which may therefore exceed the target by at most one archive. That is
reachable: the ADR 0045 row cap lets one archive row reach 64 KiB, which no 65,536-byte part budget can hold
once a header is added. Refusing the project instead was rejected because `northkeep projects export` must
be both idempotent and total. Parts number from 1 with no zero padding. A part no longer needed is unlinked
from disk and dropped from the tree with `update-index --force-remove`, so HEAD, the index and the files on
disk still agree, and only a class 1 part is ever removed, so a foreign file of that name survives. Nothing
else is built: no read-back, no remote or push, no watcher, and no desktop surface in M-A.

## Decision 7: Identity and commit messages (git-plumbing.ts)

Before anything is written, `requireCommitIdentity` runs `git var GIT_COMMITTER_IDENT` under the Decision 2
environment, which includes `-c user.useConfigOnly=true`. Verified: without that pin git invents a name and
email from the username and hostname; with it, a repository carrying no identity exits 128 with "Committer
identity unknown". NorthKeep refuses that export before writing and names the two `git config` commands that
fix it. NorthKeep never sets `user.name` or `user.email` and never passes `GIT_AUTHOR_*` or
`GIT_COMMITTER_*`. Because `GIT_CONFIG_GLOBAL` points at an empty file, a repository that relied on
`~/.gitconfig` must set its own.

The commit subject is `wrap: <slug> (<host>, model not exposed) - <first line of completed>`, with
`checkpoint:`, `update:` and `create:` as the analogues, and `export: <n> projects (<host>)` for a full run.
`<host>` is `ProjectProvenance.host` from the head's ADR 0052 provenance block (project-handoff.ts:45, read
into `ProjectView.last_writer`, line 74); a write with no block says `(unknown host)`. `model not exposed`
is fixed text, because ADR 0052 Decision 1 stores `model: null` and no host exposes one. The message reaches
git on `commit-tree`'s stdin, never as an argument and never through a shell, for the reason
packages/mcp-server/src/connect.ts:235-236 states about `execFileSync`.

## Decision 8: Concurrency (project-export-run.ts, `acquireExportLock`)

One lock file per repository at `<git rev-parse --git-common-dir>/northkeep-export.lock`, so two processes
with different `NORTHKEEP_HOME` values, and every linked worktree of the same repository, contend for the
same file; the third review found the previous location under `NORTHKEEP_HOME` excluded neither. It is
created `O_EXCL` with the pid and a start time, removed in a `finally`, and stale after 10 minutes or when
its pid is not alive. A second export waits up to 30 seconds, then reports that one is already running and
does nothing. A lock NorthKeep did not create is never removed, and this is not the vault lock.

## Decision 9: Import safety (project-export-run.ts, `importProjects`)

`northkeep projects import --from <dir> [--write]`. `--dry-run` is the default: without `--write` the
command prints the plan, per file its slug, section map, live document size, archive count and overflow yes
or no, and writes nothing. The source directory is opened read-only, nothing in it is written, renamed or
removed, and import spawns no git process. `*.md` in `<dir>`, non-recursive. A name whose stem fails
`PROJECT_SLUG_PATTERN` (project-doc.ts:15) is skipped and listed, which is how `INDEX.md` are handled;
NorthKeep's own `<slug>.log.md` is recognized by its header first (Decision 5) and never reaches this test.
Per importable file:

1. Parse with `parseProjectDoc` (project-doc.ts:101-126) and strip the header.
2. Map sections: the five known headings (project-doc.ts:25-31) to themselves, `Open Questions / Risks` to
   the `Open Questions` section ADR 0048 owns (`ProjectView.open_questions`, project-handoff.ts:65), and
   `Blueprint` and `Links & Locations` verbatim, as `parseProjectDoc` and `serializeProjectDoc` already
   round-trip any extra heading (project-doc.ts:137-146).
3. Write through the revision-bound create path with `expected_revision: null`, which refuses when a live
   head exists (ADR 0050). An existing slug is refused by name, the run continues, and import never merges.
4. Log entries go in **oldest first** as ADR 0045 archive memories, written directly rather than by
   replaying `project_update`, which would stamp every entry with today's date (`datedBullet`,
   project-doc.ts:334-339). This needs one new core formatter, `formatImportedLogArchive(project, entries,
   sourceFile)`, emitting the same `## Log archive: <slug>` first line as `formatLogArchive`
   (project-doc.ts:20 and 267-274), because `getProjectView` finds archives by that prefix
   (project-handoff.ts:226) and `isProjectLogArchive` (project-doc.ts:321-323) tests it. The newest
   `PROJECT_LOG_KEEP_ENTRIES` (10, project-doc.ts:18) stay live and the rest are archived.
5. Anything that still does not fit `PROJECT_DOC_MAX_CHARS` (16,384, project-doc.ts:10) becomes one
   `episodic` memory in the project scope headed `## Import overflow: <slug>`, naming the source file and
   which headings moved. Nothing is dropped and every overflow is reported.

## Decision 10: Trigger and scope (project-export-run.ts)

The writer mirrors its own write after the vault save succeeds and after the vault lock is released: the MCP
server after `project_wrap`, `project_checkpoint`, `project_update` and `project_create`, and the CLI after
`northkeep projects update`, a new subcommand proposed here (`projects` today has only `compact`,
packages/cli/src/index.ts:881-893). A failure of the export never fails the vault write: it is caught and
reported as a field in the tool payload and on the CLI. `northkeep projects export` is the idempotent full
re-render.

Export runs only when a repository is configured, in a new sidecar `<NORTHKEEP_HOME>/export.json` beside
`sync.json` (packages/sync/src/config.ts:42-44) and `connector.json`
(packages/sync/src/connector-config.ts:31-33). It holds the resolved path, the Decision 4 remote list and
the confirmation, and no secret. An absent file means the feature is off, which is the default, and there is
no default path.

## Decision 11: Privacy (stated, not enforced by code)

Unshared projects are exported, because they are the majority and a mirror that omitted them would be worse
than no mirror. The file is as private as the folder the user chose. Nothing leaves the machine: no network
call exists in either path, and a remote the user later pushes to is the user's own action through the
user's own git. Invariant #1 is unchanged, because it bounds what leaves the machine and export writes a
local file.

The "no plaintext on disk outside the vault" property is amended, for project scopes only, opt-in, at a path
the user chose. The sentence lives in the call log header (packages/mcp-server/src/log.ts:5-9). The accurate
statement after M-A is: NorthKeep writes memory plaintext outside the encrypted vault in exactly one place,
project documents mirrored to a git repository the user configured by path. The call log itself stays
content-free, and KNOWN-LIMITS.md carries the amended sentence and the residuals below before this ships.
Tier-1 return masking (ADR 0048) does not apply here: masking a mirror of the user's own vault to the user's
own disk would write corrupted text the user would read as real.

## Threats

Each is a finding from a review, with its mitigation and its residual.

**A program named at add time.** `.gitattributes` selects `filter.<name>.clean` or `.process` and git runs
it on `git add`, under the full `-c` override set. Executed on git 2.54: the process filter started and was
handed the document. Mitigated by never running `add`; `hash-object --no-filters` is the only path from disk
to an object, and with no checkout smudge never runs either. Residual: none found. This is why the design
changed.

**A program named at commit, index or ref time.** `.git/hooks`, `core.hooksPath`, `gpg.program`,
`core.sshCommand` and `core.fsmonitor` each run code as the user, and plumbing alone closes none of the
hooks: `post-index-change` fires on `update-index`, `reference-transaction` on `update-ref`. Mitigated by
the Decision 2 pins and an owned empty hooks directory. Residual: the pins are a list and a future git could
add a key; the verb allowlist bounds how far it would reach. **The user's own `~/.gitconfig`.**
`GIT_CONFIG_NOSYSTEM=1` alone leaves every key above in play through it. Mitigated by `GIT_CONFIG_GLOBAL` on
an owned empty file. Residual: a repository that relied on the global identity now has none, and Decision 7
refuses it with the fix.

**A stale mirror.** Byte identity refused a file another device made stale, forever, and ADR 0051 can blank
the revision a header names. Mitigated by Decision 3, where ownership is the revision chain and a stale
owned file is overwritten, and by `--adopt` covering a blanked revision. Residual: the visible chain is
short, see Residual. **A hand edit destroyed, and a cleanliness check that runs a filter.** The third
review's first kill shot: `git diff --quiet HEAD` runs the clean filter and textconv over the plaintext, has
no `--no-filters`, and a `filter.<x>.process` canary hung it; a clean filter that empties content would also
make every owned file read dirty forever. Mitigated by Decision 3's blob comparison, `hash-object
--no-filters` against `rev-parse HEAD:<path>`, which consults no attributes. Residual: an edit the user
committed is overwritten by the next export, by design, and is in git history.

**A file on disk that HEAD has never seen.** The second kill shot: an owned-looking untracked file read
clean under both old checks, so "nothing uncommitted is ever overwritten" was false, and the crash window
between `commit-tree` and `update-ref` reaches it. Mitigated by Decision 3 class 4, which overwrites only
NorthKeep's own byte-identical residue. Residual: a user file that happens to equal a fresh render is
overwritten, which costs nothing because the bytes are the same.

**An unborn HEAD, and a linked worktree.** `read-tree HEAD` and `rev-parse HEAD` fail on a fresh `git init`,
and a linked worktree has no `.git/index` to rename over. Mitigated by Decision 2's root-commit path and by
reconciling through `update-index` against the default index. Residual: a bare repository is still refused,
correctly, having no working tree to mirror into. **`--adopt` with no backup**, the second review's kill
shot over 31 hand-written files. Mitigated by `backupOnce` on every adopted file (fs-safe.ts:17-22).
Residual: adopt still overwrites, and the backup is one copy per file.

**A remote added after the confirmation.** Reading `remote.origin.url` once at configure never saw it.
Mitigated by Decision 4's re-read on every export. Residual: NorthKeep cannot stop a hand push and does not
try. **An export that does not round trip**, the first design dropping `<slug>.log.md` and `INDEX.md` on
re-import. Mitigated by Decision 5's `kind`. Residual: a reattached log is an archive with a new provenance
line, not the original row. **An INDEX cell that forges a column.** Mitigated by escaping `|` (Decision 1).
Residual: none. **Two writers into one repository.** Two processes with different `NORTHKEEP_HOME` values
did not exclude each other. Mitigated by moving the lock to `--git-common-dir` (Decision 8). Residual: a
process on another machine sharing the folder over a network filesystem is not covered.

**Symlinked paths.** `atomicWrite` writes through an existing symlink by design (fs-safe.ts:35-36).
Mitigated by `realpathSync` on the repository and `lstat` on `projects/` and each target. Residual: a
directory swapped between the `lstat` and the write is a race NorthKeep does not close. **Git missing, or
failing part way.** `execFile` fails with `ENOENT`, the vault write is already saved (Decision 10), and
files already written carry their header so the next run commits them. Residual: a crash between
`commit-tree` and `update-ref` leaves an unreferenced commit, which git garbage-collects.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| Two exports of an unchanged vault produce byte-identical files and one commit | `renderProjectFile` / `renderIndexFile`: no timestamp, dates from stored `created_at`, slug order from project-handoff.ts:256; `exportProjects` stops when `write-tree` returns HEAD's tree |
| No program named by repository, global or system config runs, including on the cleanliness check | `runGit`: the env and `-c` list in Decision 2, with `--no-filters` and an owned empty `core.hooksPath`; the canary repository in Acceptance step 2 |
| NorthKeep never creates a remote and never pushes | `runGit` rejects any verb outside the Decision 2 allowlist; a recording shim asserts the verbs seen across every trigger are a subset of it |
| An export refuses when a remote changed since the confirmation | `readRemotes` compared against `export.json` inside `exportProjects`, before any write |
| A file NorthKeep cannot prove it wrote is never overwritten without `--adopt`, and never without a backup | `ownershipOf` classes 2, 3 and 4; `backupOnce` on the one `--adopt` path |
| Nothing uncommitted is ever overwritten | `exportProjects` compares `hash-object --no-filters` against `rev-parse HEAD:<path>` per owned file and skips a mismatch; a path absent from HEAD is class 4 |
| The user's staged work is never committed by an export | `plumbingCommit` seeds a temporary `GIT_INDEX_FILE` from `read-tree HEAD`; test stages an unrelated file and asserts it is absent from the commit and still staged after |
| Export refuses a repository with no commit identity, before writing | `requireCommitIdentity`: `git var GIT_COMMITTER_IDENT` under `-c user.useConfigOnly=true` |
| Export refuses a path that is not a work tree, is inside NORTHKEEP_HOME or the vault directory, or is a symlink | `exportProjects` preflight; one test per refusal asserts zero files written |
| A git failure never rolls back or blocks a vault write | Decision 10 ordering; test makes `update-ref` exit non-zero after a `project_wrap` and asserts the receipt and new head are unchanged |
| Import drops nothing | `importProjects` steps 4 and 5; test imports a file over 16,384 characters and asserts every heading is in the document, an archive, or an `## Import overflow` memory |
| Export sends nothing off the machine and runs no model | No network or model call in either path; a test stubs network syscalls to throw and acceptance runs with Ollama stopped |
| No export header ever reaches the vault | `importProjects` strips it from the preamble; test round-trips an export and asserts no stored content contains `<!-- northkeep:` |

## Residual (documented, accepted)

- **The ownership horizon is about five revisions.** ADR 0051 Decision 4 compacts on every project write,
  keeping the newest five revisions plus any a handoff receipt names and blanking the rest with
  `forgotten_at`. `getProjectView` filters forgotten rows out (project-handoff.ts:224) before building
  `revisions` (line 229), so `PROJECT_REVISION_SUMMARY_LIMIT` (20, project-handoff.ts:24) is not the real
  reach. A mirror more than about five writes stale reads as class 2 and is refused and reported; `--adopt`,
  which backs the file up first, is the escape.
- **Archives beyond 20 are not mirrored.** `getProjectView` slices archives at the same limit
  (project-handoff.ts:228), so a project with more loses its oldest from the log files.
- **The mirror is stale between writes from other devices**, and the plaintext is readable by anything that
  can read the folder: Spotlight, Time Machine, a cloud folder sync, or a remote.
- **A conflicted project is never exported**, and its last good `<slug>.md` stays on disk, older than its
  header says. The INDEX row says `conflict`.
- **The repository's index is written by the exporter** (Decision 2), one `update-index --cacheinfo` per
  exported path. No index file is ever renamed or copied into place.
- **Case-insensitive filesystems.** Two slugs differing only in case would collide on one file on APFS. The
  slug pattern is lowercase (project-doc.ts:15), so this is unreachable today.
- **Commit identity is git's.** NorthKeep never sets one and refuses when there is none.

## Acceptance (Jay, from the CLI)

Throwaway vault and repository, `NORTHKEEP_HOME` set on every command. Step 5 copies the command repo.

```bash
export NORTHKEEP_HOME=$(mktemp -d); LAB=$(mktemp -d); R=$LAB/mirror
export NK=~/Claude/Projects/NorthKeep/northkeep/packages/cli/dist/index.js
mkdir -p $R && git -C $R init -q   # unborn HEAD on purpose, see step 1
git -C $R config user.email you@example.com; git -C $R config user.name Jay
node $NK init && node $NK projects export --repo $R   # prints path, remotes, counts; asks once
```

1. **A root commit, then a byte-identical double export.** The repository above is a fresh `git init`, so
   the first export commits onto an unborn HEAD. Then `cp -R $R/projects $LAB/a`, export again, `diff -r
   $LAB/a $R/projects` is silent, `git -C $R log --oneline | wc -l` is still 1, and `git -C $R status
   --short` is empty.
2. **Nothing the repo names ever runs, including the cleanliness check.** Run the canary script below. It
   prints `(none)`, and the disk and HEAD blob ids it prints are equal.
3. **A hand edit is refused, with no filter run.** `echo "note to self" >> $R/projects/demo.md`, then
   export: that file is refused by name, the edit intact, the other projects exported, and no canary fires.
   Commit the edit and export: overwritten, and `git -C $R show HEAD~1` still has it.
4. **A headerless file, and adopt with a backup.** `echo hi > $R/projects/stranger.md`, export: refused and
   named. `node $NK projects export --adopt`: overwritten, and `$R/projects/stranger.md.northkeep-bak` holds
   `hi`.
5. **A copy of the command repo, imported then adopted.** `cp -R ~/Claude/Projects/Command\ Repo $LAB/cr`,
   and work only there. `node $NK projects import --from $LAB/cr/projects` prints a 31-row plan, writes
   nothing, and leaves `git -C $LAB/cr status --short` empty. Re-run with `--write`, then `node $NK projects
   export --repo $LAB/cr --adopt`, and confirm every overwritten file has a `.northkeep-bak` beside it.
6. **A remote added after the confirmation.** `git -C $R remote add mirror $LAB/bare.git`, then export: the
   whole run refuses and asks to re-confirm. Re-confirm, export, and `git -C $R log --oneline` shows the new
   commit with no push.
7. **Refusals, each writing nothing:** a path inside `$NORTHKEEP_HOME`, a path that is not a work tree, a
   bare repository, a repository with `user.email` unset, a symlinked `projects/`, and a second export while
   one is running. Then point the exporter at a repository whose `.git` is read-only, run a `projects
   update`, and confirm the vault head changed while the CLI reported the export skipped.
8. **A staged file is not committed.** `echo x >> $R/README.md && git -C $R add README.md`, run a `projects
   update`, and confirm `git -C $R show --stat HEAD` does not list README.md while `git -C $R status
   --short` still shows it staged.
9. **Unrecorded residue.** Copy `$R/projects/demo.md` to `$R/projects/ghost.md`, keeping its header, and
   export: refused by name, because HEAD has no `ghost.md`. Delete it, then simulate crash residue by
   writing the current render of a real project over its own file without committing, and confirm that file
   is adopted silently because its bytes match.
10. **A linked worktree.** `git -C $R worktree add $LAB/wt -b wtb`, point the exporter at `$LAB/wt`, run a
    `projects update`, and confirm the commit landed, `git -C $LAB/wt status --short` is clean, and the lock
    appeared at `$R/.git/northkeep-export.lock`.
11. **Zero model tokens.** Stop Ollama and repeat steps 1 and 5.

The canary script for step 2, a hostile repository under the exact Decision 2 sequence:

```bash
#!/bin/bash
set -u; LAB=$(mktemp -d); R=$LAB/repo; F=$LAB/fired; N=$LAB/nkhome; C=$LAB/c
mkdir -p $R $N/hooks $LAB/hk; : > $N/empty.gitconfig; : > $F
printf '#!/bin/sh\necho "FIRED $0 $*" >> %s\ncat > /dev/null\nexit 0\n' $F > $C; chmod +x $C
git -C $R init -q; git -C $R config user.name O; git -C $R config user.email o@e.invalid
for h in pre-commit post-commit commit-msg prepare-commit-msg reference-transaction \
         post-index-change post-checkout post-rewrite fsmonitor-watchman; do
  cp $C $R/.git/hooks/$h; cp $C $LAB/hk/$h; done
for k in core.fsmonitor core.sshCommand core.editor core.pager core.askPass core.gitProxy \
         core.alternateRefsCommand gpg.program diff.external sequence.editor ssh.variant \
         uploadpack.packObjectsHook credential.helper filter.nk.clean filter.nk.smudge \
         filter.nkp.process diff.nk.textconv merge.nk.driver trailer.nk.command; do
  git -C $R config $k $C; done
printf '[gpg]\n\tprogram = %s\n' $C > $R/.git/extra.config   # reached through include.path
for kv in "core.hooksPath $LAB/hk" "core.autocrlf true" "commit.gpgsign true" \
  "filter.nkp.required true" "include.path $R/.git/extra.config"; do git -C $R config $kv; done
printf '* filter=nk diff=nk merge=nk\n*.md filter=nkp diff=nk\n' > $R/.gitattributes
git -C $R -c filter.nk.clean= -c filter.nkp.process= -c filter.nkp.required=false \
  -c core.hooksPath=$N/hooks -c commit.gpgsign=false add -A 2>/dev/null
git -C $R -c core.hooksPath=$N/hooks -c commit.gpgsign=false commit -qm base --no-verify
: > $F; mkdir -p $R/projects
printf '<!-- northkeep: ... -->\n# demo\n\nplaintext body\n' > $R/projects/demo.md
G() { env -i PATH=/usr/bin:/bin HOME=$N GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=$N/empty.gitconfig GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
  GIT_OPTIONAL_LOCKS=0 GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false \
  GIT_INDEX_FILE=$LAB/nk.index /usr/bin/git -C $R \
  -c core.hooksPath=$N/hooks -c core.fsmonitor=false -c core.useBuiltinFSMonitor=false \
  -c gpg.program=/usr/bin/false -c commit.gpgsign=false -c tag.gpgsign=false \
  -c core.sshCommand=/usr/bin/false -c credential.helper= -c diff.external= \
  -c core.editor=/usr/bin/false -c sequence.editor=/usr/bin/false -c core.pager=cat \
  -c core.askPass=/usr/bin/false -c core.gitProxy= -c core.alternateRefsCommand= \
  -c core.autocrlf=false -c core.safecrlf=false -c core.symlinks=false \
  -c protocol.ext.allow=never -c uploadpack.packObjectsHook= -c user.useConfigOnly=true "$@"; }
G var GIT_COMMITTER_IDENT > /dev/null || { echo "no identity: refused"; exit 1; }
G read-tree HEAD
BL=$(G hash-object -w --no-filters -- $R/projects/demo.md)
G update-index --add --cacheinfo 100644,$BL,projects/demo.md
T=$(G write-tree); P=$(G rev-parse HEAD)
CM=$(printf 'export: 1 project (test)\n' | G commit-tree $T -p $P)
G update-ref -m "northkeep export" HEAD $CM $P
echo "== the cleanliness check, filter-free =="   # amendment 1, and it fires no canary
echo "disk=$(G hash-object --no-filters -- $R/projects/demo.md) head=$(G rev-parse HEAD:projects/demo.md)"
G ls-tree HEAD -- projects/demo.md
echo "canaries fired:"; cat $F; [ -s $F ] || echo "(none)"
```

Run on git 2.54.0 (Apple Git-157) while this draft was written: `(none)`, and `hash-object --no-filters` and
`rev-parse HEAD:projects/demo.md` returned the same blob id with no canary. The same repository under `git
add` fired `filter.nkp.process`, and `diff --quiet HEAD` hung on the filter handshake, which is why neither
verb exists in the product. Two caveats keep the claim no wider than the evidence. The keys genuinely
exercised are the filters, the hooks, `gpg.program`, `core.editor`, `diff.external` and `core.fsmonitor`;
`credential.helper`, `core.sshCommand`, `ssh.variant`, `core.gitProxy`, `protocol.ext` and
`uploadpack.packObjectsHook` are unreachable anyway, because no allowed verb touches a transport. And
`commit-tree` with `commit.gpgsign=true` and `gpg.program` on a canary, both unpinned, signed nothing and
fired nothing, so the gpg pins are not load-bearing either.

## Adversarial review (2026-09-22, against the third draft)

Executed against git 2.54 in a lab, not read. Verdict: **NOT CLEARED**. Jay approved the amendments on
2026-09-22 and they are applied in the Decisions above.

**Kill shots.** (1) The cleanliness check ran a program. `git diff --quiet HEAD -- <file>` hands the
plaintext to the repository's clean filter and to `diff.<x>.textconv`, `diff` has no `--no-filters`, and
`GIT_ATTR_NOSYSTEM` does not reach an in-repo `.gitattributes` or `.git/info/attributes`; a
`filter.<x>.process` canary hung the command. A clean filter that empties content would also make every
owned file read dirty forever, so the export would refuse itself into uselessness. `diff-index --cached
--quiet HEAD` did not fire, because it compares the index with HEAD and touches no worktree file. (2) An
owned-looking file present on disk but absent from HEAD read clean under both checks, so "nothing
uncommitted is ever overwritten" was false. It is reachable through the crash window between `commit-tree`
and `update-ref`, and through a first export that failed after writing.

**Flesh wounds.** No root-commit path: `read-tree HEAD` and `rev-parse HEAD` both fail on an unborn HEAD,
which acceptance step 1's own `git init` produces. A linked worktree passed preflight but has a `.git` file
and no `.git/index`, so the reconcile rename had no target. Decision 6's arithmetic was wrong:
`PROJECT_DOC_MAX_CHARS` counts UTF-16 units, so the largest document is 49,152 bytes, and a legal
65,536-byte archive row cannot fit a 65,302-byte part budget. And Decision 3 granted `--adopt` only to
headerless files while Residual promised it for a blanked revision.

**Scar tissue.** The lock under `NORTHKEEP_HOME` excluded neither two processes with different homes nor
`.git/index.lock`. Two negatives held: `remote -v` showed `pushurl`, `includeIf` and `insteadOf`, and the
identity pins behaved as Decision 7 states.

## Earlier drafts

**First review (2026-09-21). NOT CLEARED.** Eight citations pointed at the wrong lines, itself the finding.
Hooks were not the only program a repository names, and `GIT_CONFIG_NOSYSTEM=1` left `~/.gitconfig` in play.
`git status --porcelain` was not an ownership test in either direction, and nothing refused a file NorthKeep
did not write, so the first export into the command repo would have overwritten 31 hand-written files. Eight
further findings ran from an unstated byte cap to two writers exporting at once.

**Second review (2026-09-21, with a real git). NOT CLEARED.** Kill shots: a `.gitattributes` filter ran on
`add` and was handed the plaintext; `--adopt` kept no backup; the header test could not heal a mirror
another device left stale. Flesh wounds: NorthKeep's own export did not round trip, `remote.origin.url` was
read only at configure, the header was not stripped on import, and `serializeProjectDoc` returns no trailing
newline. The result was the third draft: plumbing writes, `backupOnce` on adopt, remote re-checks,
revision-chain ownership, round-tripping headers, and stripping the header on import.
