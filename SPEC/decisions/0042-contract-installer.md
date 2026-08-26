# ADR 0042 — Contract installer: standing project instruction into local agent hosts

- **Date:** 2026-08-26
- **Status:** Accepted (M16), KEEP WITH PATCHES
- **Deciders:** Jay (product owner; approved the plan, then ordered
  implementation of the patched design), adversarial reviewer, Cursor
- **Extends:** ADR 0039 (projects as vault memories), ADR 0013 / 0021 / 0041
  (surgical writers for files NorthKeep does not own)
- **Does not touch:** the hosted connector (ADR 0019 / 0020 / 0040),
  connector-server, sync-server, billing, vault schema, curator, ADR 0035,
  `~/.claude/CLAUDE.md`, or any global Cursor write

## Context

M13/M14 shipped `project_list` / `project_get` / `project_update` and a
standing instruction (`PROJECT_STANDING_INSTRUCTION` in
`packages/mcp-server/src/project-recipe.ts`). Agents still ignore that
instruction unless a host-level rule file tells them to follow it. The
Command Repo is the hand-built prototype of the same pattern.

M16 installs one short, advisory contract into the places the local hosts
actually read standing instructions. The contract is Mode 2 honest: it does
not claim Connect redacts chat, and it does not claim enforcement. A session
that ends abruptly wrote nothing.

Adversarial review of the first design returned **KEEP WITH PATCHES**. The
nine load-bearing patches (P1–P9) are pinned below. Shipping without them is
not this ADR.

Live docs were fetched 2026-08-26 and are cited on the decisions they
shaped. Pointer stubs (one owned `~/.northkeep/contract.md` plus imports)
were considered and rejected: Claude Code's Cowork mode skips user-scope
imports that resolve outside the working directory and skips a symlinked
`~/.claude/rules/` file, and neither Codex `AGENTS.md` nor Cursor rules
follow file pointers. The canonical text is a TypeScript constant; every
installed copy is rendered inline from it at install time; `contract status`
detects drift.

## Decision 1: One canonical contract, three explicit targets

`CONTRACT_TEXT` lives in `packages/mcp-server/src/contract.ts` and is
composed from `PROJECT_STANDING_INSTRUCTION` plus the session-end,
no-secrets, no-false-pass, hosted-surface, and P6 graceful-degradation
lines. No em dashes. Under 2048 bytes (unit-tested). Conditional wording:
only when the user names a project or the work clearly belongs to one; if
unsure, one `project_list`; otherwise do nothing.

`ContractTarget` is `'claude' | 'codex' | 'cursor-project'`. Every switch
over that union includes a `default` with a `never` check. Imports stay at
the top of the module.

`renderContract(target)` is the single renderer (P4): the exact bytes
install writes and the exact bytes status compares, after normalizing only
one trailing newline.

## Decision 2: Claude — wholly-owned regular file; never `~/.claude/CLAUDE.md`

Path: `~/.claude/rules/northkeep-projects.md`. Override: caller param or
`NORTHKEEP_CLAUDE_RULES_DIR` (a directory; we join `northkeep-projects.md`).

We never write `~/.claude/CLAUDE.md`. That file is the user's hand-written
global config. Clobbering it is unrecoverable by backup semantics alone.

The installed file is a regular file (not a symlink, not a pointer). The
contract is inlined. First line is an HTML-comment ownership marker
(`<!-- northkeep-contract -->`). Claude Code strips block-level HTML
comments from context before injection
([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory),
fetched 2026-08-26), so the marker is invisible to the model and durable on
disk. The same docs page confirms user-level `~/.claude/rules/*.md` load
before project rules for every project, and that Cowork skips a symlinked
rules file or directory and skips imports resolving outside the working
directory. Regular file, contract inlined, no pointer: those three are
load-bearing.

Install creates the directory. Install refuses an existing file that lacks
the marker. Uninstall follows P3.

