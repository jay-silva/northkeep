# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Fifth draft, pending adversarial review. Four reviews, four NOT CLEARED verdicts: two on
  2026-09-21, two on 2026-09-22 against the third and fourth drafts. Both 2026-09-22 reviews are recorded
  below and their amendments, approved by Jay the same day, are applied in the Decisions. Nothing is built.
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
both, `exportProjects`, `classifyTarget`, `readJournal`, `writeJournal`, `acquireExportLock` and
`importProjects`.

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

A conflicted project (`conflict: true`, two live heads) renders slug, `conflict`, the fixed text `two live
documents, not exported`, and empty cells; its `<slug>.md` is neither written nor removed, and the result
names it.

## Decision 2: Plumbing writes (git-plumbing.ts)

NorthKeep writes every file itself with `atomicWrite` (packages/mcp-server/src/fs-safe.ts:31-49), which
resolves an existing file's realpath and writes through it (lines 35-36), and chmods a new mirror `0o644`
rather than the helper's `0o600` default (line 33), because a mirror lives in a repository the user may
share.

Git never touches the working tree. The bytes on disk are recorded with plumbing, in this order, all through
`execFile` with an args array:

```
git worktree list --porcelain                   # refuse if HEAD's branch is checked out elsewhere
git read-tree HEAD                              # into a TEMPORARY index, see below
git hash-object -w --no-filters -- <abs path>   # per file, then journaled (Decision 3)
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
GIT_INDEX_FILE=<NORTHKEEP_HOME>/export/<hash of repo realpath>.index
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
--path-format=absolute` (Decision 8).

**Repository preflight,** before anything is written, each refusing the whole run: the path is not a work
tree (`rev-parse --show-toplevel` must succeed and equal the resolved path, and NorthKeep never runs `git
init`); the repository is bare (`rev-parse --is-bare-repository`); the path is inside `northkeepHome()`
(packages/core/src/platform.ts:7-9) or the vault file's directory, by prefix on a separator boundary; the
path is a NorthKeep checkout; or `worktree list --porcelain` shows HEAD's branch checked out in another
worktree, which the fourth review used to move that worktree's branch and leave a file staged there. A
linked worktree of the repository being exported is allowed and normal.

**Per-target containment,** checked per file immediately before that file is written, refusing that one
target by name and letting the run continue:

1. `lstat` every path component from the repository root down, `projects` then `projects/<name>`; a symlink
   anywhere refuses the target, because `atomicWrite` resolves and writes through one by design
   (fs-safe.ts:35-36).
2. The target exists and is not a regular file, or has `st_nlink` greater than 1. The fourth review wrote
   through a hard link, changing a file outside `projects/`.
3. `ls-tree HEAD -- projects` reports mode 160000, or a `.git` entry exists under `projects`. The fourth
   review wrote vault plaintext inside a submodule whose remotes Decision 4 never read, and `update-index`
   then failed, leaving the file there.
4. `realpath(dirname(target))` must start with `realpath(repo)` plus a separator.

