# ADR 0055: Pushing the project mirror to a remote (M-A2)

- **Date:** 2026-09-22
- **Status:** Draft, redesign required before first review. Nothing is built.
- **Deciders:** Jay (product owner), Claude Code
- **Depends on:** ADR 0053 (M-A1, the local mirror: plumbing export, journal, containment, locks, state
  file, schedule). This ADR adds only what reaching a remote needs.
- **Review gate:** tripped on every count. **What leaves the machine:** a new egress path and a new
  recipient, a third-party git host receiving plaintext of every confirmed project, shared or not
  (Decision 3). **Who decides:** a standing consent replaces a per-run OK (Decision 1). **A networked
  action:** git opens a connection on NorthKeep's behalf (Decision 2); invariant #7 needs Jay's explicit OK.
  **A published claim:** the claims below. Not touched: the vault schema, crypto, redaction tiers, sync, the
  connector.

## Context

On 2026-09-22 Jay split ADR 0053 after its seventh-draft recheck: "Split it." M-A1, the local mirror, is
built under ADR 0053. The push to GitHub returns to design here. This draft carries the push design as it
stood in the seventh draft of ADR 0053, with the recheck's open findings stated as prerequisites. It is not
ready for review until the prerequisites are designed.

**Jay's decisions, all 2026-09-22.** Asked "When should NorthKeep push the mirror to GitHub?", Jay chose
**"Also on the schedule"**: after a one-time confirmation naming the remote, manual and scheduled exports
both push, a **standing consent** that replaces the earlier "never pushes without an explicit per-run OK".
Scope: **"All projects but with the ability to mark something excluded."** New projects: **"Held until you
confirm."**

## Prerequisites the recheck identified (required before first review)

1. **Every settings write serialized under a lock.** Two concurrent `mirror include|exclude` runs lost an
   acknowledged exclude in 11 of 30 trials and tore the file in 8, through `atomicWrite`'s fixed temp name
   (packages/mcp-server/src/fs-safe.ts:41-45). Every writer of the confirmation and exclusion record must
   hold one lock (ADR 0053's `<common dir>/northkeep-export.lock`, or a settings lock under
   `NORTHKEEP_HOME`), re-read inside it, and write with a unique temp name. The design must say which.
2. **Confirmation keyed to a project's durable identity, not its slug.** A project deleted and re-created
   with the same slug skipped the hold. The vault's durable identity today is the id of the project's first
   working revision: walk `superseded_by` back from the live head, through tombstoned rows, to the entry no
   row points to. `deleteProject` (packages/core/src/vault.ts:606-621) tombstones every entry and a new
   create gets a fresh uuid. Checked on 2026-09-22 against the built core: after two revisions the walk
   returned the first revision id; after `deleteProject` and a re-create it returned a different id. The
   design must also say how ADR 0051 compaction and sync conflicts affect the walk.
3. **NorthKeep records its commit ids unconditionally, remote or not.** The seventh draft kept `nk_commits`
   only with a remote, so the push guard refused forever after exports made before consent, after
   `--remote off` and on, and after a rewrite recovery. ADR 0053 M-A1 records every commit id in its state
   file from the first export, so this history exists when M-A2 lands.

## Decision 1: Consent (project-export-run.ts, `pushMirror`)

`northkeep projects export --remote <url>` is interactive and never runs from the schedule. It accepts only
`https://` and `ssh://` URLs, here and before every push. The scp form `user@host:path` is refused with its
`ssh://user@host/path` equivalent: a slash-free argument can name a legacy `.git/remotes/<name>` or
`.git/branches/<name>` file, which the first review used to redirect a confirmed push while both checks
below stayed blind. The prompt prints the URL, the number of confirmed projects, "every confirmed project,
shared or not, will be copied as plaintext to this host on every export, manual or scheduled", "NorthKeep
cannot check that this repository is private", and "anything pushed stays in that repository's history even
after you revoke". Only a typed `yes` records `{ "url", "confirmed_at" }`. `--remote off` deletes it. No
GitHub API and no new dependency, so privacy cannot be checked.

Before every push, `readRemotes` re-reads `git remote -v`; any remote whose URL is not the confirmed URL
refuses the push, and the export reports it. NorthKeep never creates the repository, never adds a remote,
never passes `--force` or a `+` refspec, never pushes a deletion. A non-fast-forward is refused and
reported.

