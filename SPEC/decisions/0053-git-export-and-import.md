# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Accepted for build (M-A1, local mirror), pending code review. On 2026-09-22 Jay split the
  design after the seventh-draft recheck; the GitHub push moved to ADR 0055 (draft).
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0045 (log rolling), ADR 0048 (revision-bound
  handoffs), ADR 0051 (compaction), ADR 0052 (provenance)
- **Review gate:** M-A1 trips the gate on filesystem writes outside the vault and on spawning git over a
  repository the user chose, and on the claims it publishes. It does not change what leaves the machine: no
  push, fetch or network call exists in M-A1. Not touched: egress, the vault schema, crypto or key handling,
  redaction tiers, sync, the connector. No model runs in any path here.

## Context

A project document lives as one `working` memory per `project:<slug>` scope. Jay's record before NorthKeep
was a git repository of Markdown files. `getProjectView` (packages/core/src/project-handoff.ts:219-233)
returns the parsed document with prior revisions and Log archives, and `listProjectViews`
(project-handoff.ts:254-257) returns one summary row per project, sorted by slug (line 256). Missing: a
renderer, a git-versioned human-readable copy, and a way to bring an existing folder in.

**Jay's decisions, 2026-09-22.** The scope cut: "I want to do B but ensure we still have an accurate
mirror/backup." Jay is connecting Grok Bot to NorthKeep through MCP, so no agent reads the mirror for current
state; the mirror is a human-readable, git-versioned backup, exported on demand into a folder NorthKeep owns.
After the seventh-draft recheck Jay decided: **"Split it."** M-A1, this ADR, is import plus the local mirror,
built now. M-A2, the push to GitHub with its standing consent, confirmation hold and exclusion, returns to
design in ADR 0055.

Files. `packages/core/src/project-export.ts` (pure): `renderProjectFile`, `renderLogFile`,
`renderIndexFile`, `renderMarkerFile`, `parseExportHeader`, `summarizeMirror`.
`packages/mcp-server/src/git-plumbing.ts`: `runGit`, `plumbingCommit`, `readRemotes`,
`requireCommitIdentity`. `packages/mcp-server/src/fs-safe.ts` gains `writeMirrorFile`.
`packages/mcp-server/src/project-export-run.ts`: `exportProjects`, `verifyMirror`, `classifyTarget`,
`readJournal`, `writeJournal`, `readExportState`, `writeExportState`, `readMirrorSummary`,
`acquireExportLock`, `installSchedule`, `importProjects`. Decisions 2, 3 and 6 are evidenced by
`scripts/adr-0053-canary.sh`.

## Decision 1: What is rendered, and where (project-export.ts)

The mirror holds `projects/<slug>.md` (the stored document plus the Decision 3 header),
`projects/<slug>.log.md` for a project with Log archives, `INDEX.md` (one row per project from
`listProjectViews`), and the root marker `.northkeep-mirror` (Decision 4). Every project is exported
(Decision 5).

The INDEX row is slug, state (`draft` or `active`), one-line status, updated date, last writer host, all on
`ProjectSummary` (project-handoff.ts:77). Cells escape `|` and collapse newlines, so a status line cannot
forge a column. The status is the whole Current Status body (project-handoff.ts:256), so the renderer takes
`firstNonEmptyLine` (packages/core/src/project-doc.ts:153-159) and cuts to 120 characters.

The same vault state renders byte-identical files: no generation timestamp, dates from stored `created_at`
as `YYYY-MM-DD` UTC, the document's own section order, slug order, `\n` endings, and the trailing newline
`serializeProjectDoc` (project-doc.ts:137-146) does not return. Log files come from archives, which
`getProjectView` returns only under `history: true` (project-handoff.ts:228); newest archive first, newest
entry first, because `formatLogArchive` writes oldest first (project-doc.ts:267-274), split with
`splitLogEntries` (project-doc.ts:210-225). A conflicted project (two live heads) renders slug, `conflict`
and `two live documents, not exported`; its file is neither written nor removed.

## Decision 2: Plumbing writes (git-plumbing.ts)

**The mirror writer.** `atomicWrite` (packages/mcp-server/src/fs-safe.ts:31-49) writes through an
existing file's realpath (lines 35-36), keeps its mode or uses `0o600` (line 33), and writes a fixed temp
name with a plain `writeFileSync` (lines 41-43), which follows a symlink planted there. The contract
installer and `connect.ts` use it, so it stays unchanged. A new `writeMirrorFile(target, bytes)` beside it
resolves nothing. At the start of each run, before any write, it deletes NorthKeep's own stale temps: in each
directory it writes, entries matching exactly `<name>.northkeep-tmp-<16 lowercase hex>` whose `lstat` is a
regular file or a symlink are unlinked, and `unlink` never follows a link. Per write it draws 8 random bytes
for a fresh suffix, refuses if `lstat` finds anything at that temp path, opens it with
`fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)`, which fails if anything, a symlink
included, exists there, then `fchmodSync(fd, 0o644)` against the umask, write, `fsyncSync`, close, and
`renameSync(tmp, target)`. On error it unlinks only the temp it created. So a write killed mid-way leaves one
temp that the next run removes before writing: crash residue heals without a human. Mirror files are
`0o644` because this function sets it. Files under `<NORTHKEEP_HOME>/export/` (a `0o700` directory) use
`atomicWrite` and keep `0o600`. `<key>` is the mirror id: a lowercase v4 UUID written into the marker file at
the first export (a marker from before the id existed gets one on its next export, in one commit). It names
the journal and the state file, so a moved mirror folder keeps its history. Each run's temporary index is
its own file, `<key>.<run nonce>.index`, removed by the run that created it.