**The temporary index, the root commit, and the user's staged work.** `GIT_INDEX_FILE` points at a
NorthKeep-owned index seeded by `read-tree HEAD`, never the repository's own, so the commit carries HEAD's
tree plus the exported files and whatever the user had staged is not in it. When HEAD is unborn, which
`rev-parse --verify HEAD` reports by failing, the index is seeded with `read-tree --empty`, `commit-tree`
runs with no parent and `update-ref HEAD <commit>` with no old value; executed against a fresh `git init`.
After `update-ref` the exporter reconciles the repository's own index with one `update-index --add
--cacheinfo 100644,<blob>,<path>` per exported path, run without `GIT_INDEX_FILE` so it lands on the default
index. A linked worktree does have an index of its own, at `.git/worktrees/<name>/index`, which is exactly
why the reconcile names no index file by path and lets git choose; executed there and correct.

The reconcile can fail. A stale `.git/index.lock` makes `update-index` exit 128 after `update-ref` has
landed, leaving `git status` showing the path modified; the fourth draft's claim that this step is safe
around that lock was false. Nothing is rolled back, because HEAD and the files on disk agree and the commit
is correct. The run reports "committed; working index not refreshed" for those paths, names the lock, and
the next run heals it, because Decision 3's journal still recognizes the file. A sparse index is expanded to
a full one here, a residual rather than something avoided.

There is no checkout step, so a smudge filter has nothing to run on: the working tree files are the ones
NorthKeep wrote. A second export of an unchanged vault makes `write-tree` return HEAD's own tree id and the
exporter stops before `commit-tree`; verified, no second commit.

## Decision 3: Ownership by header and journal (project-export-run.ts, `classifyTarget`)

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

**The journal.** Beside `export.json`, at `<NORTHKEEP_HOME>/export/<hash of repo realpath>.json`, the
exporter records for every path it writes the blob id it wrote there, after `hash-object -w` and before
`update-ref`, so a crash between them leaves the residue already journaled. The journal is not the record:
git and the vault are, and this is a hint about what NorthKeep last put on disk. Deleting it costs nothing
permanent, because the next run treats unrecognized residue as a hand edit and `--adopt` clears that.

**The rule.** `classifyTarget(target, { diskBlob, headBlob, journalBlob, vaultId, slug })` takes the git
results as inputs, because "absent from HEAD" is a git answer no pure renderer can know. `diskBlob` is `git
hash-object --no-filters -- <file>`, `headBlob` is `git rev-parse HEAD:projects/<name>` or null when it
exits non-zero, and `journalBlob` is the entry for that path or null. A target is **ours** when its header
parses and names this vault id and, for `kind document` and `kind log`, this slug (`INDEX.md` needs the
vault id alone), and `diskBlob` equals `headBlob` or equals `journalBlob`.

Anything else there is a **hand edit**: refused by name, reported, and the run continues. A missing file is
neither, and is written.

That rule covers every state the four reviews produced. Crash residue between `commit-tree` and `update-ref`
matches `journalBlob`; a failed index reconcile, a branch staged by another worktree, and a `git checkout .`
that restores a previous export match one or the other; a stale mirror from another device matches
`headBlob` and is overwritten. None of it renders an old revision or depends on ADR 0051. It refuses exactly
a file whose bytes no git object and no journal entry accounts for.

**`--adopt`** is one rule, and it exists only on the CLI: back up anything not provably NorthKeep's with
`backupOnce` (fs-safe.ts:17-22), which copies the file to `<name>.northkeep-bak` and only when no backup
exists, then overwrite. The automatic trigger never adopts (Decision 10).

**No filter runs during any of this.** `hash-object --no-filters`, `rev-parse HEAD:<path>` and `ls-tree`
consult no attributes, which the fourth review confirmed against five attribute sources at once. Four shapes
of `rev-parse HEAD:<path>` were executed and are inputs rather than surprises: a symlink returns the blob of
the link text and cannot equal `diskBlob`; a directory returns a tree id while `hash-object` fails; a
gitlink returns a commit id; and a path absent from HEAD exits 128, which is `headBlob` null. The first
three are refused by Decision 2's containment before this runs.

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

Two numbers, because the third review found the arithmetic wrong and the fourth corrected the header.
`PROJECT_DOC_MAX_CHARS` is 16,384 (project-doc.ts:10) and JavaScript counts UTF-16 code units, so the
largest document that cap admits is 49,152 UTF-8 bytes; the header is at most 257 bytes, two 36-character
uuids and a 40-character slug, so such a file stays well under 64 KiB. But the cap is enforced only on the
write paths (`assertProjectDocSize`, project-doc.ts:199-203, called from project-handoff.ts:190), so a
document that arrived through sync is ungated and can be larger. The renderer therefore tolerates any size
on `projects/<slug>.md`, exporting it whatever it measures and reporting a size over 65,536 bytes rather
than refusing, because refusing would hide the one project most in need of reading.

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
into `ProjectView.last_writer`, line 74), or `(unknown host)`. `model not exposed` is fixed text, because
ADR 0052 Decision 1 stores `model: null`. The message reaches git on `commit-tree`'s stdin, never as an
argument and never through a shell, for the reason packages/mcp-server/src/connect.ts:235-236 states about
`execFileSync`.

## Decision 8: Concurrency (project-export-run.ts, `acquireExportLock`)

One lock file per repository at `<common dir>/northkeep-export.lock`, the common dir from `git rev-parse
--path-format=absolute --git-common-dir`; the plain form returns a relative `.git` from the main worktree,
which would have put the lock under the process working directory, and `--path-format=absolute` needs git
2.31. Every process on that repository, and every linked worktree of it, contends for one file. It is
created `O_EXCL` with this process's pid and start time, which elected exactly one of eight racers on APFS.
It is stale only when the pid is not alive or the file is older than one hour; the fourth review found the
previous rule, an OR against ten minutes, declared a live exporter stale. The `finally` block removes the
lock only when the file still holds this process's pid. A second export waits up to 30 seconds, then reports
that one is already running.

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

## Decision 10: Trigger and scope (project-export-run.ts)

The writer mirrors its own write after the vault save succeeds and after the vault lock is released: the MCP
server after `project_wrap`, `project_checkpoint`, `project_update` and `project_create`, and the CLI after
`northkeep projects update`, a new subcommand proposed here (`projects` today has only `compact`,
packages/cli/src/index.ts:881-893). `northkeep projects export` is the idempotent full re-render. A failure
of the export never fails the vault write: it is caught and reported.

**The automatic path never adopts.** `--adopt` exists only on the CLI, where a human typed it. When an
automatic export refuses a file, the tool payload names it and prints the exact command, `northkeep projects
export --repo <path> --adopt`. The journal counts consecutive failed automatic exports per repository; after
three the trigger stops and says so, and only a successful hand run clears the counter. A configured path
that no longer resolves or no longer passes preflight disables the trigger with the same report, rather than
failing on every write for months.

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
ships. Tier-1 return masking (ADR 0048) does not apply here: masking a mirror of the user's own vault to the
user's own disk would write corrupted text the user would read as real.

## Twelve-month post-mortems

**The vault is restored from backup.** The restored vault names revisions the mirror has never seen, and
under the fourth draft the whole mirror would have classed unknown and refused forever. Under Decision 3 the
header test is vault id and slug, the revision is informational, and the blob test compares against HEAD and
the journal, so every file is still ours and the next export simply overwrites with the restored content.
Git history holds what the mirror said before.

**The repository is moved.** `export.json` names a path that no longer resolves, so the trigger disables
itself with a report naming the old path (Decision 10) rather than failing on every vault write. The user
reconfigures, which re-asks the Decision 4 remote confirmation, and the journal keyed by the old realpath is
never read again.

**A second Mac, or the repository in a cloud-synced folder.** This joins two residuals. The lock is per
machine, under the repository's common dir, so two machines exporting one synced folder is unsupported and
can interleave commits; and the plaintext sits in a folder something else copies off the machine. Neither is
detected. The supported shape is one machine per repository path.

**History is rewritten, for example with `git filter-repo`.** If the rewrite leaves the mirror bytes alone
this is invisible, because the blob ids do not change. If it rewrites or drops `projects/`, `headBlob`
changes or goes null and the journal entry no longer matches, so every affected file classes as a hand edit
and is refused by name until the user runs `--adopt`, which backs each one up first. That is the correct
outcome: NorthKeep cannot tell a deliberate rewrite from damage.

**The user edits `INDEX.md` by hand.** It is derived, so nothing reads the edit back. Every run refuses it
by name and exports the rest, once per write, until the user reverts it or runs `--adopt`, which backs it up
and restores the generated content.

## Threats

Each is a finding from one of the four reviews, with its mitigation and its residual. The two 2026-09-22
reviews are recorded in full below; this is the standing list.

**A repository that names a program.** At add time through a `.gitattributes` filter, at commit time through
hooks, `gpg.program`, `core.sshCommand` or `core.fsmonitor`, at index and ref time through
`post-index-change` and `reference-transaction`, and through `~/.gitconfig` when only
`GIT_CONFIG_NOSYSTEM=1` is set. Mitigated by the Decision 2 allowlist, `--no-filters`, an owned empty
`core.hooksPath`, the pins and `GIT_CONFIG_GLOBAL` on an owned empty file, executed against five attribute
sources and nineteen keys. Residual: the pins are a list, and a future git could add a key.

**Bytes written outside the repository the user confirmed.** A symlinked component, a hard link, a submodule
or nested repository under `projects/`, or a target that is not a regular file. Mitigated by Decision 2's
per-target containment, which refuses that target and continues. Residual: a component swapped between the
`lstat` and the write is a race NorthKeep does not close.

**An uncommitted hand edit destroyed, or a mirror wedged so only a human can clear it.** The third review
showed the cleanliness check itself ran a filter; the fourth showed three faults that left a file no rule
could re-recognize. Mitigated by Decision 3: blob comparison with no attribute lookup, and ownership by
header plus HEAD blob or journal blob. Residual: an edit the user committed is overwritten by the next
export, by design, and is in git history.

**Two writers, or a branch someone else has checked out.** Mitigated by the Decision 8 lock in the common
dir and by refusing when `worktree list --porcelain` shows HEAD's branch checked out elsewhere. Residual:
two machines sharing one folder are not covered, and are stated as unsupported.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| Two exports of an unchanged vault produce byte-identical files and one commit | `renderProjectFile` / `renderIndexFile`: no timestamp, dates from stored `created_at`, slug order from project-handoff.ts:256; `exportProjects` stops when `write-tree` returns HEAD's tree |
| No program named by repository, global or system config runs, including on the cleanliness check | `runGit`: the env and `-c` list in Decision 2, with `--no-filters` and an owned empty `core.hooksPath`; the canary repository in Acceptance step 2 |
| NorthKeep never creates a remote and never pushes | `runGit` rejects any verb outside the Decision 2 allowlist; a recording shim asserts the verbs seen across every trigger are a subset of it |
| A file NorthKeep cannot prove it wrote is never overwritten without `--adopt`, and never without a backup | `classifyTarget`: header vault and slug, plus `diskBlob` equal to `headBlob` or `journalBlob`; `backupOnce` on the one `--adopt` path, which the automatic trigger cannot reach |
| Nothing uncommitted is ever overwritten, and one fault never wedges the mirror | `classifyTarget` over `hash-object --no-filters`, `rev-parse HEAD:<path>` and the journal; tests replay the crash window, a stale `index.lock` and a `checkout .` and assert the next run heals |
| The user's staged work is never committed by an export | `plumbingCommit` seeds a temporary `GIT_INDEX_FILE` from `read-tree HEAD`; test stages an unrelated file and asserts it is absent from the commit and still staged after |
| No byte is written outside the repository whose remotes were confirmed | `exportProjects` preflight plus per-target containment: component `lstat`, regular file, `st_nlink` 1, no gitlink or nested `.git`, and `realpath(dirname)` under `realpath(repo)`; one test per refusal |
| An export refuses while HEAD's branch is checked out in another worktree | `worktree list --porcelain` before `update-ref`; test checks the branch out elsewhere and asserts no commit |
| Export sends nothing off the machine and runs no model | No network or model call in either path; a test stubs network syscalls to throw and acceptance runs with Ollama stopped |
| No export header ever reaches the vault | `importProjects` strips it from the preamble; test round-trips an export and asserts no stored content contains `<!-- northkeep:` |

## Residual (documented, accepted)

- **The journal can be lost.** Residue from a crash that HEAD never recorded then classes as a hand edit
  and needs `--adopt`, which backs the file up first.
- **Archives beyond 20 are not mirrored.** `getProjectView` slices archives at
  `PROJECT_REVISION_SUMMARY_LIMIT` (20, project-handoff.ts:24 and 228), so a project with more loses its
  oldest from the log files. They stay in the vault.
- **The mirror is stale between writes from other devices**, and the plaintext is readable by anything that
  can read the folder: Spotlight, Time Machine, a cloud folder sync, or a remote. Two machines exporting one
  synced folder is unsupported: the lock is per repository on one machine.
- **A conflicted project is never exported**, and its last good `<slug>.md` stays on disk, older than its
  header says. The INDEX row says `conflict`.
- **The repository's index is written by the exporter** (Decision 2), one `update-index --cacheinfo` per
  exported path, which expands a sparse index to a full one and can fail on a stale `.git/index.lock`, both
  reported rather than avoided.
- **Case-insensitive filesystems.** Two slugs differing only in case would collide on one file on APFS. The
  slug pattern is lowercase (project-doc.ts:15), so this is unreachable today.
- **Commit identity is git's,** and git 2.31 or newer is required.

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
   $LAB/a $R/projects` is silent, `git -C $R log --oneline | wc -l` is 1, and `git -C $R status --short` is
   empty.