**Confirmation and exclusion.** A project is pushed only when it is affirmatively confirmed on this Mac
(prerequisite 2 sets the key). Any other project, including one a connected app created (ADR 0050), waits,
listed by `--status`. `northkeep projects mirror include` confirms; `exclude` records a permanent no. The
record lives under `NORTHKEEP_HOME`, outside the vault, so no sync, restore or import can drop an exclusion.
An unreadable record refuses the push; it is never treated as empty. Excluding a pushed project removes its
files from the next commit; its earlier content stays in local and remote history, and the CLI says so.
Open: precedence when a key is in both lists, and schema validation of the record.

## Decision 2: The push step, isolated (git-plumbing.ts, `runGitPush`)

Push is one invocation after ADR 0053's `update-ref`. It must use the user's credentials, so it cannot run
under ADR 0053's local environment. It trusts the user's system and global git config (on this Mac both
name `osxkeychain`) and SSH setup, and nothing in the repository.

```
git push --porcelain --no-verify <confirmed url> <newest NorthKeep commit id>:refs/heads/main
env: PATH=/usr/bin:/bin  HOME=<user home>  SSH_AUTH_SOCK (if set)  GIT_NO_REPLACE_OBJECTS=1
     GIT_TERMINAL_PROMPT=0  GIT_ASKPASS=/usr/bin/false  SSH_ASKPASS=/usr/bin/false  GIT_OPTIONAL_LOCKS=0
-c core.hooksPath=<NORTHKEEP_HOME>/hooks  -c core.fsmonitor=false  -c protocol.allow=never
-c protocol.https.allow=always  -c protocol.ssh.allow=always  -c push.gpgSign=false
-c gpg.program=/usr/bin/false  -c push.recurseSubmodules=no  -c submodule.recurse=false
-c push.followTags=false  -c core.askPass=/usr/bin/false  -c core.alternateRefsCommand=  -c http.sslVerify=true
```

A 120 second timeout. By URL, so `pushurl`, `receivepack` and `uploadpack` are never consulted.
`--no-verify` and the owned `core.hooksPath` each stop `pre-push`.

**Only NorthKeep's own commits.** The push sends a commit by id, never `HEAD` by name, to one fixed branch.
Before pushing, `pushMirror` refuses when HEAD is not on the branch recorded at first export, when that
commit is not HEAD, or when any id from `rev-list <last pushed>..HEAD` (all of `rev-list HEAD` before the
first push) is not a recorded NorthKeep commit. This adds `rev-list` to the local verb allowlist.

**Repository config.** Pins cannot remove a key, and a local `url.<x>.insteadOf` redirects a push by URL.
Before every push `readLocalConfig` runs `config --list --show-scope --includes -z` under ADR 0053's local
environment and refuses unless every repository-scope key is on an allowlist: `core.repositoryformatversion`,
`core.filemode`, `core.bare`, `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`,
`user.name`, `user.email`, `extensions.objectformat`, and a `remote.<name>.url` equal to the confirmed URL
with its default fetch refspec. `ls-remote <url> refs/heads/main` runs under the push environment,
read-only.

**Unverified against reality:** the lab pushes over a local path, so HTTPS, SSH, the keychain helper and
GitHub are not exercised. Jay runs one push against a private test repository before this ships.

## Decision 3: Egress, and the amendment to invariant #1

Proposed amendment to CLAUDE.md invariant #1, Jay's edit to make, inserted after (c):

> (d) for each project the user has confirmed for the mirror on this Mac, shared or not: its project
> document, its Log archives, its `INDEX.md` row (slug, draft or active, one-line status, updated date,
> last writer host), the file headers (vault id, slug, revision id), and NorthKeep's commit messages (each
> project's last writer host), pushed as plaintext by NorthKeep's git mirror to the single `https://` or
> `ssh://` URL the user confirmed at a prompt naming the URL and the project count (ADR 0055), on every
> manual and scheduled export until `northkeep projects export --remote off`. Revoking stops future pushes
> only; what was pushed stays in the remote's history, which NorthKeep cannot delete.

And the closing sentence, "Default is private; sharing is per-scope, opt-in, loudly confirmed,
badge-visible, and reversible with server-side deletion", becomes:

> Default is private. Sharing under (b) is per-scope, opt-in, loudly confirmed, badge-visible, and
> reversible with server-side deletion. The mirror push under (d) is per-project, opt-in, confirmed, shown
> in the mirror status line, and reversible for future pushes only: it is not server-side deletable.

The recheck noted "per-project, opt-in" is inaccurate while the first configuration confirms every listed
project by default; the redesign must make the wording and the prompt agree.

## Decision 4: Status fields

ADR 0053's state file gains `remote { url, confirmed_at }`, `branch`, `last_push { at, commit }`,
`last_push_failure { at, code }` and `unpushed`, and the staleness line gains "; W projects waiting for
confirmation", "; K commits not pushed" and "; last push failed <time>". A failed push never fails the
export: the commit stays local and the next run retries.

## Threats

- **Push config redirecting or running code** (`url.*.insteadOf`, `pushurl`, `receivepack`, a local
  `core.sshCommand` or `credential.helper`, `pre-push`): push by URL, `--no-verify`, the owned hooks path,
  the config allowlist. Residual: the user's own global config is trusted.
- **Legacy remote files, replace refs, the user's own commits:** `https://`/`ssh://` only,
  `GIT_NO_REPLACE_OBJECTS=1`, the commit guard.
- **A public repository chosen by mistake:** only the prompt warns. Anything pushed stays in history.
- **A URL typo, or a repository renamed or transferred:** a typo usually fails on write access; a transfer
  can change the recipient behind the same URL (unverified). The URL check accepts control characters and
  `https://github.com@host/...`; the prompt shows the URL.
- **A revoked credential or an outage:** the push fails, `unpushed` grows, the next run retries.
- **The schedule pushing while Jay travels:** standing consent working as chosen; `--remote off` stops it.
- **An excluded project already in history** stays there; scrubbing is a manual rewrite on both sides.
- **A repository shared with collaborators:** everyone with read access reads every confirmed project.
- **Concurrent settings writes** (prerequisite 1) and **a re-created slug** (prerequisite 2).

## Twelve-month post-mortems

**The settings record is lost.** Nothing new is confirmed, so nothing new is pushed. **A connected app
creates a project.** It waits until confirmed. **History is rewritten with `git filter-repo`**, for example
to scrub an excluded project: the rewritten branch is a non-fast-forward the push refuses; the user
force-pushes by hand; NorthKeep never does. **A second Mac** mirroring to the same remote is unsupported;
the guard and git refuse interleaved history.

## The canary's M-A2 section

`bash scripts/adr-0053-canary.sh --m-a2` runs ADR 0053's M-A1 stages, then the push stages this ADR owns,
against local bare repositories with no network: the URL check, legacy remote files at `https://` and
`ssh://` shapes, a clean push by commit id with `ls-remote` equal to it, the product pins refusing a local
path URL, the user-commit and side-branch refusals, the config allowlist refusing a hostile repository, and
`url.insteadOf` redirecting under pins alone. Its controls are `pre-push`, `remote.origin.receivepack` and
the scp-form legacy redirect. On 2026-09-22 it printed `result M-A2: PASS` with no canary fired.

## Review history

- **First review of ADR 0053's seventh draft (2026-09-22), NOT CLEARED.** Verdicts:
  `scratchpad/verdicts/adr0053-draft7-execution.md` and `adr0053-draft7-assumptions.md`. Push findings: a
  `.git/remotes/<scp url>` file redirected a confirmed push (fixed: `https://`/`ssh://` only); exclusion in
  a vault table failed open under whole-vault sync or restore (moved off the vault); the push sent HEAD's
  ancestry, a user commit and a side branch (fixed: commit guard); replace refs (fixed:
  `GIT_NO_REPLACE_OBJECTS=1`); no push timeout (120 seconds).
- **Recheck (2026-09-22), NOT CLEARED.** Verdict: `scratchpad/verdicts/adr0053-draft7-recheck.md`. All five
  prior findings closed. New: a settings race lost an acknowledged exclude (kill shot; prerequisite 1);
  confirmation by slug is bypassed by delete and re-create (prerequisite 2); `nk_commits` not kept without
  a remote makes the guard refuse forever (prerequisite 3); "per-project, opt-in" is inaccurate; list
  precedence and schema validation are unspecified. The recheck asked for a design change, not another fix
  round.
