# ADR 0013: Consumer MCP: one-click Connect to Claude Desktop & Claude Code

Status: Accepted 2026-07-12 (M8) · Review: 2026-07-12, safe to ship, no CRITICAL/HIGH findings

## Context
Memory portability via MCP is the mass-market wedge, but connecting meant hand-editing `claude_desktop_config.json` with paths into a dev checkout. The signed `NorthKeep.app` already bundles Node (`Contents/MacOS/northkeep-server`) and the MCP server code, so Connect only has to register it. M8 makes this one click, for Claude Desktop and Claude Code, with scope presets and an honest privacy explainer.

## Decision
- D1: Connect registers the server bundled inside NorthKeep.app. `resolveMcpCommand()` derives the command from `process.execPath` and the resolved bundled `@northkeep/mcp-server/dist/index.js`, so it works from the `.app` or a dev checkout; no user Node, terminal or source needed.
- D2: Writing another app's config is surgical: merge, never overwrite (only `mcpServers.northkeep` or the Claude Code `northkeep` server); back up to `<file>.northkeep-bak` before the first write; Disconnect removes only our entry (an empty `mcpServers` stays); refuse a config that does not parse. Claude Code is registered with `claude mcp add northkeep <command> <args> --scope user` / `claude mcp remove`, falling back to `~/.claude.json` only if the CLI is absent.
- D3: Scope presets ride `NORTHKEEP_SCOPES` (ADR 0006): Everything omits it, Personal only sets `personal`, Custom sets the chosen set.
- D4: The UI states plainly beside Connect that Connect does NOT redact what you type into that app; the redaction firewall is Converse (Mode 1).
- D5: The connected server reads the master key from the macOS Keychain as in ADR 0002; a shared Developer ID signature is expected to let it in without re-prompting (verify on first run). Locked vault returns the existing "vault is locked" message.
- In scope: GUI Connect tab and CLI `northkeep connect`. Out: ChatGPT and other apps, a Windows/Linux config-path matrix (macOS first).

## Consequences
- Easier: a consumer who only downloaded the app can connect without a developer setup; "only my work memories" is an enforced, fail-closed boundary.
- Harder: moving or renaming `NorthKeep.app` breaks the registered path until reconnect. Claude Desktop needs a restart after Connect.
- Limits: connect fails open (owner) on an explicit empty scope ask, surfaced honestly, while the server fails closed on a present-but-empty env. Accepted from review: read-modify-write TOCTOU and a non-atomic backup copy (the live config write is atomic).

## Rejected
The original lists no rejected alternatives; its rules exclude:
- Requiring the repo or a user-installed Node: not a consumer setup.
- Overwriting or hand-editing whole configs: real configs carry unrelated keys and other servers' secrets.
- A new scoping mechanism: `NORTHKEEP_SCOPES` already enforces it.

## What leaves the machine
Not addressed as a section in the original. It states that Connect gives the connected app memory under the chosen scope, and does not redact what the user types into that app, which still sends the chat to its provider (hence D4).

## Links
Full record: docs/design/adr-0013-consumer-mcp.md · Builds on: ADRs 0002, 0006