2. **Nothing the repo names ever runs, including the ownership check.** Run the canary script below. It
   prints `(none)`, and the disk and HEAD blob ids it prints are equal.
3. **A hand edit is refused, and one fault heals.** `echo "note" >> $R/projects/demo.md`, export: refused by
   name, edit intact, others exported. Restore it with `git -C $R checkout -- projects/demo.md` and export:
   it matches HEAD, so it is overwritten silently. Then delete `$NORTHKEEP_HOME/export/*.json`'s journal
   entries, repeat, and confirm the HEAD blob alone still heals it.
4. **Crash residue.** Kill the exporter between `commit-tree` and `update-ref` (a `NORTHKEEP_EXPORT_CRASH=1`
   test hook), write to the vault twice more, then export: the residue matches the journal, is overwritten
   silently, and nothing is refused.
5. **Containment, each refusing one target and continuing.** A symlinked `projects/x.md`, a hard-linked
   `projects/demo.md`, a `projects` submodule in a second copy, and a directory named `projects/demo.md`.
   Each is refused by name, the others export, and nothing is written outside `$R`.
6. **A copy of the command repo, imported then adopted.** `cp -R ~/Claude/Projects/Command\ Repo $LAB/cr`,
   and work only there. The import dry run prints a 31-row plan, writes nothing, and leaves `git -C $LAB/cr
   status --short` empty. Re-run with `--write`, then export with `--adopt`, and confirm every overwritten
   file has a `.northkeep-bak` beside it.
