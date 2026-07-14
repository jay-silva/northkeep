# NorthKeep

**Your AI memory belongs to you.**

NorthKeep is a local-first, user-owned memory vault for AI: an encrypted
SQLite vault on your machine, exposed to the AI apps you already use, with
tiered on-device PII redaction and client-side-encrypted sync. Every AI you
use shares one memory of you, and it lives on your computer, not theirs. Set
it up once, and your memory follows *you* across apps instead of being locked
inside any one of them.

NorthKeep works two ways:

- **Connect**, NorthKeep serves your vault to an app you already pay for
  (Claude Desktop, Claude Code) over MCP. Your memory becomes portable across
  those apps and you set, per app, exactly what it may read. It does **not**
  redact what you type into that app, that's ownership and portability, not a
  firewall on your keystrokes.
- **Converse**, you talk *through* NorthKeep instead (the **Chat** tab in the
  app), and it masks sensitive data out of your message *before* it leaves the
  machine, then restores it locally in the reply. This is the real privacy
  firewall, against a local model (free, nothing leaves your network) or a
  cloud model with your own key.

> **One-line version:** connect NorthKeep to the AI apps you already pay for,
> or converse through NorthKeep when privacy has to be absolute.

## Install

**The Mac app (recommended).** Download the signed, notarized DMG, drag
NorthKeep to Applications, and open it, a native window wraps the whole thing,
no terminal required. It also installs a global `northkeep` command. *Apple
Silicon only for now; Intel/Windows/Linux run from source (below).*

**From source (any platform).** Node 20+ and pnpm:

```bash
pnpm install && pnpm build
pnpm northkeep init      # create your encrypted vault (asks for a passphrase)
pnpm northkeep           # the branded home: status + what to do next
pnpm northkeep ui        # or open the app in your browser (this machine only)
```

Everything the app does has a CLI verb; every example below works from the app's
global `northkeep` or, from source, as `pnpm northkeep`.

## Connect an AI app (Mode 1: portable memory)

One command wires NorthKeep into the app, no hand-edited JSON:

```bash
northkeep connect claude-desktop   # writes the MCP config for you (backs up the old one)
northkeep connect claude-code      # or Claude Code
northkeep disconnect claude-desktop
```

Restart the app afterward (it reads MCP config at launch). Now it can read and
write your vault. To hand an app only part of your memory, connect it with a
**scope**, it then physically cannot read anything outside that scope:

```bash
northkeep unlock   # grant background access via your macOS Keychain
northkeep lock     # revoke it
northkeep log      # what every AI app asked of your vault (never the content)
```

Honest boundary: while the vault is unlocked, any app you've connected can read
it (the Keychain grant, same as saved browser passwords). Lock it, or scope the
connection down, to limit that. And Connect can't redact what you type into
someone else's app, for that, use Converse.

## Converse, talk to any model, privately (Mode 2: the firewall)

Converse, the **Chat** tab in the app, or `northkeep converse` in the terminal,
is a chat surface where the privacy runs itself. On every message NorthKeep
retrieves relevant memory,
masks secrets *before* anything leaves the machine, calls the model you picked,
restores names in the reply locally, distills what's worth keeping into the
vault (visibly, with one-click undo), and writes a content-free audit row.

Getting a model connected is guided, pick a provider, paste a key (it goes
straight to your macOS Keychain, never a file), and you're set. Cost is shown
up front:

```bash
northkeep models add       # guided setup for Anthropic, OpenAI, Gemini, xAI, OpenRouter…
northkeep models install   # or pull a local model your Mac can run (via Ollama)
northkeep converse
```

Point it at **any** OpenAI-compatible endpoint, Ollama, LM Studio, vLLM,
llama.cpp on a LAN box, a hosted API, or at Claude natively. Every endpoint
wears an honest badge derived from where it actually is: **private** (loopback
or your LAN, nothing leaves your network) or **bounded** (a cloud host, where
Tier-1 masking always runs before send, and the audit log proves what was
masked). There is no way to send unredacted text to a remote endpoint, not a
setting, a code path that doesn't exist. In **Auto** mode a concierge routes
each message to the cheapest capable model you've connected; you can pin a
model, pin a task to a model, or force private-only.

