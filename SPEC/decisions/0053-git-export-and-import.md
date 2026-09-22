# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Third draft, pending adversarial review. The first two drafts were
  reviewed on 2026-09-21 and were NOT CLEARED twice. This draft is a redesign,
  not an amendment: files are now written by git plumbing, ownership is decided
  by a header rather than by bytes, and remotes are re-checked on every run.
  Nothing is built.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0045 (log rolling),
  ADR 0048 (revision-bound handoffs), ADR 0051 (compaction), ADR 0052
  (provenance and draft projects)
- **Does not touch:** egress, redaction tiers, crypto or key handling, the row
  envelope, sync, the connector, the vault schema. No model runs in any path
  here. No new runtime dependency: git is an external program the user already
  installed, spawned, never linked. Said plainly, because the hardening below
  can read as more than it is: git is a program, NorthKeep runs it, and code
  does run. The invariant-7 argument is "no new networked dependency", not "no
  code runs".

## Context

A project document lives as one `working` memory per `project:<slug>` scope.
Jay's working record before NorthKeep was a git repository of Markdown files,
still what he reads outside an agent session, and the two do not meet: the vault
is the truth and the repository is stale. The vault already holds everything the
repository held. `getProjectView` (packages/core/src/project-handoff.ts:219-233)
returns the parsed document with its prior revisions and Log archives, and
`listProjectViews` (project-handoff.ts:254-257) returns one summary row per
project, sorted by slug (line 256). That is the index. Missing: a renderer, and
a way to bring an existing folder of Markdown files in.

Two constraints shape everything below. The vault is canonical, so a mirror
editable back into it would be a second source of truth and a merge problem, and
this ADR refuses to build one. And NorthKeep has written no memory plaintext
outside the encrypted vault, as the call log header says
(packages/mcp-server/src/log.ts:5-9). Export amends that sentence deliberately,
in one narrow place.

Three new files are proposed. `packages/core/src/project-export.ts`: the pure
renderers and the header grammar (`renderProjectFile`, `renderLogFile`,
`renderIndexFile`, `parseExportHeader`, `ownershipOf`).
`packages/mcp-server/src/git-plumbing.ts`: the git runner
(`runGit`, `plumbingCommit`, `readRemotes`, `requireCommitIdentity`).
`packages/mcp-server/src/project-export-run.ts`: the orchestration
(`exportProjects`, `acquireExportLock`, `importProjects`).

## Decision 1: What is rendered, and where (project-export.ts)

A user-chosen repository path holds `projects/<slug>.md` (the live document as
the vault stores it, unmodified apart from the Decision 3 header),
`projects/<slug>.log.md` for a project with Log archives, and `INDEX.md`, one
row per project from `listProjectViews`.

The INDEX row is slug, state (`draft` or `active`), one-line status, updated
date, last writer host. `ProjectSummary` (project-handoff.ts:77) carries all
five, `last_writer_host` and `draft` having landed with ADR 0052, so this ADR
adds no field. Every cell escapes `|` as `\|` and collapses newlines to spaces,
so an agent-written status line holding a pipe cannot forge a column.
`ProjectSummary.status` is the whole Current Status body (project-handoff.ts:256
uses `getProjectSection(doc,'Current Status')||null`), so the renderer takes
`firstNonEmptyLine` (packages/core/src/project-doc.ts:153-159) and cuts to 120
characters with an ellipsis.

The same vault state renders byte-identical files. No generation timestamp
anywhere. Every date printed comes from a stored `created_at`, rendered
`YYYY-MM-DD` in UTC. Section order is the document's own, because the body is
the stored `content` verbatim. Row order is the slug order line 256 already
fixes. Line endings are `\n`, and the renderer appends the trailing newline that
`serializeProjectDoc` (project-doc.ts:137-146) does not return.

`<slug>.log.md` is rendered from the archive memories, which `getProjectView`
returns only under `history: true` (project-handoff.ts:228), so the exporter
asks for history. Newest archive first, newest entry first inside each; the
inner reversal is deliberate, because `formatLogArchive` writes entries oldest
first (project-doc.ts:267-274). The renderer splits an archive body with
`splitLogEntries` (project-doc.ts:210-225).

A conflicted project (`conflict: true`, two live heads) has null status,
revision and date. Its row renders slug, `conflict`, the fixed text `two live
documents, not exported`, and empty cells; its `<slug>.md` is neither written
nor removed, and the result names it.