7. **A remote added after the confirmation.** `git -C $R remote add mirror $LAB/bare.git`, then export: the
   whole run refuses and asks to re-confirm. Re-confirm, export, and `git -C $R log --oneline` shows the new
   commit with no push.
8. **Refusals, each writing nothing:** a path inside `$NORTHKEEP_HOME`, a path that is not a work tree, a
   bare repository, `user.email` unset, and a second export while one is running. Then `git -C $R worktree
   add $LAB/w2 -b $(git -C $R branch --show-current)` style collision: HEAD's branch checked out elsewhere
   refuses the run before `update-ref`.
9. **A staged file is not committed, and a locked index is reported.** `echo x >> $R/README.md && git -C $R
   add README.md`, run a `projects update`: `git -C $R show --stat HEAD` omits README.md and it is still
   staged. Then `touch $R/.git/index.lock`, run a `projects update`, and confirm the commit landed and the
   CLI reported "committed; working index not refreshed".
10. **A linked worktree.** `git -C $R worktree add $LAB/wt -b wtb`, point the exporter at `$LAB/wt`, run a
    `projects update`, and confirm the commit landed, `git -C $LAB/wt status --short` is clean, and the lock
    appeared at `$R/.git/northkeep-export.lock`.
11. **The automatic path never adopts, and gives up.** Leave a headerless `$R/projects/stranger.md` in place
    and make three vault writes: each reports the file and the exact `--adopt` command, and the fourth write
    reports that the trigger has stopped. Run `node $NK projects export --adopt` by hand and confirm the
    trigger resumes and `stranger.md.northkeep-bak` exists.
