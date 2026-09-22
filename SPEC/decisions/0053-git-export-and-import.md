# ADR 0053: Git export and import for project documents

- **Date:** 2026-09-22
- **Status:** Seventh draft (on-demand export with remote push), pending first review. Five earlier
  reviews, all NOT CLEARED. The sixth draft was never reviewed. Nothing is built.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0038 (shared scopes in the vault), ADR 0039 (projects as vault memories), ADR 0045 (log
  rolling), ADR 0048 (revision-bound handoffs), ADR 0051 (compaction), ADR 0052 (provenance)
- **Review gate:** tripped on every count that applies. **What leaves the machine:** a new egress path and a
  new recipient, a third-party git host receiving plaintext of every non-excluded project, shared or not
  (Decision 7). **Who decides:** a standing consent replaces a per-run OK (Decision 5). **A networked
  action:** git, an installed program, now opens a network connection on NorthKeep's behalf (Decision 6);
  invariant #7 needs Jay's explicit OK, recorded below. **The vault schema:** one additive table (Decision
  8). **A published claim:** the Claims table. Not touched: crypto or key handling, redaction tiers, the row
  envelope, sync, the connector. No model runs in any path here.

## Context

A project document lives as one `working` memory per `project:<slug>` scope. Jay's record before NorthKeep
was a git repository of Markdown files. `getProjectView` (packages/core/src/project-handoff.ts:219-233)
returns the parsed document with prior revisions and Log archives, and `listProjectViews`
(project-handoff.ts:254-257) returns one summary row per project, sorted by slug (line 256). Missing: a
renderer, a git-versioned human-readable copy, and a way to bring an existing folder in.

**Jay's decisions, 2026-09-22.** First, the scope cut: "I want to do B but ensure we still have an accurate
mirror/backup." Jay is connecting Grok Bot to NorthKeep through MCP, so no agent reads the mirror for current
state; the mirror is a human-readable, git-versioned backup, exported on demand into a folder NorthKeep owns.
Second, asked "When should NorthKeep push the mirror to GitHub?", Jay chose **"Also on the schedule"**: after
a one-time confirmation naming the remote, manual and scheduled exports both push. This replaces the earlier
brief's "never pushes without an explicit per-run OK" with a **standing consent**, recorded here as such.
Third, scope: **"All projects but with the ability to mark something excluded."**

Files. `packages/core/src/project-export.ts` (pure): `renderProjectFile`, `renderLogFile`,
`renderIndexFile`, `renderMarkerFile`, `parseExportHeader`, `summarizeMirror`.
`packages/mcp-server/src/git-plumbing.ts`: `runGit`, `runGitPush`, `plumbingCommit`, `readRemotes`,
`readLocalConfig`, `requireCommitIdentity`. `packages/mcp-server/src/project-export-run.ts`:
`exportProjects`, `verifyMirror`, `pushMirror`, `classifyTarget`, `readJournal`, `writeJournal`,
`readExportState`, `writeExportState`, `readMirrorSummary`, `acquireExportLock`, `installSchedule`,
`importProjects`. Decisions 2, 6 and 9 are evidenced by `scripts/adr-0053-canary.sh`.

## Decision 1: What is rendered, and where (project-export.ts)

The mirror holds `projects/<slug>.md` (the stored document plus the Decision 3 header),
`projects/<slug>.log.md` for a project with Log archives, `INDEX.md` (one row per project from
`listProjectViews`), and the root marker `.northkeep-mirror` (Decision 4). A project excluded under Decision
8 is not rendered at all: no file, no log file, no INDEX row.

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

