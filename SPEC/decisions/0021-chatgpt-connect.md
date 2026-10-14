# ADR 0021: Extend Connect to ChatGPT (Codex config.toml)

Status: Accepted 2026-07-17 (extends ADR 0013) · Review: no adversarial review recorded

## Context
ADR 0013 made one-click Connect register NorthKeep's bundled stdio MCP server with Claude Desktop and Claude Code. Jay asked for ChatGPT. The primary source (`learn.chatgpt.com/docs/extend/mcp`, checked 2026-07-17) says the consumer ChatGPT desktop app, Codex CLI and IDE extension read local stdio MCP servers from a shared `~/.codex/config.toml`, which supports an `env` table, so the `NORTHKEEP_SCOPES` allowlist stays enforceable. The hosted connector (ADR 0019) remains the remote path; this is the local, no-server one.

## Decision
- D1: `connect chatgpt` writes `[mcp_servers.northkeep]` with `command`/`args` from `resolveMcpCommand()` (the Node bundled in `NorthKeep.app`), plus `[mcp_servers.northkeep.env]` with `NORTHKEEP_SCOPES` when a scope preset is chosen. The user is told to restart ChatGPT. Codex CLI and the IDE extension get it too.
- D2: A text-surgical writer, not a parse/serialize round-trip, because `config.toml` is hand-edited with comments and holds other servers' secrets:
  1. Parse with `smol-toml` only to refuse an unparseable file.
  2. Text-strip our `[mcp_servers.northkeep]` table and its subtables, leaving every other line byte-for-byte.
  3. If the parsed config still shows `mcp_servers.northkeep` (inline or dotted form), abort and tell the user to remove it and reconnect.
  4. Append our table.
  5. Re-parse and verify our entry decodes to the intended values, then write atomically (temp + rename), mode-preserving (new files 0600), after a one-time backup to `<file>.northkeep-bak`.
  Disconnect uses the same strip-and-refuse path.
- D3: Add `smol-toml` (pure JS, no network access, MIT) to `@northkeep/mcp-server`, for validation and post-write verification only. Invariant #7 does not gate it; it is recorded per the dependency-documentation rule.

## Consequences
- Easier: a consumer with only the app connects ChatGPT with no repo, terminal or separate Node.
- Harder: ChatGPT/Codex must be restarted to load the change. An existing inline or dotted NorthKeep entry is refused, not rewritten.
- Limits: as in ADR 0013, Connect hands ChatGPT owned memory under the chosen scope; it does not redact what you type into ChatGPT (use Converse for that). ChatGPT is offered even if not installed.
- Committed to: Codex tests in `packages/mcp-server/test/connect.test.ts` via `NORTHKEEP_CODEX_CONFIG`, covering preserved comments and secrets, no duplicates, refusal cases, one backup.

## Rejected
- Round-trip TOML serialization: drops comments and reorders keys in a file holding others' secrets.
- A hand-written TOML parser: exactly the kind of parser the invariants warn against.
- Rewriting inline or dotted entries: risks mangling; fail closed instead.

## What leaves the machine
No separate section in the original. Per its limits: Connect hands ChatGPT your memory under the chosen scope through the local stdio server, as in ADR 0013, and does not redact what you type into ChatGPT.

## Links
Extends: ADR 0013 · Related: ADR 0019 · Full record: docs/design/adr-0021-chatgpt-connect.md
