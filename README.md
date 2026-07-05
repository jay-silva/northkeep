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
pnpm northkeep ui        # opens the app in your browser (this Mac only)
```

Prefer the terminal? Every action has a CLI verb:

```bash
pnpm northkeep remember "I prefer concise answers" --type semantic
pnpm northkeep list
pnpm northkeep export
```

## The app

`northkeep ui` opens a local page — browse and search your memories, import
ChatGPT/Claude exports with a review screen, and see the activity log of what
every AI asked of your vault. A native desktop window (Tauri) wraps the same
UI: `pnpm tauri dev`. Everything is served from 127.0.0.1 behind a
per-session token; nothing leaves the machine.

## Bring your memory with you

```bash
pnpm northkeep import chatgpt ~/Downloads/chatgpt-export.zip   # Settings → Data Controls → Export
pnpm northkeep import claude ~/Downloads/claude-export.zip
pnpm northkeep import prompt   # prints a prompt to paste into ANY chatbot…
pnpm northkeep import paste its-answer.md   # …and imports what it said
```

Extraction runs entirely on your machine (Ollama + llama3.2:3b — localhost
only, enforced). Every import ends in a review step: nothing enters your
vault unseen.

## Redact before you share

```bash
echo "Call Bob Henderson, SSN 123-45-6789, at 774-555-0134" | pnpm northkeep redact --tier 2 --map /tmp/m.json
# → Call Person-1, SSN [SSN_1], at [PHONE_1]
#   …paste the redacted text into any AI, then restore its reply:
echo "Dear Person-1, ..." | pnpm northkeep restore --map /tmp/m.json
```

Tier 1 masks secrets (emails, SSNs, cards, keys) deterministically; Tier 2
swaps names and orgs for consistent placeholders using a local model and can
restore them in the AI's reply. All on your machine. It's a tool you route
text through — Northkeep can't scrub a prompt you type straight into a chat
app, and doesn't pretend to.

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