NorthKeep writes each mirror file with `atomicWrite` (packages/mcp-server/src/fs-safe.ts:31-49), which
writes through an existing file's realpath (lines 35-36), and chmods it `0o644` rather than the `0o600`
default (line 33). Files under `<NORTHKEEP_HOME>/export/` (a `0o700` directory) keep `0o600`. `<key>` is
the SHA-256 of the UTF-8 repository realpath, 64 lowercase hex characters, naming the temporary index, the
journal and the state file.

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
--porcelain`), `var`, `remote` (only `-v`) and `config` (only `--list --show-scope --includes`). No `add`,
`commit`, `status`, `diff`, `checkout`, `init`, `merge` or `tag` is constructed; `push` and `ls-remote`
exist only in Decision 6. Every local invocation runs with this environment and nothing else:

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

`-C` takes the repository realpath from `fs.realpathSync`. Per invocation: a 10 second timeout, a bounded
`maxBuffer`, never while the vault file lock is held. Git 2.31 or newer, for `--path-format=absolute`.

**Preflight,** before any write, each refusing the whole run: the path is not a work tree (`rev-parse
--show-toplevel` must equal it); it is bare; it is inside `northkeepHome()`
(packages/core/src/platform.ts:7-9) or the vault's directory, or is a NorthKeep checkout; Decision 4's
marker check fails; `worktree list --porcelain` shows HEAD's branch checked out in another worktree; or
`<git-dir>/index.lock` exists, the git dir from `rev-parse --path-format=absolute --git-dir`, which in a
linked worktree is `.git/worktrees/<name>`, where that worktree's index and lock live. That refusal names
the file and says to remove it once no git process runs; NorthKeep never removes it. The lock is checked
again before `update-ref`; if it appeared, the run stops there, HEAD unmoved, the files journaled residue.

**Per-target containment,** per file before it is written, refusing that target and continuing: a symlink
in any component (`atomicWrite` writes through one by design, fs-safe.ts:35-36); a target that is not a
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

**What heals without a human.** Crash residue (journaled before the write), a `checkout .` over a stale
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
temporary index is seeded from HEAD and only NorthKeep's paths are added. Export runs only when
`<NORTHKEEP_HOME>/export.json` names a repository (resolved path, no secret); absent means off.

## Decision 5: Consent to push (project-export-run.ts, `pushMirror`)

`northkeep projects export --remote <url>` is interactive and never runs from the schedule. It accepts only
`https://`, `ssh://` or `user@host:path` URLs, and prints: the URL, the number of projects that will be
pushed (all minus excluded), "every non-excluded project, shared or not, will be copied as plaintext to this
host on every export, manual or scheduled", "NorthKeep cannot check that this repository is private", and
"anything pushed stays in that repository's history even after you revoke". Only a typed `yes` records
`{ "url", "confirmed_at" }` in the state file. `--remote off` deletes it; later exports do not push.
NorthKeep uses no GitHub API and adds no dependency, which is why privacy cannot be checked.

Before every push, `readRemotes` re-reads `git remote -v`: any remote whose fetch or push URL is not the
confirmed URL refuses the push, and the export reports it. No remote at all is fine, because the push names
the URL. Without consent nothing is pushed, and any remote in the repository is reported on every export. NorthKeep never creates the GitHub repository, never adds a remote, never passes `--force` or a `+`
refspec, and never pushes a deletion. A non-fast-forward is refused by git, reported, and never overwritten.

## Decision 6: The push step, isolated (git-plumbing.ts, `runGitPush`)

The local plumbing keeps the full lockdown. Push is one separate invocation after `update-ref`, and it must
use the user's credentials, so it cannot run under Decision 2's environment. What it trusts: the user's
system and global git config (on this Mac both name the `osxkeychain` credential helper) and the user's SSH
setup. What it does not trust: anything in the repository's own config.

```
git push --porcelain --no-verify <confirmed url> <HEAD commit>:refs/heads/main
env: PATH=/usr/bin:/bin  HOME=<user home>  SSH_AUTH_SOCK (passed through if set)
     GIT_TERMINAL_PROMPT=0  GIT_ASKPASS=/usr/bin/false  SSH_ASKPASS=/usr/bin/false  GIT_OPTIONAL_LOCKS=0
-c core.hooksPath=<NORTHKEEP_HOME>/hooks  -c core.fsmonitor=false  -c protocol.allow=never
-c protocol.https.allow=always  -c protocol.ssh.allow=always  -c push.gpgSign=false
-c gpg.program=/usr/bin/false  -c push.recurseSubmodules=no  -c submodule.recurse=false
-c push.followTags=false  -c core.askPass=/usr/bin/false  -c core.alternateRefsCommand=  -c http.sslVerify=true
```

