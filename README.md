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

## Converse — talk to any model, privately

The Converse tab (and `northkeep converse` in the terminal) is a chat
surface where the privacy runs itself. On every message, Northkeep
retrieves relevant memory, masks secrets *before* anything leaves the
machine, calls the model you picked, restores names in the reply locally,
distills what's worth remembering into the vault (visibly, with one-click
undo), and writes a content-free audit row.

Point it at **any** OpenAI-compatible endpoint — Ollama, LM Studio, vLLM,
llama.cpp on a LAN box, or a hosted API like DeepSeek — or at Claude
natively. An endpoint is just a base URL + model + optional key (keys go to
your macOS Keychain, never to files):

```bash
pnpm northkeep providers add --label "Local" --base-url http://127.0.0.1:11434 --model llama3.2:3b
pnpm northkeep converse
```

Every endpoint wears an honest badge derived from where it actually is:
**private** (loopback or your LAN — nothing leaves your network) or
**bounded** (a cloud host — Tier-1 masking always runs before send, and the
audit log proves what was masked). There is no way to send unredacted text
to a remote endpoint — not a setting, a code path that doesn't exist.

## Bring your memory with you

Easiest: open the app (`northkeep ui`), go to Import, and **drop your whole
ChatGPT or Claude export** — the folder or the .zip. Northkeep finds the
conversation files (even when a big export is split into
`conversations-000.json`, `-001.json`, …), ignores the rest, and figures out
which service it came from.

From the terminal:

```bash
pnpm northkeep import chatgpt ~/Downloads/chatgpt-export-folder   # folder, .zip, or .json
pnpm northkeep import claude ~/Downloads/claude-export.zip
pnpm northkeep import prompt   # prints a prompt to paste into ANY chatbot…
pnpm northkeep import paste its-answer.md   # …and imports what it said
```

Extraction runs entirely on your machine (Ollama + llama3.2:3b — localhost
only, enforced). Every import ends in a review step: nothing enters your
vault unseen.

## Scopes & audit (for professionals)

Run a Northkeep MCP connection scoped to one matter — it physically cannot
read or write anything else:

```json
{ "mcpServers": { "northkeep-henderson": {
  "command": "node",
  "args": ["<repo>/packages/mcp-server/dist/index.js"],
  "env": { "NORTHKEEP_SCOPES": "personal,client:henderson", "NORTHKEEP_REDACT_TIER": "1" }
}}}
```

Then export the audit trail — who asked what, under which grant, what was
disclosed (entry ids + scopes), what was denied — for an auditor:

```bash
pnpm northkeep audit --format csv --out audit.csv
pnpm northkeep scopes   # what's in the vault, and what this session is granted
```

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