12. **Zero model tokens.** Stop Ollama and repeat steps 1 and 6.

The canary script for step 2, a hostile repository under the exact Decision 2 sequence:

```bash
#!/bin/bash
set -u; LAB=$(mktemp -d); R=$LAB/repo; F=$LAB/fired; N=$LAB/nkhome; C=$LAB/c
mkdir -p $R $N/hooks $LAB/hk; : > $N/empty.gitconfig; : > $F
printf '#!/bin/sh\necho "FIRED $0 $*" >> %s\ncat > /dev/null\nexit 0\n' $F > $C; chmod +x $C
git -C $R init -q; git -C $R config user.name O; git -C $R config user.email o@e.invalid
for h in pre-commit post-commit commit-msg prepare-commit-msg reference-transaction post-index-change \
         post-checkout post-rewrite fsmonitor-watchman; do cp $C $R/.git/hooks/$h; cp $C $LAB/hk/$h; done
for k in core.fsmonitor core.sshCommand core.editor core.pager core.askPass core.gitProxy \
         core.alternateRefsCommand gpg.program diff.external sequence.editor ssh.variant \
         uploadpack.packObjectsHook credential.helper filter.nk.clean filter.nk.smudge \
         filter.nkp.process diff.nk.textconv merge.nk.driver trailer.nk.command; do
  git -C $R config $k $C; done
printf '[gpg]\n\tprogram = %s\n' $C > $R/.git/extra.config   # reached through include.path
for kv in "core.hooksPath $LAB/hk" "core.autocrlf true" "commit.gpgsign true" \
  "filter.nkp.required true" "include.path $R/.git/extra.config"; do git -C $R config $kv; done
git -C $R -c core.hooksPath=$N/hooks -c commit.gpgsign=false -c core.fsmonitor=false \
  commit -q --allow-empty -m base --no-verify
ATTR='* filter=nk diff=nk merge=nk working-tree-encoding=UTF-16 text eol=crlf'
printf '%s\n*.md filter=nkp\n' "$ATTR" > $R/.gitattributes   # untracked, and still live
printf '%s\n' "$ATTR" > $R/.git/info/attributes
: > $F; mkdir -p $R/projects
printf '<!-- northkeep: ... -->\n# demo\n\nplaintext body\n' > $R/projects/demo.md
PINS="-c core.hooksPath=$N/hooks -c core.fsmonitor=false -c core.useBuiltinFSMonitor=false
 -c gpg.program=/usr/bin/false -c commit.gpgsign=false -c tag.gpgsign=false -c core.sshCommand=/usr/bin/false
 -c credential.helper= -c diff.external= -c core.editor=/usr/bin/false -c sequence.editor=/usr/bin/false
 -c core.pager=cat -c core.askPass=/usr/bin/false -c core.gitProxy= -c core.alternateRefsCommand=
 -c core.autocrlf=false -c core.safecrlf=false -c core.symlinks=false -c protocol.ext.allow=never
 -c uploadpack.packObjectsHook= -c user.useConfigOnly=true"
G() { env -i PATH=/usr/bin:/bin HOME=$N GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=$N/empty.gitconfig \
  GIT_ATTR_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_ASKPASS=/usr/bin/false \
  SSH_ASKPASS=/usr/bin/false GIT_INDEX_FILE=$LAB/nk.index /usr/bin/git -C $R $PINS "$@"; }
G var GIT_COMMITTER_IDENT > /dev/null || { echo "no identity: refused"; exit 1; }
G worktree list --porcelain > /dev/null
G read-tree HEAD
BL=$(G hash-object -w --no-filters -- $R/projects/demo.md)
G update-index --add --cacheinfo 100644,$BL,projects/demo.md
T=$(G write-tree); P=$(G rev-parse HEAD)
CM=$(printf 'export: 1 project (test)\n' | G commit-tree $T -p $P)
G update-ref -m "northkeep export" HEAD $CM $P
echo "disk=$(G hash-object --no-filters -- $R/projects/demo.md) head=$(G rev-parse HEAD:projects/demo.md)"
G ls-tree HEAD -- projects/demo.md
echo "canaries fired:"; cat $F; [ -s $F ] || echo "(none)"
```