## Decision 2: Plumbing writes (git-plumbing.ts)

NorthKeep writes every file itself with `atomicWrite`
(packages/mcp-server/src/fs-safe.ts:31-49), which resolves an existing file's
realpath and writes through it (lines 35-36) so no reader sees half a file. A
new mirror is chmodded `0o644` rather than the helper's `0o600` default (line
33), because a mirror lives in a repository the user may share.

Git never touches the working tree. The bytes on disk are recorded with
plumbing, in this order, all through `execFile` with an args array:

```
git read-tree HEAD                       # into a TEMPORARY index, see below
git hash-object -w --no-filters -- <abs path>     # per file
git update-index --add --cacheinfo 100644,<blob>,projects/<slug>.md
git write-tree
git rev-parse HEAD
git commit-tree <tree> -p <parent>       # message on stdin
git update-ref -m "northkeep export" HEAD <commit> <parent>
```

`--no-filters` is what stops a clean filter, and a temporary index plus an empty
`core.hooksPath` is what stops every hook. Those are two mechanisms, not one:
plumbing alone would still fire `reference-transaction` on `update-ref` and
`post-index-change` on `update-index`.

The verb allowlist is exactly: `rev-parse`, `read-tree`, `hash-object`,
`update-index`, `write-tree`, `commit-tree`, `update-ref`, `var`, `diff-index`,
`remote`, `cat-file`, `ls-tree`. No `add`, `commit`, `status`, `checkout`,
`push`, `pull`, `fetch`, `clone`, `init`, `merge` or `tag` is constructed
anywhere in the code. `remote` is only ever `remote -v` (Decision 4), and
`ls-tree` and `cat-file` are read-only.

Every invocation runs with this environment and nothing else:

```
PATH=/usr/bin:/bin   HOME=<NORTHKEEP_HOME>
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=<NORTHKEEP_HOME>/empty.gitconfig   (owned, zero bytes)
GIT_ATTR_NOSYSTEM=1  GIT_TERMINAL_PROMPT=0  GIT_OPTIONAL_LOCKS=0
GIT_ASKPASS=/usr/bin/false   SSH_ASKPASS=/usr/bin/false
GIT_INDEX_FILE=<NORTHKEEP_HOME>/export/<hash of repo path>.index
```

and these `-c` pins, which outrank repository config:

```
-c core.hooksPath=<NORTHKEEP_HOME>/hooks   (owned, empty directory)
-c core.fsmonitor=false  -c core.useBuiltinFSMonitor=false
-c gpg.program=/usr/bin/false  -c commit.gpgsign=false  -c tag.gpgsign=false
-c core.sshCommand=/usr/bin/false  -c credential.helper=
-c diff.external=  -c core.editor=/usr/bin/false  -c sequence.editor=/usr/bin/false
-c core.pager=cat  -c core.askPass=/usr/bin/false
-c core.gitProxy=  -c core.alternateRefsCommand=
-c core.autocrlf=false  -c core.safecrlf=false  -c core.symlinks=false
-c protocol.ext.allow=never  -c uploadpack.packObjectsHook=
-c user.useConfigOnly=true
```

`GIT_AUTHOR_*` and `GIT_COMMITTER_*` are not set, so the identity is the
repository's own (Decision 7). `-C <realpath of the repo>`, resolved with
`fs.realpathSync` before the first call, and the resolved path is what every
check and every invocation uses. Per invocation: a 10 second timeout, a bounded
`maxBuffer`, and never while the vault file lock is held.

Refusals before anything is written: the path is not a work tree
(`rev-parse --show-toplevel` must succeed and equal the resolved path, and
NorthKeep never runs `git init`); the path is inside `northkeepHome()`
(packages/core/src/platform.ts:7-9) or the vault file's directory, by prefix on
a separator boundary; the path is a NorthKeep checkout, detected by a
`packages/core/package.json` naming `@northkeep/core`; or `projects/` or any
target is a symlink, by `lstat`, because `atomicWrite` would write through it by
design.

**The temporary index, and the user's staged work.** `GIT_INDEX_FILE` points at
a NorthKeep-owned index, seeded by `read-tree HEAD`, never at `.git/index`. So
the commit carries HEAD's tree plus the exported files, and whatever the user
had staged is not in it. After `update-ref` the exporter reconciles the user's
real index so `git status` is not left lying:

