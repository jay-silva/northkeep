# ADR 0086: Share projects by default

Status: Proposed 2026-11-22 · Review 1: NOT CLEARED, revised · Recheck: CLEARED WITH WOUNDS, wounds fixed

## Context
Projects are private until Jay shares each one. On 2026-11-22 Gemini, on the Cloud connector, could not see the unshared bourne-fire project. Jay wants projects shared by default and rarely opens the app. Invariant #1 names ADR 0050 as its only no-dialog share; this adds a second.

## Decision
- D1: A `vault_meta` setting, `share_projects_by_default`, off in every vault, written to the export under `settings` (no NorthKeep importer exists yet, for shares either). It travels with vault sync; builds older than this ignore it and share nothing. Only the app, or a CLI command that needs an interactive terminal and ignores `--yes` and `NORTHKEEP_ASSUME_YES`, changes it.
- D2: Turning it on lists each unshared project scope with exactly one live project document, ticked, except scopes in D5's list (unticked). Each line shows how many memories and held app rows go with it (held rows read "unknown" offline). One confirmation; ticked scopes are marked as a manual share.
- D3: While on, the creation branch of core `writeProject` (no current document, owner or agent) marks the scope Shared in the same transaction, unless the request says `private: true` or the scope is in D5's list. This covers `project_create` and creating through `project_update`. `projects import` stays private. The ADR 0050/0065 fold and restore paths keep their own rules.
- D4: `project_create` and `project_update` accept `private: true`. When a create marks the scope, the result says `shared: true`, how many existing memories in that scope go with it, and whether the connector push is running or paused. The contract tells the agent to ask first and to relay that line.
- D5: Jay's unshare (app, CLI `share remove`, later the phone) and deleting a project add its scope to `kept_private_projects` in `vault_meta` (exported); a failed share's rollback does not. D2 and D3 skip listed scopes, and the ADR 0050 fold holds them. Any share by Jay, take-theirs included, removes the scope.
- D6: No new agent tool shares, unshares or changes the setting.
- D7: Turning it off changes no scope.
- D8: The app badges projects shared by default since Jay last opened it.

## Consequences
- Easier: new projects reach cloud apps without opening the app.
- Harder: memories filed under a project leave the Mac; switch-on can push many projects and release held app rows at once. A mark only reaches the cloud while the push runs (subscription, tombstone, switched off can pause it).
- Committed to: CLAUDE.md invariant #1 names this exception (needs Jay's OK); KNOWN-LIMITS says an agent that skips the question shares the project, that shell-capable agents can already run `share add --yes`, and that the phone's creates and unshares are covered only once it ships this.

## Rejected
- An agent unshare tool: the server's unshare deletes app writes this Mac has not pulled.
- Agent-callable share: injection could send a private project away.
- Asking in the app: Jay rarely opens it.

## What leaves the machine
With the setting on: ticked projects at switch-on and later-created projects, with every memory in their scopes, go to the same account's connector store, encrypted as any shared scope. No new recipient or content class.

## Links
Extends: ADRs 0038, 0050, 0065 · Review record: docs/design/adr-0086-share-projects-by-default.md
