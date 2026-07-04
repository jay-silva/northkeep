# Northkeep

**Your AI memory belongs to you.**

Northkeep is a local-first, user-owned memory vault for AI: an encrypted
SQLite vault on your machine, exposed to AI apps via MCP, with tiered
on-device PII redaction and client-side-encrypted sync. Every AI you use
shares one memory of you — and it lives on your computer, not theirs.

> Early development. M0 (vault core) and M1 (MCP server) are complete:
> encrypted vault, `init | remember | list | forget | export` CLI, and an
> MCP server so Claude Desktop (or any MCP client) can store and retrieve
> memories — with every call visible in `northkeep log`. Importers,
> redaction, scoped access, and sync land next.

## Quick start

```bash
pnpm install && pnpm build
pnpm northkeep init
pnpm northkeep remember "I prefer concise answers" --type semantic
pnpm northkeep list
pnpm northkeep export
```

## Connect an AI app (MCP)

```bash
pnpm northkeep unlock   # grants background access via your macOS Keychain
pnpm northkeep lock     # revokes it
pnpm northkeep log      # what every AI app asked of your vault (never content)
```

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "northkeep": {
      "command": "node",
      "args": ["<absolute path to repo>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## The promises

- The vault is one encrypted file you can copy, back up, and take anywhere.
- Export is always complete, human-readable JSON (`SPEC/memory-schema.md`).
- We never see plaintext. No telemetry, none.
- What it can't do is written down too: `KNOWN-LIMITS.md`.

## Layout

- `SPEC/` — the open memory schema (CC-BY-4.0), security model, and ADRs
- `packages/core` — vault: store, schema, crypto, provenance chain
- `packages/cli` — the `northkeep` command
- `e2e/` — milestone acceptance tests

License: AGPL-3.0 (the schema spec itself is CC-BY-4.0).