## Decision 3: Codex — marker-delimited surgical block in `AGENTS.md`

Path: `~/.codex/AGENTS.md`. Override: caller param, `NORTHKEEP_CODEX_AGENTS`
(file), or `$CODEX_HOME/AGENTS.md`.

This is the one host where the user may already own the file, so ADR 0013
surgical rules apply: backup once, preserve every other byte (CRLF
included), refuse a layout we cannot rewrite safely, new file 0600,
symlink-preserving `atomicWrite`.

Marker grammar is P1, pinned exactly. No TOML parse: `AGENTS.md` is
markdown; the refusal surface is the marker count alone.

`install all` writes Codex only when `~/.codex/` or `$CODEX_HOME` already
exists (P2). Explicit `install codex` creates the directory.

When `AGENTS.override.md` exists at global scope, install still writes
`AGENTS.md` but warns, and status is `blocked` (P2). Verified against Codex
source (openai/codex#13386, #37956, commit `41ece455`, 2026-08-11): at
global scope the first non-empty of `AGENTS.override.md` / `AGENTS.md`
wins, replace-not-merge. The official guide page timed out on direct fetch
the same day; the exemption of the global file from the 32 KiB project-chain
cap is source-verified but undocumented, so we keep `CONTRACT_TEXT` under
2 KiB regardless.

Honesty in CLI copy: this reaches Codex sessions, not plain ChatGPT chat.

## Decision 4: Cursor — project `.mdc` only; no global write

Cursor User Rules live in app settings, not a file
([cursor.com/docs/context/rules](https://cursor.com/docs/context/rules),
fetched 2026-08-26). There is no user-global rules file. We refuse to
pretend one exists.

`--project <dir>` is required. Guards are P5. Write
`<realpath>/.cursor/rules/northkeep.mdc` with YAML frontmatter
`alwaysApply: true` (a plain `.md` in that directory is silently ignored;
verified same docs page). 0600, atomic write, same uninstall bak rule as
Claude (P3). CLI prints the git-visibility note (P9). GUI does not offer
per-project Cursor install; it offers `contract print` / copy via the
existing `copyToClipboard` helper (P8).

`alwaysApply: true` injects the rule into every chat in that repo. The
*rule text* is always present; only the *tool calls* are conditional,
enforced by the contract's own wording (including P6). The alternative
("Apply Intelligently") is agent-discretionary and strictly less reliable.
Context cost is unconditional; tool spam is advisory-suppressed. Stated
honestly here and in KNOWN-LIMITS.

## Decision 5: Status and uninstall

Status is `installed | stale | absent | blocked`.

- `installed`: our marker present, bytes match `renderContract` (one
  trailing newline normalized).
- `stale`: our marker present, bytes differ (P4).
- `absent`: no file (Claude / Cursor) or no well-formed marker pair (Codex).
- `blocked`: Codex `AGENTS.override.md` present (P2), or a Claude/Cursor
  file exists at our path without our marker (install would refuse).

Uninstall (P3): byte-match (trailing newline normalized) → delete the
wholly-owned file. Marker present but bytes differ → move to
`<name>.northkeep-bak` and say so. Never silently destroy user-added notes.
Codex uninstall removes only our marked block when the marker pair is
well-formed; malformed markers refuse.

## Decision 6: Shared `fs-safe.ts` (P7)

`atomicWrite` and `backupOnce` move from `packages/mcp-server/src/connect.ts`
to `packages/mcp-server/src/fs-safe.ts` with byte-identical semantics:
`.northkeep-tmp`, `.northkeep-bak`, realpath-then-write, 0600 default,
post-write chmod, temp cleanup. `connect.ts` re-imports them. The existing
`connect.test.ts` suite must pass unmodified.

## Patches pinned by the adversarial review (P1–P9)

These are load-bearing. Shipping without them is not this ADR.

### P1 — Codex marker grammar, pinned exactly

Markers must be line-anchored: `^<!-- northkeep-contract -->\r?$` and
`^<!-- /northkeep-contract -->\r?$` on their own lines. Install: count
matches for each marker; exactly zero of both means append a fresh block
(blank-line separated) at end of file; exactly one of each, begin before
end, means replace the bytes strictly between them. Any other count, order,
or interleaving refuses with the ADR 0013-style message:

`Refusing to modify ~/.codex/AGENTS.md: NorthKeep's contract markers are duplicated or unpaired. Fix or remove them, then reinstall.`

Preserve every other byte verbatim, CRLF included; strip one leading BOM
for matching only and re-emit it on write. Backup once via `backupOnce`,
write via the P4 symlink-preserving `atomicWrite`, new file 0600. No TOML
parse step.

### P2 — Codex existence gate plus override honesty

`contract install all` writes the Codex target **only when `~/.codex/` (or
`$CODEX_HOME`) already exists**; otherwise it reports "Codex not detected,
skipped; run `northkeep contract install codex` to force." Explicit
`install codex` writes unconditionally (creating the directory). When
`AGENTS.override.md` exists at global scope, install still writes
`AGENTS.md` but warns loudly that the override replaces it entirely, and
`contract status` for Codex reports `blocked`, not `installed`.

### P3 — Claude ownership marker and non-destructive uninstall

`~/.claude/rules/northkeep-projects.md` begins with an HTML-comment marker
line. Install refuses to overwrite an existing file lacking the marker.
Uninstall: if the file's bytes match the current renderer output (modulo
trailing newline), delete. If the marker is present but the bytes differ,
the user edited our file: **move it to `northkeep-projects.md.northkeep-bak`
instead of deleting**, and say so. Same rule for the Cursor `.mdc`
uninstall path.

### P4 — One renderer, byte-exact status

A single `renderContract(target)` per target produces the exact bytes
written by install and the exact bytes status compares against. Status
normalizes only one trailing newline before comparing. No pretty-printing
layer, no re-wrap, no second serialization path. `stale` is "our marker
present, bytes differ from current render."

### P5 — `--project` path guards

For `contract install cursor --project <dir>`: `fs.realpathSync` the
argument; it must exist and be a directory; refuse `/`, refuse
`os.homedir()`, refuse any ancestor of the home directory. Warn, do not
refuse, when `<dir>` contains no `.git`. After realpath, `../../` traversal
resolves to a concrete directory that either hits a refusal or is a
directory the user legitimately named. Write
`<realpath>/.cursor/rules/northkeep.mdc`, creating the two directories,
`alwaysApply: true` frontmatter, 0600, atomic write.

### P6 — Graceful-degradation clause in `CONTRACT_TEXT`

Pinned verbatim:

If the NorthKeep project tools are unavailable, disabled, or a call returns a scope or permission error, mention it once and continue without them; never retry in a loop and never block the session on it.

A personal-only Connect (`NORTHKEEP_SCOPES=personal`) makes `project_get`
throw `ScopeDeniedError`. Cursor tool toggles or a missing MCP registration
produce the unavailable case. Without this clause the contract instructs
agents into a guaranteed error on every scope-restricted connection.

### P7 — fs-safe extraction is move-only

`fs-safe.ts` exports `atomicWrite` and `backupOnce` with byte-identical
semantics (see Decision 6). `connect.test.ts` stays unmodified and green.

### P8 — GUI copy button reuses the shipped clipboard helper

`apps/web/static/index.html` already contains `copyToClipboard` (400 ms
timeout race around `navigator.clipboard.writeText`, `execCommand`
fallback). The contract copy button calls that helper. No second clipboard
path.

### P9 — Git-visibility note for the Cursor rule

`.cursor/rules/` is version-controlled by Cursor convention. After writing
`northkeep.mdc`, the CLI prints that the file may be committed (and that
collaborators do not have NorthKeep) and suggests `.git/info/exclude` if it
should stay personal. NorthKeep never edits `.gitignore`.

## Honest limits

- The contract is advisory. An agent can ignore it. A session that ends
  abruptly wrote nothing.
- `alwaysApply: true` pays a context cost in every chat in that Cursor
  repo; only the tool calls are conditional.
- Cowork version residual: current docs confirm regular files in
  `~/.claude/rules/` load, and confirm the symlink/import skips we avoid.
  Older or future Cowork versions are unverifiable.
- Codex's global-file 32 KiB-cap exemption is source-verified and
  undocumented; it can change. We keep the text under 2 KiB anyway.
- Model compliance with the P6 degradation clause is unverifiable.
- `AGENTS.override.md` silently replaces `AGENTS.md`; status reports
  `blocked`. A manual paste into Cursor User Rules is invisible to
  `contract status` and will drift.
- Claude Desktop plain chat and ChatGPT chat have no on-disk instruction
  file. Hosted Claude.ai is a different surface (connector project tools,
  not this installer). Named in CLI copy and KNOWN-LIMITS.
- Read-modify-write TOCTOU on a hand-edited `AGENTS.md` is the same
  accepted non-blocking posture ADR 0013 recorded; atomic rename bounds
  the damage to lost-update, never a torn file.

## Testing

`packages/mcp-server/test/contract.test.ts` is driven by fixture temp dirs
and path overrides. It never writes Jay's real `~/.claude/CLAUDE.md`,
`~/.claude/rules/`, `~/.codex/AGENTS.md`, or `~/.cursor/`.

1. Claude: create-with-dir; refuse foreign without marker; uninstall
   delete on hash match; uninstall move-aside on edit; status states.
2. Codex: append; replace preserving other bytes (CRLF, BOM, comments);
   refuse duplicated/unpaired/reversed markers; backup-once;
   symlink-preserving write; new file 0600; install-all skip when no
   Codex dir; override → `blocked`.
3. Cursor: `.mdc` `alwaysApply: true`; refuse `/`, homedir,
   ancestor-of-home; realpath traversal; non-git warn.
4. `CONTRACT_TEXT`: no em dash, under 2048 bytes, contains the P6 clause,
   contains the standing-instruction tool names.
5. `connect.test.ts` green unmodified after the fs-safe move.

## Acceptance test (Jay, from this checkout)

Do not point automated tests at the real host files.

1. `northkeep contract install claude`, then confirm
   `~/.claude/rules/northkeep-projects.md` exists and `~/.claude/CLAUDE.md`
   is untouched (diff against a copy made first).
2. Open a cold Claude Code session in a directory unrelated to NorthKeep.
   Say "where did we leave off on northkeep". It calls `project_get` before
   answering. Say "we are done, wrap up". It calls `project_update` with
   status and a log entry (verify in the GUI audit log).
3. In another cold session ask for something unrelated ("write a haiku").
   No project tool call fires.
4. Seed a fake `~/.codex/AGENTS.md` via `NORTHKEEP_CODEX_AGENTS` (or
   inspect the real file after a backup), `northkeep contract install
   codex`, confirm the block appended, prior lines byte-identical,
   `.northkeep-bak` present. `contract uninstall codex` removes only the
   block.
5. `northkeep contract status` shows the installed targets; hand-edit one
   word inside the installed Claude file and status reports stale.
6. Cursor: `contract print`, paste into Cursor Settings → Rules; and
   `contract install cursor --project <some repo>` produces
   `.cursor/rules/northkeep.mdc` there. The CLI printed the git-visibility
   note.

## Out of M16

Hosted Claude.ai, plain ChatGPT chat, Claude Desktop plain chat, the
curator, ADR 0035 surfaces, connector-server, sync-server, auto-migrate on
launch, any write to `~/.claude/CLAUDE.md`, any global Cursor write,
`cursor://` deeplinks (ADR 0041 Decision 2), and pointer-stub contracts.
