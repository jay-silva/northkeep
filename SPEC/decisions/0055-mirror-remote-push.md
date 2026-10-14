# ADR 0055: Pushing the project mirror to a remote (M-A2)

Status: Draft 2026-09-22, redesign required before first review; nothing built · Review: NOT CLEARED (ADR 0053 draft 7), recheck NOT CLEARED, asking for redesign

## Context
On 2026-09-22 Jay split ADR 0053: the local mirror (M-A1) is built there; the push returns to design here. Jay chose: push "also on the schedule" after a one-time confirmation naming the remote (standing consent); "all projects but with the ability to mark something excluded"; new projects "held until you confirm". It trips every review gate; invariant #7 needs Jay's OK.

## Decision (proposed)
- Prerequisites before first review: (1) all settings writes under one lock (a race lost an acknowledged exclude in 11 of 30 trials); (2) confirmation keyed to a project's durable identity, not its slug, which delete and re-create bypassed; (3) commit ids recorded unconditionally (ADR 0053 M-A1 does).
- D1: `northkeep projects export --remote <url>` (interactive, never scheduled) accepts only `https://` and `ssh://`. The prompt warns that every confirmed project, shared or not, is copied as plaintext on every export, that NorthKeep cannot check privacy, and that pushed content stays in history after revoking. Only a typed `yes` records consent; `--remote off` deletes it. Any other remote URL refuses the push; never force or delete. Projects push only once confirmed (`northkeep projects mirror include`); `exclude` is permanent, stored under `NORTHKEEP_HOME` outside the vault; an unreadable record refuses the push.
- D2: One `git push --porcelain --no-verify <url> <commit id>:refs/heads/main` with pinned environment and config, 120 second timeout, trusting the user's system and global git config and SSH setup, nothing in the repository. A commit guard pushes only NorthKeep's own commits; a repository-config allowlist refuses anything else.
- D3: Proposes invariant #1 amendment (d), Jay's edit to make, covering the egress below.
- D4: State gains `remote`, `last_push`, `last_push_failure`, `unpushed` and more; a failed push never fails the export.

## Consequences
- Limits: HTTPS, SSH, keychain and GitHub are unverified (the lab pushes to a local path); Jay tests one private push before shipping. Only the prompt guards against a public repository; a transferred repository can change the recipient; the URL check accepts control characters and `https://github.com@host/...`; collaborators read everything; pushed excluded content stays in history. A second Mac on one remote is unsupported.
- Open: list precedence, record validation, and "per-project, opt-in" being inaccurate while first setup confirms every listed project.

## Rejected
- Exclusions in the vault: failed open under sync or restore.
- Pushing HEAD by name: sent user commits and side branches.

## What leaves the machine
Proposed, not built: a new egress path and recipient. For every confirmed project, shared or not, its document, Log archives, `INDEX.md` row, file headers and commit messages go as plaintext to a third-party git host at the one confirmed URL, on every manual and scheduled export until `--remote off`. Revoking stops future pushes only; NorthKeep cannot delete what was pushed.

## Links
Depends on: ADR 0053 · Full record: docs/design/adr-0055-mirror-remote-push.md