Run while this draft was written: `(none)`, and the disk and HEAD blob ids were equal. The same repository
under `git add` fires the process filter, and `diff --quiet HEAD` hangs on it, which is why neither verb
exists in the product. One caveat keeps the claim no wider than the evidence: the filters, hooks,
`gpg.program`, `core.editor`, `diff.external` and `core.fsmonitor` were genuinely exercised, while
`credential.helper`, `core.sshCommand`, `ssh.variant`, `core.gitProxy`, `protocol.ext` and
`uploadpack.packObjectsHook` are unreachable anyway, because no allowed verb touches a transport.

## Adversarial review (2026-09-22, against the fourth draft)

Executed on git 2.54.0 (Apple Git-157), APFS, macOS 26.6. Verdict: **NOT CLEARED**. Jay approved the
amendments the same day and they are applied in the Decisions above.

**What held, and is cited above.** All ten allowlisted verbs under the pinned environment and `-c` list
fired zero canaries against nineteen config keys, nine hooks plus `core.hooksPath`, and five attribute
sources; blob ids equalled an independently computed SHA-1, so no encoding or end-of-line conversion; the
control without `--no-filters` hung on the process filter, proving the attributes were live. `commit-tree`
did not sign under an unpinned `commit.gpgsign` and a canary `gpg.program`. The unborn-HEAD path worked, a
second pass produced HEAD's own tree, and `O_EXCL` elected exactly one of eight racers. Twenty-eight
citations verified, and `owned()` (project-handoff.ts:131-133) returning the empty string for a missing
section means Decision 9's heading map cannot break `getProjectView`.