By URL, so `remote.*.pushurl`, `remote.*.receivepack` and `remote.*.uploadpack` are never consulted. One
fixed ref, `refs/heads/main`. `--no-verify` and the owned `core.hooksPath` each stop `pre-push`. Pins
cannot remove a key, though, and the lab shows a repository-local `url.<x>.insteadOf` silently redirects a
push by URL. So **before every push, `readLocalConfig`** runs `config --list --show-scope --includes` under
Decision 2's environment, which lists only repository and worktree scopes plus the pins, and refuses the
push unless every repository-scope key is on an allowlist: `core.repositoryformatversion`, `core.filemode`,
`core.bare`, `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `user.name`,
`user.email`, `extensions.objectformat`, and a `remote.<name>.url` equal to the confirmed URL with its
default fetch refspec. That refuses a local `core.sshCommand`, `credential.helper`, `url.*`, `http.*`,
`include.path` and every hook path by name. `ls-remote <url> refs/heads/main` runs under the same push
environment, read-only, for Decision 10 and acceptance.

**Unverified against reality** until acceptance step 10: the lab pushes over a local path, so HTTPS, SSH,
the keychain helper and GitHub itself are not exercised. Jay runs that step once against a private test
repository.

## Decision 7: Egress, and the amendment to invariant #1

This is a new path for plaintext to leave the machine. Invariant #1 in CLAUDE.md lists three exits (a), (b)
and (c). Proposed amendment, Jay's edit to make, inserted after (c):

> (d) the project documents and logs of every project scope the user has not excluded from the mirror,
> shared or not, pushed as plaintext by NorthKeep's git mirror to the single remote URL the user confirmed
> at a prompt that names the URL and the project count (ADR 0053), on every manual and scheduled export
> until the user runs `northkeep projects export --remote off`. Revoking stops future pushes only: what was
> already pushed stays in the remote's history, which NorthKeep cannot delete.

It is opt-in (no remote by default), confirmed (the Decision 5 prompt), visible (the status line in every
`project_resume` and `project_list`, Decision 10), and reversible going forward (`--remote off`, or
excluding one project). It is not reversible backward: git history on the remote keeps everything ever
pushed. Nothing is redacted: a mirror masked by Tier-1 would be a backup that lies.

## Decision 8: Excluding a project (vault table, CLI, Projects page)

**Where the flag lives.** A new vault table, `mirror_exclusions (scope TEXT PRIMARY KEY, excluded_at TEXT
NOT NULL)`, schema 0.4 to 0.5 (`SCHEMA_VERSION`, packages/core/src/types.ts:149), created empty by the
migration so the default, included, is structural. It copies the `scopes` table pattern of ADR 0038
(packages/core/src/vault.ts:377-381): row present means excluded, removing it deletes the row. New `Vault`
methods `mirrorExcludedScopes()` and `setScopeMirrorExcluded(scope, excluded)`, and a
`mirror_excluded_scopes` key in `northkeep export` (SPEC/memory-schema.md, invariant #4). The vault syncs
whole, so the mark travels between devices. Not document metadata: ADR 0052 provenance is rewritten on
every write (`readProjectProvenance`, project-handoff.ts:162) and ADR 0048 receipts bind the exact
canonical request, so a flag there would have to be carried by every writer, connected apps included, and
one writer that dropped it would silently re-include a project, failing open into egress. A table no
project write touches survives every wrap.

**Controls.** `northkeep projects exclude <slug>` and `northkeep projects include <slug>`, and on the
Projects page an "Exclude from mirror" switch, served by a new `POST /api/projects/<slug>/mirror` in
apps/web/src/projectsApi.ts (the route pattern at line 64 gains `mirror`).

**Effect.** An excluded project is never written to the mirror, because anything committed reaches the
remote. Excluding one that was already exported removes its files from the next commit (`update-index
--force-remove` in the temporary index and the reconcile, unlink on disk) and its INDEX row. Its earlier
content stays in local and remote history; scrubbing needs a history rewrite on both, which NorthKeep does
not do. When the state file shows the slug was exported, the CLI and the switch print exactly that before
confirming.

## Decision 9: Verify (project-export-run.ts, `verifyMirror`)

`northkeep projects export --verify` is read-only: no git writes, no file writes, no journal or state
writes, no export lock. It renders every non-excluded project and reports each path as **matches** (disk,
HEAD and render equal), **stale** (disk and HEAD are NorthKeep's but differ from the render), **missing**,
**extra** (a `projects/*.md` with no project in the vault, or an excluded one), or **hand edit** (disk or
HEAD is in no journal entry and differs from the render). Exit 0 only when every path matches. Its git
calls are `hash-object --no-filters --stdin` on the render, `rev-parse HEAD:<path>`, `hash-object
--no-filters -- <path>` and `ls-tree HEAD -- projects/`, under Decision 2's environment; the canary runs
this sequence and fails if any file under the repository or its git dirs changed.

## Decision 10: Staleness and status (project-export.ts, project-export-run.ts)

The state file, `<NORTHKEEP_HOME>/export/<key>.state.json`, `atomicWrite` at `0o600` after every run:

```json
{ "version": 1, "repo": "<realpath>", "vault_id": "<uuid>",
  "last_success": { "at": "<ISO>", "commit": "<id>" }, "last_attempt": { "at": "<ISO>", "by": "cli|schedule" },
  "last_failure": { "at": "<ISO>", "code": "<code>" }, "refused": [ { "path": "...", "reason": "hand edit" } ],
  "projects": { "<slug>": { "revision": "<id>", "exported_at": "<ISO>" } },
  "remote": { "url": "<url>", "confirmed_at": "<ISO>" }, "unpushed": 0,
  "last_push": { "at": "<ISO>", "commit": "<id>" }, "last_push_failure": { "at": "<ISO>", "code": "<code>" } }
```

`northkeep projects export --status` prints the repository, last successful export time and commit,
projects changed since (current revision differs from `projects`, or new), refused paths, the last failure,
last successful push, `unpushed` (commits made since the last push), and the last push failure.

`summarizeMirror(state, summaries, excluded, now)` is pure and returns one line: "mirror last exported
<time>; N projects changed since", plus "; K commits not pushed" and "; last export failed <time>" or "; last
push failed <time>" when true. `readMirrorSummary(vault, granted)` reads `export.json` and the state file
only, never runs git, takes revisions from `listProjectViews(vault, granted)`, and counts only projects in
the caller's granted scopes, so a narrow grant learns nothing about other projects. It returns null when no
mirror is configured. Callers: `project_list` (packages/mcp-server/src/server.ts:605-615) and
`project_resume` (server.ts:700-724) add `mirror_status`; `GET /api/projects`
(apps/web/src/projectsApi.ts:25-26) adds `mirror`, shown in `projectsSummaryMeta`
(apps/web/static/index.html:2154). Every string is fixed text, a time or a count: no path, no git stderr.

A failed push never fails the export: the commit stays local, `unpushed` grows, and the next run pushes it.

## Decision 11: An optional schedule (project-export-run.ts, `installSchedule`)

`northkeep projects export --schedule hourly|daily|off`, macOS only, off by default, run by the user.
It writes or removes `~/Library/LaunchAgents/com.northkeep.mirror-export.plist` (`0o644`, no secret):
`ProgramArguments` are `process.execPath`, the CLI entry and `projects export --scheduled`; `StartInterval`
3600 or a daily `StartCalendarInterval`; `NORTHKEEP_HOME` when set; output to `/dev/null`. It loads with
`/bin/launchctl bootstrap gui/<uid> <plist>` and unloads with `bootout`. The job is a separate process
started by launchd, never inside an agent's write.

It needs the key `northkeep unlock` parks in the Keychain (packages/cli/src/index.ts:136-163).
`--scheduled` never prompts: when `resolveMasterKey` (index.ts:1164) finds no key it records `last_failure`
`vault_locked` and exits. A busy vault lock, a refusal or a git error is recorded the same way, and the
staleness line shows it. It pushes when consent exists (Decision 5).

## Decision 12: Byte caps, identity, one commit per run, the lock

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
message goes on `commit-tree`'s stdin, for the reason packages/mcp-server/src/connect.ts:235-236 states.

**The lock.** `<common dir>/northkeep-export.lock`, the common dir from `rev-parse --path-format=absolute
--git-common-dir`, shared by every worktree. `O_EXCL` with pid and start time; stale only when the pid is
dead or the file is over an hour old; removed only by its owner; a second export waits 30 seconds, then
reports. It covers the push. Git's `index.lock` is only ever read.

## Decision 13: Import (project-export-run.ts, `importProjects`)

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

## Decision 14: Backup scope (stated, not enforced)

The mirror holds project documents and logs only. The full backup of every memory is the encrypted vault
file and `northkeep export` (packages/cli/src/index.ts:308-323), which writes plaintext JSON at `0o600`. The
mirror is as off-machine as the user makes it: Time Machine, or the Decision 5 push to the one remote the
user confirmed. The call log header's "never written to disk outside the encrypted vault"
(packages/mcp-server/src/log.ts:5-9) is amended in KNOWN-LIMITS.md for mirrored project scopes before this
ships; the journal and state file hold blob ids, slugs, revisions and times, never content.

## Decision 15: Deferred to a possible v2

**Automatic export after vault writes**, with its failure counter and per-write status, is cut. Before it
returns: the schedule and staleness line have run long enough to show whether on-demand export keeps the
mirror current; the export runs off the write path through a queue, so an agent's write never waits on git
or the network; and it passes its own first review, since every vault write would then be a potential push.
**Adopting an existing hand-written repository** is cut: nothing is ever overwritten that NorthKeep did not
write. Before it returns, adoption must be an import (Decision 13) into the vault first, so the mirror never
holds content the vault lacks, with a backup of every file replaced.

## Twelve-month post-mortems

**The vault is restored from backup.** Headers are tested by vault id, blobs against the journal, so the next
export writes the restored content; git history keeps the rest.

**The schedule silently stops running** (a macOS update, a moved `node`). `last_attempt` stops advancing and
the staleness line's "last exported" ages in every resume; `--status` shows no attempt since that time.

**The vault is locked at schedule time** (after `northkeep lock`). The run records `vault_locked`; the line
shows "last export failed"; `northkeep unlock` fixes the next run.

**The user deletes the marker.** Every export refuses the whole run with the restore command. Verify reports
it. Nothing is written into a folder NorthKeep cannot prove is its own.

**A second Mac, or the folder in a cloud-synced directory.** The lock is per machine, so two machines can
interleave commits and the remote sees a non-fast-forward, refused and reported. One machine per mirror.

**History is rewritten with `git filter-repo`**, for example to scrub an excluded project. Rewritten files
fall out of the journal and read as hand edits until moved; the rewritten branch is a non-fast-forward the
push refuses. The user force-pushes by hand; NorthKeep never does.

## Threats

**A repository that names a program.** Filters, hooks, `gpg.program`, `core.fsmonitor`, `post-index-change`
and `reference-transaction` under plumbing, and `~/.gitconfig`. Mitigated by Decision 2; the canary checks
five attribute sources, 17 program keys, 21 driver keys, 24 hooks in two directories, an included config
and a worktree config. Residual: the pins are a list, and a future git could add a key.

**Push config redirecting or running code.** `url.*.insteadOf`, `pushurl`, `receivepack`, a local
`core.sshCommand` or `credential.helper`, `pre-push`. Mitigated by push-by-URL, `--no-verify`, the owned
hooks path and the Decision 6 local-config allowlist; the lab shows `insteadOf` redirecting a push under pins
alone and the allowlist refusing it. Residual: the user's own global config is trusted.

**A public repository chosen by mistake.** NorthKeep cannot see visibility. Mitigated only by the prompt
saying so. Residual: accepted, and anything pushed stays in history.

**A remote URL typo pointing at someone else's repository.** Pushing needs write access there, so a typo
usually fails authentication; if the user can write there, the content lands. Mitigated by the prompt showing
the exact URL and `ls-remote` in acceptance. Residual: accepted.

**A stolen or revoked credential.** Revoked: the push fails, is recorded, and the commit stays local. Stolen:
whoever holds it can read the remote; that is the credential's exposure, not NorthKeep's. Residual:
accepted.

**A GitHub outage.** The push fails, `unpushed` grows, the next run retries. Nothing is lost locally.

**An excluded project already in history.** Excluding stops future writes only; the CLI says so. Residual:
scrubbing is a manual rewrite on both sides.

**The schedule pushing while Jay is travelling.** It pushes wherever the Mac has network, which is what
standing consent means; `--remote off` or `--schedule off` stops it. Residual: accepted by Jay's choice.

**A repository shared with collaborators.** Everyone with read access reads every non-excluded project, and
a collaborator's push makes the next push a non-fast-forward, refused. Residual: the user chose the audience.

**Bytes written outside the confirmed repository.** Mitigated by per-target containment. Residual: a
component swapped between `lstat` and the write.

**A hand edit destroyed.** Mitigated by journal-only ownership; nothing NorthKeep did not write is
overwritten, committed or not.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| Two exports of an unchanged vault produce byte-identical files and one commit | `renderProjectFile`, `renderIndexFile` (no timestamp, stored dates, slug order); `exportProjects` stops when `write-tree` returns HEAD's tree |
| No program named by repository, global or system config runs during local export or verify | `runGit`: Decision 2 env, pins, `--no-filters`, owned hooks path; `scripts/adr-0053-canary.sh` |
| The push runs no repository-named program and goes only to the confirmed URL | `runGitPush` (URL, fixed ref, pins, `--no-verify`) after `readLocalConfig`'s allowlist and `readRemotes`; the canary's push stage |
| NorthKeep never pushes without a confirmed remote, never force-pushes, never deletes a remote ref | `pushMirror` requires `remote` in the state file; `runGitPush` constructs no `--force`, `+` or `:ref` |
| A file NorthKeep did not write is never overwritten or committed | `classifyTarget` (header plus journal blob); `plumbingCommit` adds only NorthKeep's paths to an index seeded from HEAD |
| An excluded project is never written to the mirror, and so never pushed | `exportProjects` filters by `mirrorExcludedScopes()` before rendering; test excludes a slug and asserts no file, row or slug in the tree |
| Verify writes nothing | `verifyMirror` uses no write verb and no lock; the canary compares repository hashes before and after |
| Resume never runs git | `readMirrorSummary` reads two files; test replaces `runGit` with a throwing stub and calls `project_resume` |
| No byte is written outside the repository | preflight plus containment; one test per refusal |
| No export header reaches the vault | `importProjects` strips it; a round-trip test |

## Residual (documented, accepted)

- **Revocation is not retroactive:** everything pushed stays in the remote's history.
- **Journal loss:** every mirrored file reads as a hand edit until the user moves them; `--verify` lists them.
- **Archives beyond 20** (`PROJECT_REVISION_SUMMARY_LIMIT`, project-handoff.ts:24 and 228) are not mirrored.
- **Schema 0.5:** a device on an older build refuses the synced vault as "newer than this build understands"
  (vault.ts:396) until updated; mobile builds must ship before the first 0.5 vault syncs.
- **A conflicted project** keeps its last good file. **The reconcile** expands a sparse index.
- **Git 2.31 or newer**; commit identity is the repository's own.

## Acceptance (Jay, from the CLI)

Throwaway vault, never the real command repo:

```bash
export NORTHKEEP_HOME=$(mktemp -d); LAB=$(mktemp -d); R=$LAB/mirror
export NK=~/Claude/Projects/NorthKeep/northkeep/packages/cli/dist/index.js
mkdir -p $R && git -C $R init -q && git -C $R config user.email you@example.com && git -C $R config user.name Jay
node $NK init   # then create two projects, demo and other, with node $NK projects update
```

1. **First export.** `node $NK projects export --repo $R`: `ls -A $R` shows `.git`, `.northkeep-mirror`,
   `INDEX.md`, `projects`; `git -C $R log --oneline | wc -l` is 1. A non-empty folder is refused.
2. **Byte-identical second export, no commit.** `cp -R $R/projects $LAB/a`, export again: `diff -r $LAB/a
   $R/projects` is silent, the log still shows 1 commit, `git -C $R status --short` is empty.
3. **Verify clean.** `node $NK projects export --verify; echo $?` prints every path `matches` and 0.
4. **A hand edit.** `echo note >> $R/projects/demo.md`: verify reports `projects/demo.md: hand edit` and
   exits 1; export refuses it by name and exports the rest; the edit is intact.
5. **Status after a write.** `git -C $R checkout -- projects/demo.md`, write to `other` with `projects
   update`: `--status` shows `1 project changed since`, and `project_resume` shows the same line.
6. **The canary.** From the NorthKeep repository, `bash scripts/adr-0053-canary.sh` prints `(none)`, every
   blob line `equal`, every verify `unchanged`, `result: PASS`, exit 0.
7. **Import dry run.** `cp -R ~/Claude/Projects/Command\ Repo $LAB/cr`; `node $NK projects import --from
   $LAB/cr/projects` prints a 31-row plan, writes nothing, and `git -C $LAB/cr status --short` is empty.
8. **Exclusion.** `node $NK projects exclude other`: the history warning prints. Export: `git -C $R show
   --stat HEAD` removes `projects/other.md`, `grep -c other $R/INDEX.md` is 0, `git -C $R log --oneline --
   projects/other.md` still lists the earlier commit.
9. **A second remote.** After step 10's consent, `git -C $R remote add stray $LAB/bare.git`, export: the
   commit lands, the push is refused and reported. `git -C $R remote remove stray`.
10. **Push, once, against a private GitHub test repository Jay creates.** `node $NK projects export --remote
    git@github.com:<you>/<private-test>.git`, read the prompt, type `yes`. Export, then `git -C $R ls-remote
    git@github.com:<you>/<private-test>.git refs/heads/main` equals `git -C $R rev-parse HEAD`. `--status`
    shows the push and `0` unpushed. Finish with `--remote off` and delete the test repository.
11. **Schedule.** `--schedule hourly`, then `launchctl print gui/$(id -u)/com.northkeep.mirror-export`
    shows it; `northkeep lock`, wait for a run, `--status` shows `vault_locked`; `--schedule off`.

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
  verify: 6/6 match, repository unchanged
linked worktree:
  git-dir=repo/.git/worktrees/wt common-dir=repo/.git
  projects/s3.md disk=6bbd5892472b head=6bbd5892472b sha1=6bbd5892472b equal
  verify: 1/1 match, repository unchanged
fresh repository:
  git-dir=root/.git common-dir=root/.git
  unborn HEAD: root-commit path
  projects/root.md disk=c64e1f69d9f7 head=c64e1f69d9f7 sha1=c64e1f69d9f7 equal
  .northkeep-mirror disk=43b44717e162 head=43b44717e162 sha1=43b44717e162 equal
  verify: 2/2 match, repository unchanged
push:
  clean mirror: allowlist passes, pushed, ls-remote main = HEAD
  product pins, local path URL: refused (https and ssh only)
  hostile mirror: refused before push, 54 local keys outside the allowlist
  pins alone on the hostile mirror: url.insteadOf redirected the push: yes (why the allowlist exists)
canaries fired:
  (none)
controls (must fire):
  filter.a1.clean filter.a2.clean filter.a3.clean filter.a4.clean filter.a5.clean hook:core.hooksPath/pre-push hook:core.hooksPath/reference-transaction remote.origin.receivepack
result: PASS
```

The five attribute sources: a committed root `.gitattributes`, an untracked `projects/.gitattributes`,
`.git/info/attributes`, `core.attributesFile`, and a global `~/.config/git/attributes` in a stand-in home.
`sha1` is `shasum` over `blob <size>\0<bytes>`, independent of git. The push stage's only lab-specific pin is
`protocol.file.allow=always`, so a local bare repository stands in for GitHub; the next line proves the
product pins refuse that URL. Mutations show the script can fail: without the local `core.hooksPath` pin it
reports `reference-transaction` and `post-index-change`; without `--no-filters` it reports three filters;
with both `--no-verify` and the push hooks pin removed it reports `pre-push` (either one alone stops it); a
verify that writes one object reports `CHANGED`. Git 2.54 does not apply sources 3 and 4 to an absolute path,
so their controls use a relative path; `--no-filters` is the mechanism. Transport keys (`core.sshCommand`,
`credential.helper`, `ssh.variant`, `core.gitProxy`) are unreachable over a local path; the allowlist refuses
them in repository config, and the global ones are trusted by design.

## Adversarial review (2026-09-22, recheck of the fifth draft)

Git 2.54.0, APFS. **NOT CLEARED.** Closed: the crash window with a vault advance, a garbage-collected journal
blob, a branch staged in another worktree, containment against a symlink, a directory, a hard link and a
gitlink, and the fourth review's flesh wounds. Open: a persistent `index.lock` let the index fall two exports
behind a one-blob journal, so `checkout .` wedged the mirror (answered by the lock precondition and the
ten-blob journal); a containment refusal suggested `--adopt` (adoption is now cut); a stopped trigger said so
once (the trigger is now cut); "class 1" survived; the repository hash was unspecified (SHA-256, full hex).

## Earlier reviews

Four earlier reviews, all NOT CLEARED. The fourth (2026-09-22) found a single fault could wedge the mirror
and a `projects/` submodule could take plaintext into another repository; it confirmed zero canaries under
the pins, the unborn-HEAD path, and one of eight `O_EXCL` racers winning. The third (2026-09-22) found `git
diff` ran the clean filter over plaintext and hung on a process filter. The first and second (2026-09-21)
found stale citations, hooks treated as the only program, `~/.gitconfig` in play, `git status` as an
ownership test, a filter on `add`, `--adopt` with no backup, and no round trip; the third draft answered with
plumbing writes, remote checks, round-tripping headers and header stripping on import.