- Nothing staged (`diff-index --cached --quiet HEAD` before the run returned 0):
  the temporary index is copied over `.git/index`, then `update-index --refresh`
  restores stat information. Verified: `git status --short` is empty afterwards.
- Something staged: the real index is left alone except for one
  `update-index --add --cacheinfo` per exported path. Verified: the user's
  staged change survives, is absent from the export commit, and the exported
  paths agree with HEAD.

Mutating `.git/index` is a real side effect and is stated here rather than
hidden. Decision 3's refusals are what make it safe: no path is written or
staged unless it is already NorthKeep's and already identical to HEAD.

There is no checkout step, so a smudge filter has nothing to run on: the working
tree files are the ones NorthKeep wrote. After each export, HEAD, the index and
the files on disk agree for every exported path. A second export of an unchanged
vault produces the same tree as HEAD, so `write-tree` returns HEAD's tree id, and
the exporter stops before `commit-tree`. Verified: no second commit.

`check-ignore` is deliberately dropped from the first draft's rules.
`update-index --cacheinfo` adds a path whatever `.gitignore` says, so the
refusal it justified no longer has a failure to prevent.

## Decision 3: Ownership by header, not bytes (project-export.ts)

Every generated file opens with one HTML comment, nothing before it:

```
<!-- northkeep: vault <vault_id> project <slug> revision <revision_id> kind document
     The vault is canonical. This file is regenerated. Edits here are not read back. -->
```

