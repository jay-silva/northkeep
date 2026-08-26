# ADR 0041 — Extend Connect to Cursor (user-global mcp.json)

- **Date:** 2026-08-25
- **Status:** Accepted (M15), KEEP WITH PATCHES
- **Deciders:** Jay (product owner; ordered the adversarial review, then
  implementation of the patched design), adversarial reviewer, Cursor
- **Extends:** ADR 0013 (consumer MCP / Connect), ADR 0021 (ChatGPT Connect)
- **Does not touch:** the hosted connector (ADR 0019 / 0020), connector-server,
  sync-server, billing, project-doc, vault schema, or the contract installer

## Context

ADR 0013 made one-click Connect register NorthKeep's bundled stdio MCP server
with Claude Desktop (hand-edited JSON) and Claude Code (via the `claude` CLI).
ADR 0021 extended the same local, no-subscription path to ChatGPT via
`~/.codex/config.toml`. Jay asked for the same for **Cursor**.

This is the *local* Connect surface, not Cloud Connect. The fourth
`ConnectTarget` is `'cursor'`. Connect registers the MCP server that ships
**inside** `NorthKeep.app` in the user-global Cursor config. It does **not**
register the hosted NorthKeep connector (a remote `url` entry). Those are
different product surfaces.

Mode 2 honesty (ADR 0013 Decision 4) is unchanged: Connect does not redact
what the user types into Cursor. For a redaction firewall over chat, use
Converse.

Adversarial review of the first design returned **KEEP WITH PATCHES**. The
four load-bearing patches (P1–P4) are pinned below and implemented before any
writer change is considered done.

## Decision 1: Register the bundled stdio server in user-global `~/.cursor/mcp.json`

`connect cursor` writes a Cursor MCP entry:

```json
{
  "mcpServers": {
    "northkeep": {
      "type": "stdio",
      "command": "<the running node binary>",
      "args": ["<…/@northkeep/mcp-server/dist/index.js>"]
    }
  }
}
```

When a scope preset is chosen, `env.NORTHKEEP_SCOPES` is added; when it is
not, `env` is omitted (full owner access). `command` / `args` come from the
same `resolveMcpCommand()` used by the other local targets, so a consumer who
only downloaded the app needs no repo, terminal, or separate Node.

Path resolution is, in order: `configPathOverride` → `NORTHKEEP_CURSOR_CONFIG`
→ `path.join(os.homedir(), '.cursor', 'mcp.json')`. The default is
homedir-absolute. Connect **never** writes a project-level
`.cursor/mcp.json`. A project file can still shadow the global entry
per-workspace; that is documented, not solved, here.

Cursor's `mcp.json` is strict JSON (not JSONC). The writer is the existing
surgical JSON merge used for Claude Desktop: read, touch only
`mcpServers.northkeep`, back up once, write pretty JSON with a trailing
newline. The status reader treats an object entry named `northkeep` as
connected and does **not** require `type`, so a hand-written stdio entry
still counts.

The user is told to restart Cursor, or toggle the server in Cursor Settings →
MCP.

## Decision 2: `cursor://` install deeplink is considered and rejected

Cursor advertises a `cursor://anysphere.cursor-deeplink/mcp/install?…`
installer. We will not use it.

A deeplink hands merge, backup, and overwrite semantics to Cursor. We cannot
pin ADR 0013's crown-jewel invariant (touch only our key, back up once,
refuse an unparseable file) or P1–P4 through a URL we do not own. It is also
the wrong product surface: this milestone registers the **local bundled
stdio** server, and a deeplink is the path people use to drop in a remote
`url` (including the hosted connector). Surgical write of
`~/.cursor/mcp.json` is the only writer we will ship.

## Decision 3: Explicit fourth target, exhaustive switches

`ConnectTarget` is `'claude-desktop' | 'claude-code' | 'chatgpt' | 'cursor'`.
Every switch over that union — `connect` / `disconnect` / `connectStatus`,
CLI restart copy, GUI restart copy, `TARGET_LABEL` — includes `cursor` and a
`default` with a `never` check so a fifth target fails at compile time.
Writers stay explicit and per-app; there is no generic "JSON MCP writer"
abstraction.

## Patches pinned by the adversarial review (P1–P4)

These are load-bearing. Shipping without them is not this ADR.

### P1 — shared `mcpServersOrThrow` (hardens Claude Desktop too)

If `mcpServers` is absent, return `{}`. If it is present and not a plain
object (array, string, number, …), **throw before `backupOnce`**. Never
substitute `{}` over a non-object: that silently destroys other servers'
secrets (an array-of-servers file is a real, if unusual, shape).