Git never touches the working tree. Per file, NorthKeep renders the bytes, hashes them, journals the blob id,
then writes. All through `execFile` with an args array:

```
git worktree list --porcelain                   # refuse if HEAD's branch is checked out elsewhere
git read-tree HEAD                              # into a TEMPORARY index
git hash-object --no-filters -- <abs path>      # classifyTarget's diskBlob (Decision 3)
git hash-object -w --no-filters --stdin         # the rendered bytes; journaled, then the file is written
git hash-object --no-filters -- <abs path>      # must equal the journaled blob, or the target is refused
git update-index --add --cacheinfo 100644,<blob>,<path>
git write-tree ; git rev-parse HEAD
git commit-tree <tree> -p <parent>              # message on stdin
git update-ref -m "northkeep export" HEAD <commit> <parent>   # old value always passed
```

`--no-filters` stops a clean filter; an owned empty `core.hooksPath` stops `reference-transaction` and
`post-index-change`. `update-ref` carries the old value, so a concurrent commit loses the race; the no-old-
value form is used only on an unborn HEAD. The local verb allowlist is exactly `rev-parse`, `read-tree`,
`hash-object`, `update-index`, `write-tree`, `commit-tree`, `update-ref`, `ls-tree`, `worktree` (only `list
--porcelain`), `var` and `remote` (only `-v`, for `--status`). No `add`, `commit`, `status`, `diff`,
`checkout`, `init`, `merge`, `tag`, `push`, `fetch` or `ls-remote` is constructed in M-A1. Every local
invocation runs with this environment and nothing else:

```
PATH=/usr/bin:/bin   HOME=<NORTHKEEP_HOME>
GIT_CONFIG_NOSYSTEM=1   GIT_CONFIG_GLOBAL=<NORTHKEEP_HOME>/empty.gitconfig  (owned, zero bytes)
GIT_ATTR_NOSYSTEM=1  GIT_TERMINAL_PROMPT=0  GIT_OPTIONAL_LOCKS=0
GIT_ASKPASS=/usr/bin/false   SSH_ASKPASS=/usr/bin/false   GIT_NO_REPLACE_OBJECTS=1
GIT_INDEX_FILE=<NORTHKEEP_HOME>/export/<key>.<run nonce>.index   (omitted only for the reconcile, below)
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

`-C` takes the repository realpath from `fs.realpathSync`. Per invocation: a 10 second timeout, a bounded
`maxBuffer`, never while the vault file lock is held. Git 2.31 or newer, for `--path-format=absolute`.
`GIT_NO_REPLACE_OBJECTS=1` matters: a review planted a replace ref on the current blob and tree, and verify
reported `matches` on foreign bytes; with it set, git reads the real objects. M-A1 never names a remote, so a
legacy `.git/remotes` or `.git/branches` file has nothing to redirect; the canary keeps that as a guard.

**Preflight,** before any write, each refusing the whole run: the path is not a work tree (`rev-parse
--show-toplevel` must equal it); it is bare; it is inside `northkeepHome()`
(packages/core/src/platform.ts:7-9) or the vault's directory, or is a NorthKeep checkout; Decision 4's
marker check fails; `worktree list --porcelain` shows HEAD's branch checked out in another worktree; or
`<git-dir>/index.lock` exists, the git dir from `rev-parse --path-format=absolute --git-dir`, which in a
linked worktree is `.git/worktrees/<name>`, where that worktree's index and lock live. That refusal names
the file and says to remove it once no git process runs; NorthKeep never removes it. The lock is checked
again before `update-ref`; if it appeared, the run stops there, HEAD unmoved, the files journaled residue.

**Per-target containment,** per file before it is written, refusing that target and continuing: anything at
the write's unique temp path (`lstat` succeeds); a symlink in any component; a target that is not a
regular file or has `st_nlink` above 1; `ls-tree HEAD -- projects` mode 160000 or a `.git` under
`projects`; `realpath(dirname(target))` outside `realpath(repo)` plus a separator. Each refusal is fixed
text naming the check and the fix, for example "projects/ is a symlink; NorthKeep exports only into a real
directory inside the repository".

**The temporary index and the root commit.** `GIT_INDEX_FILE` is seeded by `read-tree HEAD`, so a commit
carries HEAD's tree plus NorthKeep's paths and nothing the user staged. On an unborn HEAD the index is
seeded with `read-tree --empty`, `commit-tree` has no parent, and `update-ref` no old value.

**The reconcile.** After `update-ref`, one `update-index --add --cacheinfo` per exported path runs without
`GIT_INDEX_FILE`, so git picks the index (a linked worktree's is `.git/worktrees/<name>/index`). It runs on
every run that passes preflight, including a no-change run, so an index an earlier run could not refresh is
refreshed by the next. Only a lock that appears after the second check can make it fail, after `update-ref`
landed; nothing is rolled back, and the run reports "committed; working index not refreshed". A `git
checkout .` over that stale index restores an earlier export, which the journal set recognizes. The
reconcile expands a sparse index, a residual. An unchanged vault makes `write-tree` return HEAD's tree and
the run stops before `commit-tree`: no second commit.

## Decision 3: Ownership by header and journal set (project-export-run.ts, `classifyTarget`)

Every generated file opens with one HTML comment, nothing before it:

```
<!-- northkeep: vault <vault_id> project <slug> revision <revision_id> kind document
     The vault is canonical. This file is regenerated. Edits here are not read back. -->