## Bring your memory with you

Easiest: open the app, go to Import, and **drop your whole ChatGPT or Claude
export**, the folder or the .zip. NorthKeep finds the conversation files (even
when a big export is split into `conversations-000.json`, `-001.json`, …),
ignores the rest, and figures out which service it came from.

```bash
northkeep import chatgpt ~/Downloads/chatgpt-export-folder   # folder, .zip, or .json
northkeep import claude ~/Downloads/claude-export.zip
northkeep import prompt   # prints a prompt to paste into ANY chatbot…
northkeep import paste its-answer.md   # …and imports what it said
```

Extraction runs entirely on your machine (Ollama + a local model, localhost
only, enforced). Every import ends in a review step: nothing enters your vault
unseen.

## Sync it to another machine

Your vault is one encrypted file, so syncing is just moving that encrypted file:
the server only ever sees ciphertext, never a key.

```bash
northkeep sync config --server https://your-sync.example.com
northkeep sync push
northkeep sync status
```

On a **second machine**, copy your `~/.northkeep/device.secret` over (it's the
account root, NorthKeep won't move it for you, by design), then `northkeep sync
pull` and open the vault with your passphrase. Conflicts are version-guarded: if
the vault changed elsewhere, push tells you to pull first (your prior local copy
is kept as `vault.nkv.bak`). It's self-hostable (`apps/sync-server`), or deploy
it to Vercel + Neon. There's a Sync tab in the app too.

The hosted service is **$10/month** (self-hosting is free). Start a subscription
with Stripe-hosted checkout, your card is entered on Stripe and never touches
NorthKeep:

```bash
northkeep sync subscribe   # prints a secure Stripe checkout link
northkeep sync billing     # manage or cancel (Stripe billing portal)
```

We store only whether your subscription is active, linked to your **encrypted**
account, never your card or the contents of your vault.

## Scopes & audit (for professionals)

A NorthKeep connection scoped to one matter physically cannot read or write
anything else. Connect it scoped, optionally with Tier-1 masking on what's
disclosed, then export the audit trail, who asked what, under which grant, what
was disclosed, what was denied, for an auditor:

```bash
northkeep audit --format csv --out audit.csv
northkeep scopes   # what's in the vault, and what a session is granted
```

## Redact before you share

```bash
echo "Call Bob Henderson, SSN 123-45-6789, at 774-555-0134" | northkeep redact --tier 2 --map /tmp/m.json
# → Call Person-1, SSN [SSN_1], at [PHONE_1]
echo "Dear Person-1, ..." | northkeep restore --map /tmp/m.json
```

Tier 1 masks secrets (emails, SSNs, cards, keys) deterministically; Tier 2 swaps
names and orgs for consistent placeholders using a local model and can restore
them in the AI's reply. All on your machine. It's a tool you route text
*through*, NorthKeep can't scrub a prompt you type straight into a chat app,
and doesn't pretend to.

## The promises

- The vault is one encrypted file you can copy, back up, and take anywhere.
- Export is always complete, human-readable JSON (`SPEC/memory-schema.md`).
  Embeddings are disposable cache, never required to rebuild a vault.
- We never see plaintext. No telemetry, none. Crash reports would be opt-in and
  content-free.
- Plaintext never leaves your machine except to the model provider you chose,
  after redaction has run.
- What it **can't** do is written down too, plainly: `KNOWN-LIMITS.md`.

## Layout

- `SPEC/`, the open memory schema (CC-BY-4.0), security model, and ADRs
- `packages/core`, vault: store, schema, crypto, provenance chain
- `packages/redact`, tiered on-device redaction
- `packages/importers`, ChatGPT / Claude / paste import + extraction
- `packages/converse`, providers, model concierge/routing, catalog
- `packages/mcp-server`, the MCP server + one-click Connect
- `packages/sync`, client-side-encrypted sync client
- `packages/cli`, the `northkeep` command
- `apps/web`, the local app (loopback server + single-file UI)
- `apps/desktop`, the Tauri desktop shell (signed DMG)
- `apps/sync-server`, the ciphertext-only sync server (self-hostable)
- `e2e/`, milestone acceptance tests

License: AGPL-3.0 (the schema spec itself is CC-BY-4.0).
