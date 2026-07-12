# ADR 0013 — Consumer MCP: one-click Connect to Claude Desktop & Claude Code

- **Date:** 2026-07-12
- **Status:** Accepted (M8)
- **Deciders:** Jay (product owner; chose both Claude surfaces + the full experience), Claude Code

## Context

The two-modes strategy (private note `05-TWO-MODES-PRODUCT-STRATEGY.md`) named
the mass-market wedge: **memory portability via MCP** — your NorthKeep memory
follows you into the AI apps you already pay for, on your existing subscription.
M1 built the MCP server, but connecting means hand-editing
`claude_desktop_config.json` with paths into a dev checkout — a developer setup,
not a consumer one. M8 makes it **one click**, for **Claude Desktop and Claude
Code**, with **scope presets** and an **honest privacy explainer**.

The enabling fact (verified 2026-07-12): the signed `NorthKeep.app` already
bundles the Node runtime (`Contents/MacOS/northkeep-server`) **and** the MCP
server code (`Contents/Resources/server/node_modules/@northkeep/mcp-server/`),
and `mcp-server/dist/index.js` self-starts an stdio server when run directly. So
a consumer who only downloaded the app already has a working MCP server inside
it — Connect just has to *register* it.

## Decision 1: Connect = register the bundled server; never require the repo or Node

Connect writes a config entry pointing the target app at the MCP server that
ships **inside NorthKeep.app**:

```
command: <the running node binary>              e.g. /Applications/NorthKeep.app/Contents/MacOS/northkeep-server
args:    [<bundled mcp-server/dist/index.js>]   e.g. …/Contents/Resources/server/…/@northkeep/mcp-server/dist/index.js
```

`resolveMcpCommand()` derives these from the **currently running server**
(`process.execPath` + the resolved path to the bundled `@northkeep/mcp-server`),
so it is correct whether NorthKeep runs as the installed `.app` (bundled Node +
bundled script) or from a dev checkout (system `node` + `packages/mcp-server`).
No assumption that the user has Node, a terminal, or the source.

## Decision 2: Writing another app's config is surgical — merge, back up, own only our key

Connect modifies files NorthKeep does not own. The rules, enforced in the
writer and non-negotiable:

- **Merge, never overwrite.** Read the existing config, add/replace **only**
  `mcpServers.northkeep` (Claude Desktop) or the `northkeep` server (Claude
  Code), and write everything else back byte-faithfully. Real configs carry
  many unrelated keys (preferences, trusted folders, …) — those are sacred.
- **Back up first.** Copy the config to `<file>.northkeep-bak` before the first
  write, so a mistake is always recoverable.
- **Disconnect is exact.** Remove only our entry; if `mcpServers` becomes empty
  we leave the (empty) object rather than guessing at the user's structure.
- **Never touch a config we can't parse.** If the JSON doesn't parse, refuse and
  tell the user, rather than risk clobbering it.
- **Claude Code** is registered via its own supported interface —
  `claude mcp add northkeep <command> <args> --scope user` / `claude mcp remove`
  — so Claude Code owns its own file format; we don't hand-edit it when the CLI
  is present. (Fallback to `~/.claude.json` only if the CLI is absent.)

The user's click is the authorization for this side effect (it's their machine,
their app, their explicit action) — but the surgical rules make it safe even so.

## Decision 3: Scope presets ride the existing NORTHKEEP_SCOPES (M4), no new mechanism

The MCP server already limits disclosure to `NORTHKEEP_SCOPES` (ADR 0006). So a
per-connection scope preset is just an `env` entry in the config we write:

- **Everything** (owner) — omit `NORTHKEEP_SCOPES` (full access).
- **Personal only** — `NORTHKEEP_SCOPES=personal`.
- **Custom** — the user's chosen scope set.

This makes "let this app see only my work memories" a real, enforced boundary —
the same fail-closed allowlist M4 already tests — surfaced as a one-tap preset.

## Decision 4: An honest in-app privacy explainer (the two modes)

Connect is Mode 2 (ADR-level framing): NorthKeep is a memory server to an app
you already use. The UI must state the honest boundary plainly, next to the
Connect button: **Connect gives that app your owned, portable memory under the
scope you choose — it does NOT redact what you type into that app** (the app
still sends your chat to its provider). For the redaction firewall, use
**Converse** (Mode 1). Never let a user believe Connect firewalls their chat.

## Vault access (how the connected server reads memory)

The spawned MCP server needs the master key. It uses the same path as today
(ADR 0002): the user unlocks in NorthKeep with "keep unlocked" → the key is
parked in the macOS Keychain → the MCP server reads it there. Because the
installed app and its bundled server share **one Developer ID signature**, the
Keychain ACL grants the bundled server access without re-prompting (verify on
first run). Locked ⇒ the MCP tools return the existing "vault is locked"
message; nothing leaks.

## Scope (M8)

**In:** one-click Connect/Disconnect + status for Claude Desktop and Claude
Code; safe merge + backup; scope presets via `NORTHKEEP_SCOPES`; the privacy
explainer; GUI Connect tab + CLI `northkeep connect …`; tests + adversarial
review of the config-write + scope-enforcement path.

**Out:** ChatGPT/other apps (follow once the pattern's proven — the writer is
per-app); auto-detecting whether the target app is installed beyond a best-
effort check; a Windows/Linux config-path matrix (macOS first, matching the
arm64 app).

## Consequences & honest limits (KNOWN-LIMITS)

- **Connect requires the app installed at a stable path.** If the user moves or
  renames `NorthKeep.app`, the registered command path breaks until they
  reconnect. (Reconnect re-resolves and rewrites.)
- **Restart required.** Claude Desktop reads MCP config at launch, so Connect
  ends with a "restart Claude Desktop" prompt.
- **Mode-2 honesty holds:** Connect never redacts the user's chat; that is
  Converse's job. Documented in the UI and KNOWN-LIMITS.

## Acceptance test (Jay-runnable)

From the installed app: Connect tab → **Connect** Claude Desktop (scope
"personal only") → restart Claude Desktop → in a fresh chat, "what do you
remember about me?" surfaces NorthKeep memories, and a `work`-scoped memory is
*not* disclosed (the preset held). **Connect** Claude Code → `claude mcp list`
shows `northkeep` → a fresh `claude` session sees the memory. **Disconnect**
both → the entries are gone and every other key in the configs is untouched
(diff the backup). Confirm the privacy explainer is present and honest.