`kind` is `document`, `log` or `index`. `INDEX.md` names the vault id and
`kind index` only. `vault_id` and `revision` come from `ProjectView`
(project-handoff.ts:232, the head row's id). `ownershipOf(file, view)` returns:

1. **Ours.** The header parses, the vault id matches, the slug matches, and the
   revision id is this project's current `revision` or one of the ids in
   `ProjectView.revisions` (project-handoff.ts:229). Overwrite.
2. **Foreign vault or unknown revision.** The header parses but names another
   vault, or a revision id in neither place. Refused and reported. This is the
   file NorthKeep cannot prove it wrote.
3. **No header.** Not NorthKeep's. Refused and reported, unless the run passes
   `--adopt`, which calls `backupOnce` (fs-safe.ts:17-22) to copy the file to
   `<name>.northkeep-bak` before the first overwrite. `backupOnce` only backs up
   when no backup exists, so a second adopt cannot overwrite the pristine copy.

A file in class 1 whose bytes differ from a fresh render of the **current**
revision is simply stale, which is the normal case after another device wrote,
and it is overwritten. Byte comparison is not an ownership test and is not used
as one.

Hand edits are therefore possible only on files NorthKeep owns, and NorthKeep
overwrites them by design. Git history is the recovery, and that is true here
because every previous state was committed by NorthKeep in the same run that
wrote it.

One case is a real loss: a hand edit made after the last export and before the
next, on an owned file, never committed. Before writing any owned file the
exporter runs `git diff --quiet HEAD -- <file>` **and**
`git diff-index --cached --quiet HEAD -- <file>`, and refuses that one file with
a message naming it when either differs. The second check catches the file the
user staged and then reverted in the working tree, which the first alone reads
as clean. Nothing uncommitted is ever overwritten; the rest of the export
proceeds.

## Decision 4: Remotes (git-plumbing.ts, `readRemotes`)

On first configure, the exporter prints the repository's remote list, names and
URLs from `git remote -v`, together with the resolved path and the project
counts, and stores that list in `export.json` under `NORTHKEEP_HOME` after the
user confirms. On every export it re-reads `git remote -v` and compares. A
remote added, removed or re-pointed since the confirmation refuses the **whole**
export, not one file, and asks the user to re-confirm. NorthKeep never adds,
removes, renames or pushes a remote, and no code path constructs `push`,
`fetch`, `pull` or `remote add`.

## Decision 5: Round trip (project-export.ts, import side)

`<slug>.log.md` carries `kind log` and `INDEX.md` carries `kind index`, so
NorthKeep's own export can be imported back. Import reads the header first:

- `kind index`: skipped, silently, because it is derived.
- `kind log`: the entries are reattached as ADR 0045 archive memories of the
  named slug, through the Decision 8 archive path, and no project is created
  from that file.
- `kind document`: an ordinary import of that slug.
- No header: an ordinary import, the pre-NorthKeep case.

The header is never written into the vault. Import strips it from the parsed
`preamble` (project-doc.ts:101-126 keeps text before the first heading as
preamble) before the document is stored, and strips only that comment: an ADR
0052 draft line in the same preamble (`PROJECT_DRAFT_LINE_PREFIX`,
project-doc.ts:280-284) survives. A file that merely copies a NorthKeep header
is indistinguishable from one NorthKeep wrote, which is fine on import, because
import refuses an existing slug anyway.

## Decision 6: Caps in bytes (project-export.ts)

The export cap is 65,536 UTF-8 bytes per rendered file, measured as bytes and
not characters, so accented text is measured on what the file really holds. This
number is a choice, not an inherited constant: it mirrors the ADR 0045 project
scope row cap so one number governs both sides, and ADR 0045 does not itself say
anything about files.

`projects/<slug>.md` cannot exceed it: `PROJECT_DOC_MAX_CHARS` is 16,384
characters (project-doc.ts:10), at most 65,536 bytes in UTF-8 only in the
pathological all-four-byte case, and the header adds about 200 bytes. A document
that somehow renders larger is refused and named, and the rest of the export
proceeds.

`projects/<slug>.log.md` can exceed it, and is **split into numbered parts**,
`<slug>.log.1.md`, `<slug>.log.2.md` and so on, each with its own `kind log`
header, split on archive-entry boundaries so no entry is cut. The alternative,
refusing the project, was rejected because `northkeep projects export` must be
both idempotent and total: a project whose log grew past a threshold would
silently stop being mirrored, which is the failure this ADR exists to prevent.
Parts are numbered from 1 with no zero padding, and a part that is no longer
needed is deleted only when it is class 1 in Decision 3, so a stale part is
never left behind and a foreign file of the same name is never removed.

## Decision 7: Identity and commit messages (git-plumbing.ts)

Before anything is written, `requireCommitIdentity` runs
`git var GIT_COMMITTER_IDENT` under the Decision 2 environment, which includes
`-c user.useConfigOnly=true`. Verified: without that pin git invents a name and
email from the username and hostname; with it, a repository carrying no identity
exits 128 with "Committer identity unknown". NorthKeep refuses that export
before writing and names the two `git config` commands that fix it. NorthKeep
never sets `user.name` or `user.email`, and never passes `GIT_AUTHOR_*` or
`GIT_COMMITTER_*`. Because `GIT_CONFIG_GLOBAL` points at an empty file, a
repository that relied on `~/.gitconfig` must set its own.

The commit message subject is:

```
wrap: <slug> (<host>, model not exposed) - <first line of completed>
```

with `checkpoint:`, `update:` and `create:` as the analogues, and
`export: <n> projects (<host>)` for a full run. `<host>` is
`ProjectProvenance.host` from the head's ADR 0052 provenance block
(project-handoff.ts:45, read into `ProjectView.last_writer`, line 74). A write
with no block says `(unknown host)`. `model not exposed` is fixed text, because
ADR 0052 Decision 1 stores `model: null` and no host exposes one. The trailing
text is `firstNonEmptyLine` of the completed work, or of Current Status for an
update, cut to 72 characters with control characters stripped. The message
reaches git on `commit-tree`'s stdin, never as an argument, and never through a
shell, for the reason packages/mcp-server/src/connect.ts:234-235 states about
`execFileSync`.

## Decision 8: Concurrency (project-export-run.ts, `acquireExportLock`)

One lock file per repository, under `<NORTHKEEP_HOME>/export/`, keyed by a hash
of the resolved repository path, never inside the repository. It is created
`wx`, holds the pid and a start timestamp, and is removed in a `finally`. A
second export waits up to 30 seconds, then reports that an export of that
repository is already running and does nothing. A lock whose pid is not alive is
stale and is reclaimed; a lock NorthKeep did not create is never removed. The
lock is not the vault lock and is never held across a vault write.

## Decision 9: Import safety (project-export-run.ts, `importProjects`)

`northkeep projects import --from <dir> [--write]`. `--dry-run` is the default:
without `--write` the command prints the plan, per file its slug, section map,
live document size, archive count and overflow yes or no, and writes nothing.
The source directory is opened read-only, no file in it is written, renamed or
removed, and import spawns no git process at all.

`*.md` in `<dir>`, non-recursive. A name whose stem fails
`PROJECT_SLUG_PATTERN` (project-doc.ts:15) is skipped and listed, which is how
`INDEX.md` and a stray `notes copy.md` are handled; NorthKeep's own
`<slug>.log.md` is recognized by its header first (Decision 5) and so never
reaches this test. Per importable file:

1. Parse with `parseProjectDoc` (project-doc.ts:101-126), strip the header.
2. Map sections: the five known headings (project-doc.ts:25-31) to themselves,
   `Open Questions / Risks` to the `Open Questions` section ADR 0048 owns
   (`ProjectView.open_questions`, project-handoff.ts:65), `Blueprint` and
   `Links & Locations` verbatim, as `parseProjectDoc` and `serializeProjectDoc`
   already round-trip any extra heading (project-doc.ts:137-146).
3. Write through the revision-bound create path with `expected_revision: null`,
   which refuses when a live head exists (ADR 0050). An existing slug is refused
   by name, the run continues, and import never merges.
4. Log entries go in **oldest first** as ADR 0045 archive memories, written
   directly rather than by replaying `project_update`, which would stamp every
   entry with today's date (`datedBullet`, project-doc.ts:334-339). This needs
   one new core formatter, `formatImportedLogArchive(project, entries,
   sourceFile)`, emitting the same `## Log archive: <slug>` first line as
   `formatLogArchive` (project-doc.ts:20 and 267-274), because `getProjectView`
   finds archives by that prefix (project-handoff.ts:226) and
   `isProjectLogArchive` (project-doc.ts:321-323) tests it. Only the provenance
   line differs. The newest `PROJECT_LOG_KEEP_ENTRIES` (10, project-doc.ts:18)
   stay live and the rest are archived, chunked under 65,536 UTF-8 bytes.
5. Anything that still does not fit `PROJECT_DOC_MAX_CHARS` (16,384,
   project-doc.ts:10) becomes one `episodic` memory in the project scope headed
   `## Import overflow: <slug>`, naming the source file and which headings
   moved. Nothing is dropped, and every overflow is reported.

## Decision 10: Trigger and scope (project-export-run.ts)

The writer mirrors its own write, after the vault save succeeds and after the
vault lock is released: the MCP server after `project_wrap`,
`project_checkpoint`, `project_update` and `project_create`, and the CLI after
`northkeep projects update`, a new subcommand proposed here (`projects` today
has only `compact`, packages/cli/src/index.ts:881-893). A failure of the export
never fails the vault write: it is caught, and reported as a field in the tool
payload and on the CLI. `northkeep projects export` is the idempotent full
re-render; run twice it makes no second commit, because the tree is unchanged.
Desktop is not in M-A and gets the same hook behind a Projects-page control once
Jay approves a mock.

Export runs only when a repository is configured, in a new sidecar
`<NORTHKEEP_HOME>/export.json` beside `sync.json`
(packages/sync/src/config.ts:42-44) and `connector.json`
(packages/sync/src/connector-config.ts:31-33). It holds the resolved path, the
Decision 4 remote list, and the confirmation. No secret. An absent file means
the feature is off, which is the default. There is no default path.

## Decision 11: Privacy (stated, not enforced by code)

Unshared projects are exported, because they are the majority and a mirror that
omitted them would be worse than no mirror. The file is as private as the folder
the user chose. Nothing leaves the machine: no network call exists in either
path, and a remote the user later pushes to is the user's own action through the
user's own git.

- **Invariant #1 is unchanged.** It bounds what leaves the machine, and export
  writes a local file.
- **Invariant #7 is unchanged.** Git is a program the user installed, so code
  NorthKeep did not write does run. What Decision 2 buys is that the repository
  cannot choose which code. Nothing new reaches the network.
- **The "no plaintext on disk outside the vault" property is amended**, for
  project scopes only, opt-in, at a path the user chose. The sentence lives in
  the call log header (packages/mcp-server/src/log.ts:5-9). After M-A the
  accurate statement is: NorthKeep writes memory plaintext outside the encrypted
  vault in exactly one place, project documents mirrored to a git repository the
  user configured by path. The call log itself stays content-free. KNOWN-LIMITS.md
  carries the amended sentence and the residuals below before this ships.
- **Tier-1 return masking (ADR 0048) does not apply** to the exported file.
  Masking a mirror of the user's own vault to the user's own disk would write
  corrupted text the user would read as real. The Decision 4 confirmation is
  what makes that a choice rather than an oversight.

## Threats

Each is a finding from one of the two reviews, with its mitigation and what is
left over.

**A repository that names a program at commit time.** `.git/hooks`,
`core.hooksPath`, `gpg.program`, `core.sshCommand` and `core.fsmonitor` each let
a repository run someone's code as the user. Mitigated by the Decision 2 pins
and by an owned empty hooks directory. Residual: the pins are a list, and a
future git could add a key to it. The verb allowlist bounds how much a new key
could reach.

**A repository that names a program at add time.** `.gitattributes` selects
`filter.<name>.clean` or `.process`, and git runs it on `git add` under the full
override set. Executed on git 2.54 and confirmed: the process filter started and
was handed the document. Mitigated by never running `add`: `hash-object
--no-filters` is the only path from disk to an object, and there is no checkout,
so smudge never runs either. Residual: none found. This is the reason the design
changed.

**A repository that names a program at index and ref time.**
`post-index-change` fires on `update-index` and `reference-transaction` fires on
`update-ref`, so plumbing alone does not close hooks. Mitigated by the empty
`core.hooksPath`. Residual: none found.

**The user's own `~/.gitconfig`.** `GIT_CONFIG_NOSYSTEM=1` alone leaves it in
play, so every key above returns through it. Mitigated by `GIT_CONFIG_GLOBAL` on
an owned empty file. Residual: a repository that relied on the global identity
now has none, and Decision 7 refuses it with the fix.

**A stale mirror that can never be healed.** Byte identity refused a file
another device had made stale, forever, and ADR 0051 can blank the revision a
header names. Mitigated by Decision 3: ownership is the revision chain, and a
stale owned file is overwritten. Residual: the chain NorthKeep can see is short
(see Residual below).

**A hand edit destroyed.** Mitigated by the two `diff` checks in Decision 3,
which refuse any owned file that differs from HEAD in the working tree or in the
index. Residual: an edit the user made and committed is overwritten by the next
export, by design, and is in git history.

**`--adopt` over 31 hand-written files.** The second review's kill shot: no
backup. Mitigated by `backupOnce` on every file `--adopt` overwrites
(fs-safe.ts:17-22). Residual: `--adopt` still overwrites, and the backup is one
copy per file.

**A remote that appeared after the confirmation.** Reading
`remote.origin.url` once at configure never saw it. Mitigated by Decision 4's
re-read on every export, refusing the whole run. Residual: NorthKeep cannot stop
a user pushing by hand, and does not try.

**An export that does not round trip.** The first design dropped
`<slug>.log.md` and `INDEX.md` on re-import. Mitigated by Decision 5's `kind`.
Residual: a log reattached by import is an archive with a new provenance line,
not the original archive row.

**An INDEX cell that forges a column.** The status line is free text an agent
wrote. Mitigated by escaping `|` and collapsing newlines (Decision 1).
Residual: none found.

**Two writers into one repository.** Mitigated by Decision 8's lock. Residual: a
second process on another machine sharing the folder is not covered.

**Symlinked paths.** `atomicWrite` writes through an existing symlink by design
(fs-safe.ts:35-36). Mitigated by `realpathSync` on the repository and `lstat` on
`projects/` and each target. Residual: a directory swapped between the `lstat`
and the write is a race NorthKeep does not close.

**Git missing, or failing part way.** `execFile` fails with `ENOENT`. The vault
write is saved first (Decision 10), so any failure is reported and never fatal.
Files already written carry their header, so the next run recognizes them and
commits. Residual: a crash between `commit-tree` and `update-ref` leaves an
unreferenced commit, which git garbage-collects.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| Two exports of an unchanged vault produce byte-identical files and one commit | `renderProjectFile` / `renderIndexFile`: no timestamp, dates from stored `created_at`, slug order from project-handoff.ts:256; `exportProjects` stops when `write-tree` returns HEAD's tree |
| No program named by repository, global or system config runs | `runGit`: the env and `-c` list in Decision 2, with `--no-filters` and an owned empty `core.hooksPath`; the canary repo in Acceptance step 2 |
| NorthKeep never creates a remote and never pushes | `runGit` rejects any verb outside the Decision 2 allowlist; a recording shim asserts the verbs seen across every trigger are a subset of it |
| An export refuses when a remote changed since the confirmation | `readRemotes` compared against `export.json` in `exportProjects`, before any write |
| Export sends nothing off the machine | No network call in the path; test runs a full export with network syscalls stubbed to throw |
| A file NorthKeep cannot prove it wrote is never overwritten without `--adopt`, and never without a backup | `ownershipOf` classes 2 and 3; `backupOnce` on the `--adopt` path |
| A stale mirror is healed rather than refused | `ownershipOf` class 1, matching the header revision against `ProjectView.revision` and `revisions` |
| Nothing uncommitted is ever overwritten | `exportProjects` runs `diff --quiet HEAD` and `diff-index --cached --quiet HEAD` per owned file and skips that file |
| The user's staged work is never committed by an export | `plumbingCommit` seeds a temporary `GIT_INDEX_FILE` from `read-tree HEAD`; test stages an unrelated file and asserts it is absent from the export commit and still staged after |
| Export refuses a repository with no commit identity, before writing | `requireCommitIdentity`: `git var GIT_COMMITTER_IDENT` under `-c user.useConfigOnly=true` |
| Export refuses a path that is not a work tree, or is inside NORTHKEEP_HOME or the vault directory, or is a symlink | `exportProjects` preflight; one test per refusal asserts zero files written |
| A git failure never rolls back or blocks a vault write | Decision 10 ordering; test makes `update-ref` exit non-zero after a `project_wrap` and asserts the receipt and new head are unchanged |
| One export at a time per repository | `acquireExportLock` |
| Import modifies no source file and runs no git | `importProjects` opens the directory read-only; test hashes every source file before and after a 31-file import |
| Import drops nothing | `importProjects` steps 4 and 5; test imports a file over 16,384 characters and asserts every heading is in the document, an archive, or an `## Import overflow` memory |
| Import refuses an existing slug | `expected_revision: null` create path (ADR 0050); test asserts no write and that the other files still imported |
| No export header ever reaches the vault | `importProjects` strips it from the preamble; test round-trips an export and asserts no stored content contains `<!-- northkeep:` |
| Neither export nor import runs a model | No model call in either path; acceptance runs with Ollama stopped |

## What this deliberately does not build

No read-back: a hand edit never becomes a vault write, and import is a separate
command. No remote, push, pull, `git init`, branch, tag, merge handling or file
watcher. No mirroring of memories outside project scopes, and none of superseded
revisions. No desktop or mobile surface in M-A, no per-project opt-out, no
redaction, no recursive or zip import, no other format.

## Residual (documented, accepted)

- **The ownership horizon is about five revisions.** ADR 0051 Decision 4
  compacts automatically on every project write, keeping the newest five
  revisions plus any a handoff receipt names and blanking the rest with
  `forgotten_at`. `getProjectView` filters forgotten rows out
  (project-handoff.ts:224) before building `revisions`
  (project-handoff.ts:229), so `PROJECT_REVISION_SUMMARY_LIMIT` (20,
  project-handoff.ts:24) is not the real reach. A mirror more than about five
  writes stale reads as class 2, unknown revision, and is refused and reported.
  `--adopt`, which backs the file up first, is the escape.
- **Archives beyond 20 are not mirrored.** `getProjectView` slices archives at
  the same limit (project-handoff.ts:228), so a project with more loses its
  oldest from the log files. They stay in the vault.
- **The mirror is stale between writes from other devices**, and the plaintext
  is readable by anything that can read the folder: Spotlight, Time Machine, a
  cloud folder sync, or a remote the user later pushes to.
- **A conflicted project is never exported**, and its last good `<slug>.md`
  stays on disk, older than its header says. The INDEX row says `conflict`.
- **`.git/index` is written by the exporter.** Stated in Decision 2. A user who
  runs `git add -p` during an export sees the lock, not a corrupt index, but the
  two indexes are reconciled by copy and not by merge.
- **Case-insensitive filesystems.** APFS is case-insensitive by default, so two
  slugs differing only in case would collide on one file. The slug pattern is
  lowercase (project-doc.ts:15), so this is unreachable today.
- **Commit identity is git's.** NorthKeep never sets one and refuses when the
  repository has none.
