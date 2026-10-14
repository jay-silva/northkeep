# ADR 0041: Extend Connect to Cursor (user-global mcp.json)

Status: Accepted 2026-08-25 (M15) · Review: KEEP WITH PATCHES; patches P1 to P4 are part of this decision

## Context
ADR 0013 made one-click Connect register NorthKeep's bundled stdio MCP server with Claude Desktop and Claude Code; ADR 0021 added ChatGPT. Jay asked for Cursor. This is local Connect, not Cloud Connect: it registers the server shipped inside `NorthKeep.app`, never the hosted connector. Mode 2 honesty (ADR 0013) is unchanged: Connect does not redact what the user types into Cursor.

## Decision
- D1: `connect cursor` writes `mcpServers.northkeep` (`type: "stdio"`, `command`, `args` from `resolveMcpCommand()`) to user-global `~/.cursor/mcp.json`. `env.NORTHKEEP_SCOPES` is added only when a scope preset is chosen. Path order: `configPathOverride`, `NORTHKEEP_CURSOR_CONFIG`, then `path.join(os.homedir(), '.cursor', 'mcp.json')`. Never a project-level `.cursor/mcp.json`. Strict JSON surgical merge: touch only our key, back up once. Status counts any object entry named `northkeep` as connected, `type` not required.
- D2: Reject the `cursor://` install deeplink: it hands merge, backup and overwrite to Cursor and is the remote `url` surface.
- D3: `ConnectTarget` gains `'cursor'`; every switch has a `never`-checked `default`. Writers stay per-app, no generic JSON writer.
- P1: Shared `mcpServersOrThrow`: absent becomes `{}`; present but not a plain object throws before `backupOnce`, in both `connectClaudeDesktop` and `connectCursor`. Status stays tolerant; disconnect does not write.
- P2: Cursor only: if `servers.northkeep` has a `url` key, connect throws rather than replace a remote entry. Disconnect still removes it. No `--replace` flag.
- P3: Shared `readConfig` strips one leading UTF-8 BOM before parsing; backup keeps original bytes; BOM plus garbage still refuses.
- P4: `writeConfig` and `writeText` resolve symlinks with `realpathSync` and write/rename against the target (temp file in the resolved parent, mode from the target); a new file is written at the literal path with 0600.

## Consequences
- Easier: Cursor connects from the app with no repo, terminal or separate Node.
- Limits: Cursor must restart (or toggle the server in Settings, MCP). A project-level `.cursor/mcp.json` can shadow the global entry. Enterprise or team MCP allowlists can block the server. Empty scopes on Connect fail open (no `NORTHKEEP_SCOPES`, full owner access); the server fails closed on a present-but-empty `NORTHKEEP_SCOPES=`, which no UI path writes.
- Committed to: Cursor tests in `packages/mcp-server/test/connect.test.ts` against a temp `configPathOverride`, never the real file, with P1 to P4 cases.

## Rejected
- `cursor://` deeplink: we cannot pin backup-once, refuse-unparseable or P1 to P4 through a URL we do not own.
- Writing the project-level file: Connect is user-global only.
- Generic JSON MCP writer: writers stay explicit per app.
- Substituting `{}` over a non-object `mcpServers`: silently destroys other servers' secrets.

## What leaves the machine
Not addressed as a section in the original. Its limits say Connect hands Cursor your owned memory under the chosen scope and does not redact what you type into Cursor; the hosted connector is not registered.

## Links
Full record: docs/design/adr-0041-cursor-connect.md · Extends: ADRs 0013, 0021