```

`kind` is `document`, `log`, `index` (vault id, no slug) or `marker` (vault id, no slug); the values come
from `ProjectView` (project-handoff.ts:232). The revision id is for a human and is never an ownership test.

**The journal** is `<NORTHKEEP_HOME>/export/<key>.json`: per path, the last ten blob ids NorthKeep wrote
there, newest first. After `hash-object -w --stdin` and before the write, a blob already present moves to
the front, a new one is prepended, and the list is cut to ten, so unchanged runs never evict history.
Written with `atomicWrite` at `0o600`. An unparseable file, another version, realpath or vault reads as
empty. Entries for removed paths are kept.

```json
{ "version": 1, "repo": "<realpath>", "vault_id": "<uuid>",
  "paths": { "projects/demo.md": ["<newest blob>", "...", "<oldest of at most 10>"] } }
```

**The rule.** `classifyTarget(target, { diskBlob, journalBlobs, vaultId, slug })`: a target is **ours**
when its header names this vault id (and slug for `document` and `log`) and `diskBlob` is in
`journalBlobs`. Anything else is a **hand edit**, refused and reported by name, and the run continues. A
missing file is written. HEAD is not an ownership input: in a folder NorthKeep owns, a file the user
committed is still a file NorthKeep did not write. Nothing is ever adopted. The refusal's fix is "move or
delete the file; NorthKeep then writes it fresh"; its old content stays in git history.

**What heals without a human.** Crash residue (journaled before the write; a killed write's temp is removed
by the next run), a `checkout .` over a stale
index, a `reset --hard` or restored mirror within the last ten writes of the path. Preflight refuses while
a lock exists, so the index lags HEAD by at most one export and its blob is among the newest two journal
entries. **Accepted edge:** a hand-typed file byte-identical to a former render is overwritten; the bytes
are NorthKeep's own.

## Decision 4: A folder NorthKeep owns (project-export-run.ts, `exportProjects`)

The user runs `git init` on an empty folder; NorthKeep never does. The first `northkeep projects export
--repo <path>` requires the working tree to hold nothing but `.git` (`readdirSync` returns exactly `.git`)
and HEAD to be unborn, and writes `.northkeep-mirror` at the root, rendered by `renderMarkerFile` with a
`kind marker` header naming the vault id, journaled and committed like every other file. Every later export
refuses the whole run when the marker is absent, unparseable, or names another vault, with the fix
("restore it with `git checkout -- .northkeep-mirror`, or start a new mirror in an empty folder").

NorthKeep writes only `projects/`, `INDEX.md` and the marker. A file there it did not write is a hand edit
(Decision 3). Files the user adds elsewhere are never read, written or committed by NorthKeep: the
temporary index is seeded from HEAD and only NorthKeep's paths are added. Export runs only when the
Decision 5 settings file names a repository; absent means off.

## Decision 5: Every project, one settings file, written under the lock

**Every project is exported.** M-A1 has no confirmation hold and no per-project exclusion. Those exist
because content pushed to GitHub is irreversible; a local mirror is as private as the folder the user chose,
like any file on this Mac. Exclusion and confirmation are born in ADR 0055, with the push.

**The settings file** is `<NORTHKEEP_HOME>/export.json`: the resolved repository path and nothing else, no
secret. Export state lives in the Decision 7 state file. Both are written only by `exportProjects`, the
first configuration included, and only while it holds the Decision 9 lock in the repository's common dir,
so two writers cannot race. `atomicWrite` at `0o600`. It lives outside the vault, so no sync, restore or
import writes it. Missing means unconfigured; unreadable refuses the run and names the file.

**Invariants.** M-A1 needs no amendment to invariant #1: nothing leaves the machine. The one sentence it
amends is the call log header's "memory content is never written to disk outside the encrypted vault"
(packages/mcp-server/src/log.ts:5-9): for project scopes only, opt-in, at a path the user chose.
KNOWN-LIMITS.md carries the amended sentence before this ships.

## Decision 6: Verify (project-export-run.ts, `verifyMirror`)

`northkeep projects export --verify` is read-only: no git writes, no file writes, no journal or state
writes, no export lock. It renders every project and reports each path as **matches** (disk,
HEAD and render equal), **uncommitted export** (disk equals the render, HEAD older, both NorthKeep's),
**stale** (disk and HEAD are NorthKeep's but differ from the render), **missing**, **extra** (a
`projects/*.md` for no project), or **hand edit** (disk or HEAD in no journal entry and not the
render). A conflicted project reports `conflict`. Exit 0 only when every path matches. Its git
calls are `hash-object --no-filters --stdin` on the render, `rev-parse HEAD:<path>`, `hash-object
--no-filters -- <path>` and `ls-tree HEAD -- projects/`, under Decision 2's environment; the canary runs
this sequence and fails if any file under the repository, its git dirs or `NORTHKEEP_HOME` changed.

## Decision 7: Staleness and status (project-export.ts, project-export-run.ts)

The state file, `<NORTHKEEP_HOME>/export/<key>.state.json`, `atomicWrite` at `0o600` after every run:

```json
{ "version": 1, "repo": "<realpath>", "vault_id": "<uuid>",
  "last_success": { "at": "<ISO>", "commit": "<id>" }, "last_attempt": { "at": "<ISO>", "by": "cli|schedule" },
  "last_failure": { "at": "<ISO>", "code": "<code>" }, "refused": [ { "path": "...", "reason": "hand edit" } ],
  "projects": { "<slug>": { "revision": "<id>", "exported_at": "<ISO>" } },
  "nk_commits": ["<every commit id NorthKeep created, oldest first>"] }
```

`northkeep projects export --status` prints the repository, last successful export time and commit,
projects changed since (current revision differs from `projects`), refused paths, the last failure, and any
remote the repository has, with "NorthKeep never pushes; a push you make publishes the mirror".
`nk_commits` records every NorthKeep commit unconditionally, which ADR 0055 requires.

`summarizeMirror(state, summaries, now)` is pure and returns one line: "mirror last exported <time>; N
projects changed since", plus "; last export failed <time>" when true. `readMirrorSummary(vault,
granted)` reads `export.json` and the state file only, never runs git, takes revisions from
`listProjectViews(vault, granted)`, and counts only projects in the caller's granted scopes, so a narrow
grant learns nothing about other projects. It returns null when no mirror is configured. Callers:
`project_list` (packages/mcp-server/src/server.ts:605-615) and `project_resume` (server.ts:700-724) add
`mirror_status`; `GET /api/projects` (apps/web/src/projectsApi.ts:25-26) adds `mirror`, shown in
`projectsSummaryMeta` (apps/web/static/index.html:2154). Every string is fixed text, a time or a count: no
path, no git stderr. The hosted connector's `project_list` (apps/connector-server/src/mcp.ts:545) cannot
read this Mac's files and does not show the line; the connector has no `project_resume`.

## Decision 8: An optional schedule (project-export-run.ts, `installSchedule`)

`northkeep projects export --schedule hourly|daily|off`, macOS only, off by default, run by the user.
It writes or removes `~/Library/LaunchAgents/com.northkeep.mirror-export.plist` (`0o644`, no secret):
`ProgramArguments` are `process.execPath`, the CLI entry and `projects export --scheduled`; `StartInterval`
3600 or a daily `StartCalendarInterval`; `NORTHKEEP_HOME` when set; output to `/dev/null`. It loads with
`/bin/launchctl bootstrap gui/<uid> <plist>` and unloads with `bootout`. The job is a separate process
started by launchd, never inside an agent's write.

It needs the key `northkeep unlock` parks in the Keychain (packages/cli/src/index.ts:136-163).
`--scheduled` never prompts: it calls `resolveMasterKey` (packages/mcp-server/src/key.ts:22) itself and never
reaches `withVault`'s prompt (packages/cli/src/index.ts:1164-1167); with no key it records `last_failure`
`vault_locked` and exits. A busy vault lock, a refusal or a git error is recorded the same way, and the
staleness line shows it. A scheduled run commits locally and never pushes.

## Decision 9: Byte caps, identity, one commit per run, the lock

**Caps.** `PROJECT_DOC_MAX_CHARS` is 16,384 UTF-16 code units (project-doc.ts:10), at most 49,152 UTF-8
bytes; the header is at most 257 bytes. The cap binds only write paths (`assertProjectDocSize`,
project-doc.ts:199-203, from project-handoff.ts:190), so a synced document can be larger; it is exported
whatever its size, and one over 65,536 bytes is reported. Log files split on archive boundaries into
`<slug>.log.1.md`, `<slug>.log.2.md`, a 65,536-byte target, each with its own header; one archive can
exceed it, because the ADR 0045 row cap lets an archive reach 64 KiB. A part no longer needed is removed
only when `classifyTarget` calls it ours.

**Identity.** `requireCommitIdentity` runs `git var GIT_COMMITTER_IDENT` under the pins, including
`user.useConfigOnly=true`, so a repository with no identity refuses before writing and names the two `git
config` commands. NorthKeep never sets an identity; with `GIT_CONFIG_GLOBAL` empty, the repository must.

**One commit per run.** Subject `export: <n> projects (<host>)`; the body lists each project written as
`<slug> (<last writer host>, model not exposed)`, the host from the head's ADR 0052 provenance block
(project-handoff.ts:45, `ProjectView.last_writer`, line 74) or `(unknown host)`, and each removed path. The
message goes on `commit-tree`'s stdin, never as an argument or through a shell, the args-array pattern
packages/mcp-server/src/connect.ts:235-236 describes.

**The lock.** `<common dir>/northkeep-export.lock`, the common dir from `rev-parse --path-format=absolute
--git-common-dir`, shared by every worktree. `O_EXCL` with pid and start time; stale only when the pid is
dead or the file is over an hour old; removed only by its owner; a second export waits 30 seconds, then
reports. It covers every settings and state write. Git's `index.lock` is only ever read.

## Decision 10: Import (project-export-run.ts, `importProjects`)

`northkeep projects import --from <dir> [--write]`, dry run by default: per file, slug, section map, size,
archive count and overflow, writing nothing. The source is read-only and import spawns no git. `*.md`,
non-recursive; stems failing `PROJECT_SLUG_PATTERN` (project-doc.ts:15) are listed and skipped; `kind index`
and `kind marker` are skipped, `kind log` reattaches archives to its slug, `kind document` and headerless
files import. The header is stripped from the preamble (project-doc.ts:101-126), leaving an ADR 0052 draft
line (`PROJECT_DRAFT_LINE_PREFIX`, project-doc.ts:280-284). Per file:

1. Parse with `parseProjectDoc` (project-doc.ts:101-126); map the five known headings (project-doc.ts:25-31)
   to themselves, `Open Questions / Risks` to `Open Questions` (project-handoff.ts:65), others verbatim.
2. Create through the revision-bound path with `expected_revision: null` (ADR 0050); an existing slug is
   refused by name and never merged.
3. Log entries go in oldest first as ADR 0045 archives via `formatImportedLogArchive(project, entries,
   sourceFile)`, with the `## Log archive: <slug>` first line (project-doc.ts:20, 267-274) that
   `getProjectView` finds (project-handoff.ts:226), not by replaying `project_update`, which would restamp
   dates (`datedBullet`, project-doc.ts:334-339). The newest `PROJECT_LOG_KEEP_ENTRIES` (10,
   project-doc.ts:18) stay live.
4. Whatever still exceeds `PROJECT_DOC_MAX_CHARS` becomes one `## Import overflow: <slug>` episodic memory.

## Decision 11: Backup scope (stated, not enforced)

The mirror holds project documents and logs only. The full backup of every memory is the encrypted vault
file and `northkeep export` (packages/cli/src/index.ts:308-323), which writes plaintext JSON at `0o600`. The
mirror is as off-machine as Time Machine or a push the user makes by hand; NorthKeep never pushes. The call
log header's "never written to disk outside the encrypted vault" (packages/mcp-server/src/log.ts:5-9) is
amended in KNOWN-LIMITS.md for mirrored project scopes before this ships; the journal and state file hold
blob ids, slugs, revisions and times, never content.

## Decision 12: Deferred to a possible v2

**Automatic export after vault writes** is cut. Before it returns: the schedule and staleness line show
whether on-demand export keeps the mirror current; export runs off the write path through a queue; and it
passes its own first review. **The GitHub push** moved to ADR 0055.
**Adopting an existing hand-written repository** is cut: nothing is ever overwritten that NorthKeep did not
write. Before it returns, adoption must be an import (Decision 10) into the vault first, so the mirror never
holds content the vault lacks, with a backup of every file replaced.

## Twelve-month post-mortems

**The vault is restored from backup.** Headers match by vault id and blobs by journal, so the next export
writes the restored content; git history keeps the rest.

**The schedule silently stops running** (a macOS update, a moved `node`). `last_attempt` stops advancing and
"last exported" ages in every resume. **The vault is locked at schedule time:** the run records
`vault_locked`, the line shows "last export failed", and `northkeep unlock` fixes the next run.

**The user deletes the marker.** Every export refuses with the restore command, and verify reports it.

**The settings file is lost.** Export is unconfigured; reconfiguring needs an empty folder.

**A write is killed mid-way.** One unique temp is left; the next run removes it and writes the file.

**History is rewritten with `git filter-repo`.** Rewritten files fall out of the journal and read as hand
edits until moved.

## Threats

**A repository that names a program.** Filters, hooks, `gpg.program`, `core.fsmonitor`, `post-index-change`
and `reference-transaction` under plumbing, and `~/.gitconfig`. Mitigated by Decision 2; the canary checks
five attribute sources, 17 program keys, 21 driver keys, 24 hooks in two directories, an included config
and a worktree config. Residual: the pins are a list, and a future git could add a key.

**Replace refs and legacy remote files.** `GIT_NO_REPLACE_OBJECTS=1`; M-A1 names no remote. The canary
plants both.

**The user adds a remote and pushes.** That is the user's egress, not NorthKeep's; `--status` names the
remote and says so.

**Bytes written outside the repository.** A symlink at the temp path wrote outside in a review. Mitigated by
the unique temp name, containment on it, the pattern-only cleanup that unlinks without following, and
`O_EXCL | O_NOFOLLOW`; the canary plants existing and dangling links. Residual: a directory component
swapped between `lstat` and the write.

**A hand edit destroyed.** Mitigated by journal-only ownership, committed or not.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| Two exports of an unchanged vault produce byte-identical files and one commit | `renderProjectFile`, `renderIndexFile` (no timestamp, stored dates, slug order); `exportProjects` stops when `write-tree` returns HEAD's tree |
| No program named by repository, global or system config runs during local export or verify | `runGit`: Decision 2 env, pins, `--no-filters`, owned hooks path; `scripts/adr-0053-canary.sh` |
| M-A1 sends nothing off the machine | `runGit`'s verb allowlist has no `push`, `fetch` or `ls-remote`; a test records every spawned verb |
| A file NorthKeep did not write is never overwritten or committed | `classifyTarget` (header plus journal blob); `plumbingCommit` adds only NorthKeep's paths to an index seeded from HEAD |
| Verify writes nothing | `verifyMirror` uses no write verb and no lock; the canary hashes the repository, git dirs and `NORTHKEEP_HOME` before and after |
| Resume never runs git | `readMirrorSummary` reads two files; test replaces `runGit` with a throwing stub and calls `project_resume` |
| No mirror byte is written outside the repository; NorthKeep's own files go only under `NORTHKEEP_HOME` | preflight, containment including the temp path, and `writeMirrorFile`; one test per refusal; the canary's writer stage |
| A killed write heals on the next run | `writeMirrorFile`'s stale-temp cleanup; the canary's crash stage |
| No export header reaches the vault | `importProjects` strips it; a round-trip test |

## Residual (documented, accepted)

- **Journal loss:** every mirrored file reads as a hand edit until the user moves them; `--verify` lists them.
- **Archives beyond 20** (`PROJECT_REVISION_SUMMARY_LIMIT`, project-handoff.ts:24 and 228) are not mirrored.
- **`nk_commits` grows** by one id per export commit, about 360 KB a year on an hourly schedule.
- **A directory component swapped** between `lstat` and the write is a race NorthKeep does not close.
- **A conflicted project** keeps its last good file. The reconcile expands a sparse index. Git 2.31+.

## Acceptance (Jay, from the CLI)

Throwaway vault, never the real command repo:

```bash
export NORTHKEEP_HOME=$(mktemp -d); LAB=$(mktemp -d); R=$LAB/mirror
export NK=~/Claude/Projects/NorthKeep/northkeep/packages/cli/dist/index.js
mkdir -p $R && git -C $R init -q && git -C $R config user.email you@example.com && git -C $R config user.name Jay
node $NK init   # then create two projects, demo and other, with node $NK projects update
```

1. **First export.** `node $NK projects export --repo $R`. `ls -A $R`
   shows `.git`, `.northkeep-mirror`, `INDEX.md`, `projects`; the log shows 1 commit. `ls $NORTHKEEP_HOME`
   shows `export.json`. A non-empty folder is refused.
2. **Byte-identical second export, no commit.** `cp -R $R/projects $LAB/a`, export again: `diff -r $LAB/a
   $R/projects` is silent, the log still shows 1 commit, `git -C $R status --short` is empty.
3. **Verify clean.** `node $NK projects export --verify; echo $?` prints every path `matches` and 0.
4. **A hand edit.** `echo note >> $R/projects/demo.md`: verify reports `projects/demo.md: hand edit` and
   exits 1; export refuses it by name and exports the rest; the edit is intact.
5. **Status after a write.** `git -C $R checkout -- projects/demo.md`, write to `other`: `--status` shows
   `1 project changed since`, and `project_resume` shows the same line. Export: it is committed.
6. **The canary.** From the NorthKeep repository, `bash scripts/adr-0053-canary.sh` prints `(none)`, every
   blob line `equal`, every verify `unchanged`, every writer and crash line, `result M-A1: PASS`, exit 0.
7. **Import dry run.** `cp -R ~/Claude/Projects/Command\ Repo $LAB/cr`; `node $NK projects import --from
   $LAB/cr/projects` prints a 31-row plan, writes nothing, and `git -C $LAB/cr status --short` is empty.
8. **Nothing is pushed.** `git init -q --bare $LAB/bare.git; git -C $R remote add origin $LAB/bare.git`,
   export: it commits, `--status` names the remote, and `git -C $LAB/bare.git rev-list --all | wc -l` is 0.
9. **A killed write heals.** With `NORTHKEEP_EXPORT_CRASH_WRITE=1` (a test hook that kills the process after
   writing a temp), write to `demo` and export: `ls $R/projects` shows one `demo.md.northkeep-tmp-*`. Export
   again: the temp is gone and verify reports `matches`.
10. **Schedule.** `--schedule hourly`, then `launchctl print gui/$(id -u)/com.northkeep.mirror-export` shows
    it; `northkeep lock`, wait for a run, `--status` shows `vault_locked`; `--schedule off`.

**Canary output while this draft was written,** twice, git 2.54.0 (Apple Git-157), APFS, `TMPDIR=<scratch>
bash scripts/adr-0053-canary.sh`. Both exited 0, the outputs were identical, each deleted its temp dir:

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
  .northkeep-mirror disk=43b44717e162 head=43b44717e162 sha1=43b44717e162 equal
  verify: 6/6 match, repository and NORTHKEEP_HOME unchanged
  replace refs planted on the current blob and tree:
  verify: 6/6 match, repository and NORTHKEEP_HOME unchanged
  read-tree HEAD under the pinned env: the real tree, not the replacement
linked worktree:
  git-dir=repo/.git/worktrees/wt common-dir=repo/.git
  projects/s3.md disk=6bbd5892472b head=6bbd5892472b sha1=6bbd5892472b equal
  verify: 1/1 match, repository and NORTHKEEP_HOME unchanged
fresh repository:
  git-dir=root/.git common-dir=root/.git
  unborn HEAD: root-commit path
  projects/root.md disk=c64e1f69d9f7 head=c64e1f69d9f7 sha1=c64e1f69d9f7 equal
  .northkeep-mirror disk=43b44717e162 head=43b44717e162 sha1=43b44717e162 equal
  verify: 2/2 match, repository and NORTHKEEP_HOME unchanged
legacy remote files (a guard; M-A1 never names a remote):
  planted at the https URL: it still resolves to itself
  planted at the ssh URL: it still resolves to itself
  verify: 2/2 match, repository and NORTHKEEP_HOME unchanged
mirror writer:
  symlinks at our temp pattern, existing and dangling: unlinked, targets untouched; unique temp written; foreign name kept
  forced onto a planted link: containment refused: temp path exists, then with the lstat skipped: open refused: File exists; nothing outside changed
  killed mid-write: 1 temp left, target unchanged; next run removed it and wrote: healed
canaries fired:
  (none)
controls (must fire):
  filter.a1.clean filter.a2.clean filter.a3.clean filter.a4.clean filter.a5.clean hook:core.hooksPath/reference-transaction legacy-remote.slashfree-redirect replace-ref.live tempfile.symlink.followed
result M-A1: PASS
```

The five attribute sources: a committed root `.gitattributes`, an untracked `projects/.gitattributes`,
`.git/info/attributes`, `core.attributesFile`, and a global `~/.config/git/attributes` in a stand-in home.
`ls-remote --get-url` is harness-only: it shows how git resolves a URL without connecting. The writer is
`perl sysopen` with the same four flags and the same cleanup pattern; the crash stage kills it with SIGKILL
after writing the temp. Each plant has a control that fires without the fix. Mutations: without
`GIT_NO_REPLACE_OBJECTS=1` verify reports 5/6; without the hooks pin, `reference-transaction` and
`post-index-change` fire; without `--no-filters`, three filters fire. Git 2.54 does not apply
`.git/info/attributes` or `core.attributesFile` to an absolute path, so their controls use a relative path.
The push stages moved behind `--m-a2`, owned by ADR 0055.

## Adversarial review (2026-09-22, first review of the seventh draft)

Two tracks, NOT CLEARED. Push-only findings moved to ADR 0055: the legacy remote-file redirect, exclusion
failing open under whole-vault sync, and the push sending HEAD's ancestry. M-A1 findings, fixed here: a
symlink at the temp path wrote outside the repository (Decision 2 writer); replace refs fooled verify
(`GIT_NO_REPLACE_OBJECTS=1`); the false `0o644` citation; the verify snapshot now covers `NORTHKEEP_HOME`;
verify gained "uncommitted export"; the `resolveMasterKey` and `connect.ts` citations. Import's code-fence
handling is inherited and shown in the dry run.

## Earlier reviews

Five earlier reviews, all NOT CLEARED. The fifth-draft recheck found a persistent `index.lock` let the index
fall two exports behind a one-blob journal (answered by the lock precondition and the ten-blob journal) and
flagged adoption hints and a silent stopped trigger, both since cut. The fourth found a single fault could
wedge the mirror and a `projects/` submodule could take plaintext elsewhere. The third found `git diff` ran
the clean filter over plaintext. The first and second found stale citations, hooks treated as the only
program, `~/.gitconfig` in play, `git status` as an ownership test and a filter on `add`.

## Adversarial review (2026-09-22, recheck of the seventh draft), the last before the split

Verdict at `scratchpad/verdicts/adr0053-draft7-recheck.md`: **NOT CLEARED.** All five prior findings closed
(legacy remote files, exclusion loss, schema bump, temp-path symlink, push breadth). New findings and where
they went:

- **Kill shot, push-only, moved to ADR 0055:** concurrent `mirror include|exclude` writes lost an
  acknowledged exclusion. In M-A1 the settings file holds only the repository path and is written only
  under the common-dir lock, and there is no exclusion to lose.
- **Flesh wound, push-only, moved:** confirmation by slug is bypassed by delete and re-create.
- **Flesh wound, push-only, moved:** `nk_commits` kept only with a remote made the guard refuse forever.
  M-A1 records every commit id unconditionally, so ADR 0055 inherits the history.
- **Flesh wound, M-A1, fixed:** a killed `writeMirrorFile` left a temp that refused the target forever. The
  writer now uses a unique temp per write and removes its own stale temps first; the canary's crash stage
  shows the heal.
- **Notes.** "Per-project, opt-in" and list precedence moved to ADR 0055. "No byte is written outside the
  repository" is narrowed to mirror bytes; NorthKeep's own files live under `NORTHKEEP_HOME`. The URL
  control-character note moved. The directory-swap race stays a residual here.

Jay's decision after it, 2026-09-22: "Split it."

## Code review (2026-09-22, first review of the M-A1 code)

Two fresh-eyes execution attackers against the built code, verdicts at
`scratchpad/verdicts/m-a1-code-export.md` and `m-a1-code-import-surfaces.md`.
Export side NOT CLEARED: concurrent exports could commit a tree deleting user
files or an empty tree, because the lock could be stolen by age or by a racing
dead-owner takeover and every run shared one temporary index. Import and
surfaces CLEARED WITH WOUNDS (seven). Fixed in one round (Jay: "go"):

- The lock is never taken by age. A dead owner's lock is taken by
  compare-and-steal under a separate guard file; the lock is re-read before
  `update-ref`; each run has a private temporary index; a commit missing a file
  the run did not remove is refused.
- An unreadable mirror file refuses only itself. A run records a failure only in
  its own vault's state file, matched by `vault_fingerprint` (a hash of the vault
  header's salt) when the vault could not be opened; that field is added to the
  state file described in Decision 7.
- Verify runs git with a throwaway home and writes nothing under NORTHKEEP_HOME;
  it reports a file present only in HEAD, and a mode change.
- Import decodes strict UTF-8 and refuses anything else; keeps the newest ten
  Log entries by date when every entry is dated; caps every row at 60,000 bytes;
  reports skipped symlinks, FIFOs and unreadable files; refuses a scope with any
  live row; the dry run reports existing projects and sizes against the 4 MB
  sync limit. Deleting a project works when only its archives remain.
- The journal and state are keyed by the marker's mirror id (above).
- Light-theme contrast of the mirror line is 5.1:1; the schedule has test-only
  overrides for the LaunchAgents folder and launchctl.

Recheck, 2026-09-22 (`scratchpad/verdicts/m-a1-code-recheck.md`): CLEARED WITH
WOUNDS, 11 of 13 prior findings closed. Two flesh wounds, fixed after it:

- A killed stealer no longer wedges exports. The steal guard is written to a
  temp and linked into place, so it is never seen partial. A guard whose owner
  is dead, or that has no readable owner and is over five seconds old, is
  removed by compare-and-remove and the steal retried. A live guard is waited
  for, then refused as `export_busy` with a message saying another export is
  clearing a dead lock.
- A run refused before it holds the lock (`lock_unreadable`, `export_busy`;
  `export_busy` is the only busy code) is now recorded. It goes to a small
  per-mirror `refused.json`, never to the state file: the lock holder rewrites
  state from a copy read at run start, so a second writer, even behind its own
  guard, would either lose the refusal or drop the holder's `nk_commits`. The
  file is written only when this vault file already owns the mirror's state,
  matched by `vault_fingerprint`, and is overlaid by `readExportState` when newer
  than the last attempt, so `--status` and the resume line both show it.
- F6: `northkeep projects delete <slug>` forgets every live entry in the scope,
  archives included. The import refusal now names that command.
