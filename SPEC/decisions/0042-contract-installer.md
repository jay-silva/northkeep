# ADR 0042: Contract installer: standing project instruction into local agent hosts

Status: Accepted 2026-08-26 (M16) · Review: KEEP WITH PATCHES; the nine patches P1 to P9 are load-bearing (details in the design file) · Contract text corrected 2026-09-24 (release 0.22.0 doc-vs-code pass)

## Context
Agents ignore `PROJECT_STANDING_INSTRUCTION` unless a host-level rule file tells them to follow it. M16 installs one short, advisory contract where local hosts read standing instructions; it claims no enforcement and does not claim Connect redacts chat.

## Decision
- D1: One canonical `CONTRACT_TEXT` in `packages/mcp-server/src/contract.ts`, rendered inline per target by a single `renderContract(target)`; status compares those exact bytes (P4). Targets: `'claude' | 'codex' | 'cursor-project'`. As of 0.22.0 it holds the standing instruction (`project_resume`, `project_wrap`, `project_checkpoint`, `project_update`, `project_list`), only-when, no-false-pass, no-secrets and `project_create` lines, the P6 clause, and a bootstrap paragraph (ADR 0052); no em dashes; unit-tested under 4096 bytes (originally 2048).
- D2: Claude: a wholly-owned regular file `~/.claude/rules/northkeep-projects.md` starting with `<!-- northkeep-contract -->`. Never `~/.claude/CLAUDE.md`. Install refuses a file without the marker.
- D3: Codex: a marker-delimited block in `~/.codex/AGENTS.md` under ADR 0013 surgical rules: backup once, preserve every other byte, line-anchored marker pair or refuse (P1). `install all` writes only if `~/.codex/` or `$CODEX_HOME` exists (P2). With a global `AGENTS.override.md`, install warns and status is `blocked`.
- D4: Cursor: project only, `--project <dir>` required, writes `.cursor/rules/northkeep.mdc` with `alwaysApply: true`. Realpath guards refuse `/`, the home directory and its ancestors (P5). The CLI prints a git-visibility note and never edits `.gitignore` (P9). The GUI offers copy only (P8).
- D5: Status is `installed | stale | absent | blocked`. Uninstall deletes on byte match, moves an edited file to `.northkeep-bak` (P3), and removes only a well-formed Codex block.
- D6: P6 clause: if the tools are unavailable or a call returns a scope or permission error, mention it once and continue; never retry in a loop.
- D7: `atomicWrite` and `backupOnce` move unchanged to `fs-safe.ts` (P7).

## Consequences
- Limits: the contract is advisory and an agent can ignore it; an abrupt session end writes nothing. `alwaysApply: true` costs context in every chat in that repo. Older or future Cowork versions, Codex's undocumented 32 KiB-cap exemption, and P6 compliance are unverifiable. A manual paste into Cursor User Rules drifts unseen. Claude Desktop chat, ChatGPT chat and hosted Claude.ai are not reached. Hand-edited `AGENTS.md` keeps ADR 0013's accepted lost-update risk.
- Tests use fixture temp dirs, never real host files.

## Rejected
- Pointer stubs to one `~/.northkeep/contract.md`: Cowork skips outside imports and symlinked rules; Codex and Cursor do not follow pointers.
- Writing `~/.claude/CLAUDE.md`: the user's own file; clobbering is unrecoverable.
- Cursor "Apply Intelligently": agent-discretionary, less reliable.
- `cursor://` deeplinks, auto-migrate on launch, global Cursor writes: out of M16.

## What leaves the machine
The original has no egress section. It states the installer does not touch the hosted connector, connector-server or sync-server.

## Links
Full record: docs/design/adr-0042-contract-installer.md · Extends: ADRs 0039, 0013, 0021, 0041 · Amended by: ADR 0052