Ordering for connect: `readConfig` → `mcpServersOrThrow` → (P2 if Cursor) →
`backupOnce` → write.

Wired into **both** `connectClaudeDesktop` and `connectCursor`. Status stays
tolerant (non-object → `{ connected: false }`, never throws). Disconnect
stays no-write when `mcpServers` is a non-object.

User-facing refusal:

`Refusing to modify ${file}: its "mcpServers" key is not a JSON object. NorthKeep never overwrites configuration it cannot merge into. Fix that key, then reconnect.`

### P2 — Cursor-only remote hijack guard

After `mcpServersOrThrow`, before backup: if `servers.northkeep` is an object
**and** has a `url` key, throw. That entry is a remote MCP server — likely
the hosted NorthKeep connector, a different product surface. Connect will not
silently replace it with our stdio command.

Reconnect of our own stdio entry (`command`, no `url`) still replaces.
Disconnect of a `url` entry still removes it (the user asked to disconnect
`northkeep`). No `--replace` flag.

### P3 — BOM strip in shared `readConfig`

`readFileSync` then strip **one** leading UTF-8 BOM (`/^\uFEFF/`) before the
existing empty/parse logic. `writeConfig` already writes without a BOM.
`backupOnce` remains `copyFileSync` of the original bytes, BOM included.
Claude Desktop inherits this. A BOM plus garbage still refuses.

### P4 — symlink-preserving atomic write

`writeConfig` and `writeText` `realpathSync` an existing file and
write/rename against the resolved target so a symlink is not replaced by a
regular file. The temp file lives in the resolved parent directory. Mode
comes from the resolved target. If the file does not exist, write at the
literal path (0600). Umask-proof `chmod`, temp cleanup, and atomic rename
are unchanged.

## Honest limits

- Cursor must be restarted, or the server toggled in Settings → MCP, to
  load the change.
- A project-level `.cursor/mcp.json` can shadow the global entry in that
  workspace. We never write the project file.
- Enterprise / team MCP allowlists can block the registered server even
  after a successful write.
- Same Mode-2 honesty as ADR 0013: Connect hands Cursor your owned memory
  under the chosen scope; it does **not** redact what you type into Cursor.
- Empty scopes on Connect fail *open* (omit `NORTHKEEP_SCOPES` → owner / full
  access). The server still fails *closed* on a present-but-empty
  `NORTHKEEP_SCOPES=`. No UI path writes the empty-present form.
- We refuse a non-object `mcpServers` rather than clobber (P1).
- We refuse to overwrite a remote `url` entry named `northkeep` (P2).
- This milestone does not register, advertise, or write the hosted
  connector. Cloud Connect stays on its own surface.

## Testing

`packages/mcp-server/test/connect.test.ts` gains a Cursor suite driven by a
temp `configPathOverride` (never Jay's real `~/.cursor/mcp.json`):
create-when-absent with `type: "stdio"`; preserve unrelated keys, sibling
servers, a remote `url`+`headers` sibling, and `${env:…}` interpolation
strings; backup-once; refuse unparseable; scopes → `env.NORTHKEEP_SCOPES`;
no scopes → no `env`; disconnect removes only ours and leaves
`"mcpServers": {}`; status connected+scopes, and `connected: true` for a
hand-written entry that omits `type`; `cursorConfigPath()` default is
absolute, under `os.homedir()`, and ends with `/.cursor/mcp.json`.

P1–P4 have their own cases (non-object `mcpServers` refused on both JSON
writers; remote `url` hijack on Cursor only; BOM strip + backup-of-original-
bytes; symlink-preserving write and disconnect; new file 0600). Existing
Claude Desktop and ChatGPT suites stay green.

## Acceptance test (Jay, from the installed `.app`)

From the installed NorthKeep app, not a checkout:

1. Connect tab → **Connect** Cursor (scope "work" or "personal only").
2. Confirm `~/.cursor/mcp.json` gained a `northkeep` stdio entry (`type`,
   `command`, `args`, and `env.NORTHKEEP_SCOPES` if scoped). Every other key
   and sibling server is untouched. A `.northkeep-bak` exists if the file
   predated the write.
3. Restart Cursor, or toggle the server in Settings → MCP.
4. In a Cursor agent chat, ask something that only the chosen scope can
   answer. A memory outside that scope is not disclosed.
5. **Disconnect** Cursor. Only `mcpServers.northkeep` is gone.

Do not point automated tests at the real `~/.cursor/mcp.json`.