**Kill shots.** (1) A single fault wedged the mirror permanently, and the automatic path could not clear it.
Three executed faults each left a file whose bytes differed from HEAD or whose HEAD entry was gone: the
crash window combined with a vault advance, because the trigger fires from a vault write so the "fresh
render of the current revision" test never matches again; a stale `.git/index.lock` leaving `MM` after the
commit landed; and another worktree's staged change. Each was clearable only by `--adopt`, which the
automatic trigger cannot pass. (2) Preflight validated the repository root but never that each target
resolves inside it. A `projects/` submodule took vault plaintext into a different repository, whose remotes
Decision 4 never read, and then aborted the run leaving the file there.

**Flesh wounds.** The `.git/index.lock` sentence was false: `update-index` takes the lock and fails, after
the commit. `update-ref` had no guard and moved a branch checked out in another worktree, and its
no-old-value form succeeded against a non-empty HEAD. "A linked worktree has no `.git/index` of its own" was
wrong in its reason; it has `.git/worktrees/<name>/index`. `ownershipOf(file, view)` could not return class
4, because "absent from HEAD" is a git result and the signature took none, in the file the draft called the
pure renderers. The lock was stale on an OR, so a live exporter eleven minutes in was declared stale; the
`finally` block removed another process's lock; and `--git-common-dir` returns a relative `.git` from the
main worktree.

**Scar tissue.** `atomicWrite` over a hard-linked file changed a file outside `projects/` and dropped the
link count, unchecked. A sparse index is force-expanded by the reconcile. The header is 257 bytes, not 234.
ADR 0045's 64 KiB row cap was uncited, and a sync-received row is ungated by `PROJECT_DOC_MAX_CHARS`. No
post-mortem covered a restored vault, a moved repository, a hand-edited `INDEX.md`, a second Mac, or
`filter-repo`.

## Adversarial review (2026-09-22, against the third draft)

Executed against git 2.54. Verdict: **NOT CLEARED**. Kill shots: the cleanliness check `git diff --quiet
HEAD` handed the plaintext to the clean filter and textconv, has no `--no-filters`, and `GIT_ATTR_NOSYSTEM`
does not reach an in-repo `.gitattributes`, with a process-filter canary hanging it; and an owned-looking
file absent from HEAD read clean, so "nothing uncommitted is ever overwritten" was false. Flesh wounds: no
root-commit path, a linked worktree with no index to rename over, wrong UTF-16 arithmetic in Decision 6, and
`--adopt` promised in Residual but not granted in Decision 3. Negatives that held: `remote -v` showed
`pushurl`, `includeIf` and `insteadOf`, and the identity pins behaved as Decision 7 states.

## Earlier drafts

**First and second reviews (2026-09-21), both NOT CLEARED.** The first found eight stale citations, hooks
treated as the only program a repository names, `~/.gitconfig` still in play, and `git status --porcelain`
used as an ownership test that would have overwritten 31 hand-written files. The second, with a real git,
found a `.gitattributes` filter running on `add` over the plaintext, `--adopt` keeping no backup, a header
test that could not heal a stale mirror, and an export that did not round trip. Together they produced the
third draft: plumbing writes, `backupOnce` on adopt, remote re-checks, round-tripping headers, and stripping
the header on import.
