# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Third draft, pending adversarial review. The first two drafts were reviewed on 2026-09-21 and
  were NOT CLEARED twice. This is a redesign, not an amendment: files are written by git plumbing, ownership
  is decided by a header, and remotes are re-checked on every run. Nothing is built.
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

Three new files are proposed: `packages/core/src/project-export.ts` for the pure renderers and the header
grammar (`renderProjectFile`, `renderLogFile`, `renderIndexFile`, `parseExportHeader`, `ownershipOf`),
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
Status body (project-handoff.ts:256 uses `getProjectSection(doc,'Current Status')||null`), so the renderer
takes `firstNonEmptyLine` (packages/core/src/project-doc.ts:153-159) and cuts to 120 characters with an
ellipsis.

The same vault state renders byte-identical files. No generation timestamp anywhere. Every date printed
comes from a stored `created_at`, rendered `YYYY-MM-DD` in UTC. Section order is the document's own, because
the body is the stored `content` verbatim, and row order is the slug order line 256 already fixes. Line
endings are `\n`, and the renderer appends the trailing newline `serializeProjectDoc`
(project-doc.ts:137-146) does not return. `<slug>.log.md` is rendered from the archive memories, which
`getProjectView` returns only under `history: true` (project-handoff.ts:228), so the exporter asks for
history. Newest archive first, newest entry first inside each; the inner reversal is deliberate, because
`formatLogArchive` writes entries oldest first (project-doc.ts:267-274). The renderer splits an archive body
with `splitLogEntries` (project-doc.ts:210-225).

A conflicted project (`conflict: true`, two live heads) has null status, revision and date. Its row renders
slug, `conflict`, the fixed text `two live documents, not exported`, and empty cells; its `<slug>.md` is
neither written nor removed, and the result names it.

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
`commit-tree`, `update-ref`, `var`, `diff`, `diff-index` and `remote`. No `add`, `commit`, `status`,
`checkout`, `push`, `pull`, `fetch`, `clone`, `init`, `merge` or `tag` is constructed anywhere in the code,
and `remote` is only ever `remote -v` (Decision 4). The acceptance canary also runs `cat-file` to print what
was stored; that is a test verb, not part of the product path. Every invocation runs with this environment
and nothing else:

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
and equal the resolved path, and NorthKeep never runs `git init`); the path is inside `northkeepHome()`
(packages/core/src/platform.ts:7-9) or the vault file's directory, by prefix on a separator boundary; the
path is a NorthKeep checkout, detected by a `packages/core/package.json` naming `@northkeep/core`; or
`projects/` or any target is a symlink, by `lstat`, because `atomicWrite` would write through it by design.

**The temporary index, and the user's staged work.** `GIT_INDEX_FILE` points at a NorthKeep-owned index,
seeded by `read-tree HEAD`, never at `.git/index`, so the commit carries HEAD's tree plus the exported files
and whatever the user had staged is not in it. After `update-ref` the exporter reconciles the real index so
`git status` is not left lying. Nothing staged (`diff-index --cached --quiet HEAD` returned 0 before the
run): the temporary index is written inside `.git/` and renamed over `.git/index`, never copied over it, so
a crash cannot leave a half-written index; `update-index --refresh` then restores stat information, after
which `git status --short` is empty. Something staged: the real index is left alone except for one `update-
index --add --cacheinfo` per exported path, after which the user's staged change survives, is absent from
the export commit, and the exported paths agree with HEAD. Mutating `.git/index` is a real side effect,
stated here rather than hidden, and Decision 3's refusals are what make it safe: no path is written or
staged unless it is already NorthKeep's and already identical to HEAD.

There is no checkout step, so a smudge filter has nothing to run on: the working tree files are the ones
NorthKeep wrote. After each export, HEAD, the index and the files on disk agree for every exported path. A
second export of an unchanged vault makes `write-tree` return HEAD's own tree id and the exporter stops
before `commit-tree`; verified, no second commit. The first draft's `check-ignore` rule is dropped, because
`update-index --cacheinfo` adds a path whatever `.gitignore` says.

## Decision 3: Ownership by header, not bytes (project-export.ts)

Every generated file opens with one HTML comment, nothing before it:

```
<!-- northkeep: vault <vault_id> project <slug> revision <revision_id> kind document
     The vault is canonical. This file is regenerated. Edits here are not read back. -->
```

`kind` is `document`, `log` or `index`. A `kind log` header names the same vault id and slug and the
project's current revision id at render time, so it classes exactly like the document. `INDEX.md` is derived
from every project, so its header names the vault id and `kind index` with no slug and no revision, and
`ownershipOf` classes it by vault id alone. `vault_id` and `revision` come from `ProjectView` (project-
handoff.ts:232, the head row's id). `ownershipOf(file, view)` returns one of three classes.

1. **Ours.** The header parses, the vault id matches, the slug matches, and the revision id is this
   project's current `revision` or one of the ids in `ProjectView.revisions` (project-handoff.ts:229).
   Overwrite.
2. **Foreign vault or unknown revision.** The header parses but names another vault, or a revision in
   neither place. Refused and reported: NorthKeep cannot prove it wrote it.
3. **No header.** Not NorthKeep's. Refused and reported, unless the run passes `--adopt`, which calls
   `backupOnce` (fs-safe.ts:17-22) to copy the file to `<name>.northkeep-bak` before the first overwrite.
   `backupOnce` only backs up when no backup exists, so a second adopt cannot overwrite the pristine copy.

A class 1 file whose bytes differ from a fresh render of the **current** revision is simply stale, the
normal case after another device wrote, and it is overwritten. Byte comparison is not an ownership test and
is not used as one. Hand edits are therefore possible only on files NorthKeep owns, and NorthKeep overwrites
them by design; git history is the recovery, which is true here because every previous state was committed
by NorthKeep in the same run that wrote it.

One case is a real loss: a hand edit made after the last export and before the next, on an owned file, never
committed. Before writing any owned file the exporter runs `git diff --quiet HEAD -- <file>` **and** `git
diff-index --cached --quiet HEAD -- <file>`, and refuses that file by name when either differs. The second
check catches a file the user staged and then reverted in the working tree, which the first alone reads as
clean. Nothing uncommitted is ever overwritten.

## Decision 4: Remotes (git-plumbing.ts, `readRemotes`)

On first configure the exporter prints the repository's remote list, names and URLs from `git remote -v`,
with the resolved path and the project counts, and stores that list in `export.json` under `NORTHKEEP_HOME`
after the user confirms. On every export it re-reads `git remote -v` and compares. A remote added, removed
or re-pointed since the confirmation refuses the **whole** export, not one file, until the user re-confirms.
NorthKeep never adds, removes, renames or pushes a remote, and no code path constructs `push`, `fetch`,
`pull` or `remote add`.

## Decision 5: Round trip (project-export.ts, import side)

`<slug>.log.md` carries `kind log` and `INDEX.md` carries `kind index`, so NorthKeep's own export can be
imported back. Import reads the header first. `kind index` is skipped silently, because it is derived. `kind
log` reattaches its entries as ADR 0045 archive memories of the named slug, through the Decision 9 archive
path, and creates no project. `kind document` is an ordinary import of that slug. No header is an ordinary
import, the pre-NorthKeep case.

The header is never written into the vault. Import strips it from the parsed `preamble` (project-
doc.ts:101-126 keeps text before the first heading as preamble) before the document is stored, and strips
only that comment: an ADR 0052 draft line in the same preamble (`PROJECT_DRAFT_LINE_PREFIX`, project-
doc.ts:280-284) survives. A file that merely copies a NorthKeep header is indistinguishable from one
NorthKeep wrote, which is harmless, because import refuses an existing slug anyway.

## Decision 6: Caps in bytes (project-export.ts)

The export cap is 65,536 UTF-8 bytes per rendered file, measured as bytes and not characters, so accented
text is measured on what the file really holds. The number is a choice, not an inherited rule. It reuses the
row cap ADR 0045 (line 96) gives every row in a slug-valid project scope, which is the 65536-byte per-entry
cap ADR 0040 Decision 6 states (0040 lines 109-114); neither ADR says anything about files.
`projects/<slug>.md` cannot exceed it, because `PROJECT_DOC_MAX_CHARS` is 16,384 characters (project-
doc.ts:10), which reaches 65,536 bytes only in the pathological all-four-byte case; a document that somehow
renders larger is refused by name and the rest of the export proceeds.

`projects/<slug>.log.md` can exceed it and is **split into numbered parts**, `<slug>.log.1.md`,
`<slug>.log.2.md` and so on, each with its own `kind log` header, split on archive-entry boundaries so no
entry is cut. Refusing the project instead was rejected because `northkeep projects export` must be both
idempotent and total: a project whose log grew past a threshold would silently stop being mirrored, which is
the failure this ADR exists to prevent. Parts number from 1 with no zero padding. A part no longer needed is
unlinked from disk and dropped from the tree with `update-index --force-remove`, so HEAD, the index and the
files on disk still agree, and only a class 1 part is ever removed, so a foreign file of that name survives.
Nothing else is built: no read-back, no remote or push, no watcher, and no desktop surface in M-A.

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
is fixed text, because ADR 0052 Decision 1 stores `model: null` and no host exposes one. The trailing text
is `firstNonEmptyLine` of the completed work, or of Current Status for an update, cut to 72 characters with
control characters stripped. The message reaches git on `commit-tree`'s stdin, never as an argument and
never through a shell, for the reason packages/mcp-server/src/connect.ts:235-236 states about
`execFileSync`.

## Decision 8: Concurrency (project-export-run.ts, `acquireExportLock`)

One lock file per repository under `<NORTHKEEP_HOME>/export/`, keyed by a hash of the resolved repository
path, never inside the repository. It is created `wx`, holds the pid and a start timestamp, and is removed
in a `finally`. A second export waits up to 30 seconds, then reports that an export of that repository is
already running and does nothing. A lock whose pid is not alive is reclaimed; a lock NorthKeep did not
create is never removed. This is not the vault lock and is never held across a vault write.

## Decision 9: Import safety (project-export-run.ts, `importProjects`)

`northkeep projects import --from <dir> [--write]`. `--dry-run` is the default: without `--write` the
command prints the plan, per file its slug, section map, live document size, archive count and overflow yes
or no, and writes nothing. The source directory is opened read-only, nothing in it is written, renamed or
removed, and import spawns no git process. `*.md` in `<dir>`, non-recursive. A name whose stem fails
`PROJECT_SLUG_PATTERN` (project-doc.ts:15) is skipped and listed, which is how `INDEX.md` and a stray `notes
copy.md` are handled; NorthKeep's own `<slug>.log.md` is recognized by its header first (Decision 5) and
never reaches this test. Per importable file:

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
   (project-handoff.ts:226) and `isProjectLogArchive` (project-doc.ts:321-323) tests it. Only the provenance
   line differs. The newest `PROJECT_LOG_KEEP_ENTRIES` (10, project-doc.ts:18) stay live and the rest are
   archived, chunked under 65,536 UTF-8 bytes.
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
the confirmation. No secret. An absent file means the feature is off, the default. There is no default path.

## Decision 11: Privacy (stated, not enforced by code)

Unshared projects are exported, because they are the majority and a mirror that omitted them would be worse
than no mirror. The file is as private as the folder the user chose. Nothing leaves the machine: no network
call exists in either path, and a remote the user later pushes to is the user's own action through the
user's own git. Invariant #1 is unchanged, because it bounds what leaves the machine and export writes a
local file. Invariant #7 is unchanged: git is a program the user installed, so code NorthKeep did not write
does run, and what Decision 2 buys is that the repository cannot choose which code.

The "no plaintext on disk outside the vault" property is amended, for project scopes only, opt-in, at a path
the user chose. The sentence lives in the call log header (packages/mcp-server/src/log.ts:5-9). After M-A
the accurate statement is: NorthKeep writes memory plaintext outside the encrypted vault in exactly one
place, project documents mirrored to a git repository the user configured by path. The call log itself stays
content-free. KNOWN-LIMITS.md carries the amended sentence and the residuals below before this ships. Tier-1
return masking (ADR 0048) does not apply to the exported file: masking a mirror of the user's own vault to
the user's own disk would write corrupted text the user would read as real, and the Decision 4 confirmation
is what makes that a choice rather than an oversight.

## Threats

Each is a finding from one of the two reviews, with its mitigation and its residual.

**A program named at add time.** `.gitattributes` selects `filter.<name>.clean` or `.process` and git runs
it on `git add`, under the full `-c` override set. Executed on git 2.54: the process filter started and was
handed the document. Mitigated by never running `add`; `hash-object --no-filters` is the only path from disk
to an object, and with no checkout smudge never runs either. Residual: none found. This is why the design
changed.

**A program named at commit, index or ref time.** `.git/hooks`, `core.hooksPath`, `gpg.program`,
`core.sshCommand` and `core.fsmonitor` each run code as the user, and plumbing alone closes none of the
hooks: `post-index-change` fires on `update-index`, `reference-transaction` on `update-ref`. Mitigated by
the Decision 2 pins and an owned empty hooks directory. Residual: the pins are a list and a future git could
add a key; the verb allowlist bounds how far it would reach.

**The user's own `~/.gitconfig`.** `GIT_CONFIG_NOSYSTEM=1` alone leaves every key above in play through it.
Mitigated by `GIT_CONFIG_GLOBAL` on an owned empty file. Residual: a repository that relied on the global
identity now has none, and Decision 7 refuses it with the fix.

**A stale mirror that can never be healed.** Byte identity refused a file another device made stale,
forever, and ADR 0051 can blank the revision a header names. Mitigated by Decision 3, where ownership is the
revision chain and a stale owned file is overwritten. Residual: the visible chain is short, see Residual.

**A hand edit destroyed.** Mitigated by the two `diff` checks in Decision 3. Residual: an edit the user
committed is overwritten by the next export, by design, and is in git history. **`--adopt` with no backup**,
the second review's kill shot over 31 hand-written files. Mitigated by `backupOnce` on every adopted file
(fs-safe.ts:17-22). Residual: adopt still overwrites, and the backup is one copy per file.

**A remote added after the confirmation.** Reading `remote.origin.url` once at configure never saw it.
Mitigated by Decision 4's re-read on every export. Residual: NorthKeep cannot stop a hand push and does not
try.

**An export that does not round trip**, the first design dropping `<slug>.log.md` and `INDEX.md` on
re-import. Mitigated by Decision 5's `kind`. Residual: a reattached log is an archive with a new provenance
line, not the original row.

**An INDEX cell that forges a column.** Mitigated by escaping `|` (Decision 1). Residual: none. **Two
writers into one repository.** Mitigated by Decision 8's lock. Residual: a process on another machine
sharing the folder is not covered.

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
| No program named by repository, global or system config runs | `runGit`: the env and `-c` list in Decision 2, with `--no-filters` and an owned empty `core.hooksPath`; the canary repository in Acceptance step 2 |
| NorthKeep never creates a remote and never pushes | `runGit` rejects any verb outside the Decision 2 allowlist; a recording shim asserts the verbs seen across every trigger are a subset of it |
| An export refuses when a remote changed since the confirmation | `readRemotes` compared against `export.json` inside `exportProjects`, before any write |
| Export sends nothing off the machine | No network call in the path; test runs a full export with network syscalls stubbed to throw |
| A file NorthKeep cannot prove it wrote is never overwritten without `--adopt`, and never without a backup | `ownershipOf` classes 2 and 3; `backupOnce` on the `--adopt` path |
| A stale mirror is healed rather than refused | `ownershipOf` class 1, matching the header revision against `ProjectView.revision` and `revisions` |
| Nothing uncommitted is ever overwritten | `exportProjects` runs `diff --quiet HEAD` and `diff-index --cached --quiet HEAD` per owned file and skips that file |
| The user's staged work is never committed by an export | `plumbingCommit` seeds a temporary `GIT_INDEX_FILE` from `read-tree HEAD`; test stages an unrelated file and asserts it is absent from the commit and still staged after |
| Export refuses a repository with no commit identity, before writing | `requireCommitIdentity`: `git var GIT_COMMITTER_IDENT` under `-c user.useConfigOnly=true` |
| Export refuses a path that is not a work tree, is inside NORTHKEEP_HOME or the vault directory, or is a symlink | `exportProjects` preflight; one test per refusal asserts zero files written |
| A git failure never rolls back or blocks a vault write | Decision 10 ordering; test makes `update-ref` exit non-zero after a `project_wrap` and asserts the receipt and new head are unchanged |
| One export at a time per repository | `acquireExportLock` |
| Import modifies no source file and runs no git | `importProjects` opens the directory read-only; test hashes every source file before and after a 31-file import |
| Import drops nothing | `importProjects` steps 4 and 5; test imports a file over 16,384 characters and asserts every heading is in the document, an archive, or an `## Import overflow` memory |
| Import refuses an existing slug | `expected_revision: null` create path (ADR 0050); test asserts no write and that the other files still imported |
| No export header ever reaches the vault | `importProjects` strips it from the preamble; test round-trips an export and asserts no stored content contains `<!-- northkeep:` |
| Neither export nor import runs a model | No model call in either path; acceptance runs with Ollama stopped |

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
- **`.git/index` is written by the exporter** (Decision 2), reconciled by copy, not by merge.
- **Case-insensitive filesystems.** Two slugs differing only in case would collide on one file on APFS. The
  slug pattern is lowercase (project-doc.ts:15), so this is unreachable today.
- **Commit identity is git's.** NorthKeep never sets one and refuses when there is none.

## Acceptance (Jay, from the CLI)

Throwaway vault, throwaway repository, `NORTHKEEP_HOME` set on every command. Step 5 copies the command repo
and never touches the real one.

```bash
export NORTHKEEP_HOME=$(mktemp -d); LAB=$(mktemp -d); R=$LAB/mirror
export NK=~/Claude/Projects/NorthKeep/northkeep/packages/cli/dist/index.js
mkdir -p $R && git -C $R init -q
git -C $R config user.email you@example.com && git -C $R config user.name Jay
node $NK init && node $NK projects export --repo $R   # prints path, remotes, counts; asks once
```

1. **Byte-identical double export.** `cp -R $R/projects $LAB/a`, export again, `diff -r $LAB/a $R/projects`
   is silent, `git -C $R log --oneline | wc -l` is still 1, `git -C $R status --short` is empty.
2. **Nothing the repo names ever runs.** Run the canary script below. It prints `(none)`.
3. **A hand edit is refused.** `echo "note to self" >> $R/projects/demo.md`, then export: that file is
   refused by name, the edit intact, the other projects exported. `git -C $R add projects/demo.md` and
   export again: still refused, by the staged check. Commit it and export: overwritten, and `git -C $R show
   HEAD~1` still has the edit.
4. **A headerless file, and adopt with a backup.** `echo hi > $R/projects/stranger.md`, export: refused and
   named. `node $NK projects export --adopt`: overwritten, and `$R/projects/stranger.md.northkeep-bak` holds
   `hi`.
5. **A copy of the command repo, imported then adopted.** `cp -R ~/Claude/Projects/Command\ Repo $LAB/cr`,
   and work only in `$LAB/cr`. `node $NK projects import --from $LAB/cr/projects` prints a 31-row plan and
   writes nothing, and `git -C $LAB/cr status --short` stays empty. Re-run with `--write`, then `node $NK
   projects export --repo $LAB/cr --adopt`, and confirm every overwritten file has a `.northkeep-bak` beside
   it.
6. **A remote added after the confirmation.** `git -C $R remote add mirror $LAB/bare.git`, then export: the
   whole run refuses and asks to re-confirm. Re-confirm, export, and `git -C $R log --oneline` shows the new
   commit with no push.
7. **Refusals, each writing nothing:** a path inside `$NORTHKEEP_HOME`, a path that is not a work tree, a
   repository with `user.email` unset, a symlinked `projects/`, and a second export while one is running.
8. **A staged file is not committed.** `echo x >> $R/README.md && git -C $R add README.md`, run a `projects
   update`, and confirm `git -C $R show --stat HEAD` does not list README.md while `git -C $R status
   --short` still shows it staged.
9. **Git failure is not fatal.** Point the exporter at a repository whose `.git` is read-only, run a
   `projects update`, and confirm the vault head changed and the CLI reported the export skipped.
10. **Zero model tokens.** Stop Ollama and repeat steps 1 and 5.

The canary script for step 2 builds a hostile repository and runs the exact Decision 2 sequence against it.

```bash
#!/bin/bash
set -u; LAB=$(mktemp -d); R=$LAB/repo; F=$LAB/fired; N=$LAB/nkhome; C=$LAB/c
mkdir -p $R $N/hooks $LAB/hk; : > $N/empty.gitconfig; : > $F
printf '#!/bin/sh\necho "FIRED $0 $*" >> %s\ncat > /dev/null\nexit 0\n' $F > $C; chmod +x $C
git -C $R init -q; git -C $R config user.name O; git -C $R config user.email o@e.invalid
for h in pre-commit post-commit commit-msg prepare-commit-msg reference-transaction \
         post-index-change post-checkout post-rewrite fsmonitor-watchman; do
  cp $C $R/.git/hooks/$h; cp $C $LAB/hk/$h; done
# every program-naming key the two reviews listed, each pointing at the one canary
for k in core.fsmonitor core.sshCommand core.editor core.pager core.askPass core.gitProxy \
         core.alternateRefsCommand gpg.program diff.external sequence.editor ssh.variant \
         uploadpack.packObjectsHook credential.helper filter.nk.clean filter.nk.smudge \
         filter.nkp.process diff.nk.textconv merge.nk.driver trailer.nk.command; do
  git -C $R config $k $C; done
printf '[gpg]\n\tprogram = %s\n' $C > $R/.git/extra.config   # reached through include.path
for kv in "core.hooksPath $LAB/hk" "core.autocrlf true" "commit.gpgsign true" \
          "filter.nkp.required true" "include.path $R/.git/extra.config"; do
  git -C $R config $kv; done
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
echo "stored bytes:"; G cat-file -p HEAD:projects/demo.md
echo "canaries fired:"; cat $F; [ -s $F ] || echo "(none)"
```

Run on git 2.54.0 (Apple Git-157) while this draft was written: `(none)`, and the stored bytes were the
plaintext unchanged. The same repository under `git add` with the identical pins fired `filter.nkp.process`,
which hung on the filter handshake. Two caveats keep the claim no wider than the evidence. The keys
genuinely exercised are the filters, the hooks, `gpg.program`, `core.editor`, `diff.external` and
`core.fsmonitor`; `credential.helper`, `core.sshCommand`, `ssh.variant`, `core.gitProxy`, `protocol.ext` and
`uploadpack.packObjectsHook` are unreachable anyway, because no allowed verb touches a transport, and are
pinned as belt and braces. And `commit-tree` with `commit.gpgsign=true` and `gpg.program` on a canary, both
unpinned, signed nothing and fired nothing, so the gpg pins are not load-bearing either.

## Earlier drafts

**First review (2026-09-21, against the design). NOT CLEARED.** Eight citations pointed at the wrong lines,
itself the finding: a reader checking the design checked nothing. Hooks were not the only program a
repository names (`gpg.program`, `core.sshCommand`, `core.fsmonitor`), and `GIT_CONFIG_NOSYSTEM=1` left
`~/.gitconfig` in play. The invariant-7 wording read as "no code runs". `git status --porcelain` was not an
ownership test in either direction, and nothing refused a file NorthKeep did not write, so the first export
into the command repo would have overwritten 31 hand-written files. "64 KiB" was unstated as bytes or
characters. `.gitignore` could drop `projects/` silently, and a repository with no commit identity would
fail at `commit` with the files already on disk. An INDEX cell holding `|` forged a column. `<slug>.log.md`
was read from `ProjectView.archives`, empty without `history: true`. Two writers could export at once.

**Second review (2026-09-21, against the amended design, with a real git). NOT CLEARED.** Kill shots: a
`.gitattributes` filter ran on `add` under the full override set and was handed the plaintext; `--adopt`
kept no backup; the header test could not heal a mirror another device left stale, and compaction could
blank the revision the header named. Flesh wounds: re-importing NorthKeep's own export dropped
`<slug>.log.md` and `INDEX.md`; `remote.origin.url` was read only at configure; the header was
indistinguishable from a copy on import; `serializeProjectDoc` returns no trailing newline; one more stale
citation. The review required a third draft listing plumbing writes, `backupOnce` on adopt, remote re-
checks, revision-chain ownership, round-tripping headers, and stripping the header on import. This draft
answers each.