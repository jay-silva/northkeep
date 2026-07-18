# ADR 0021 — Extend Connect to ChatGPT (Codex config.toml)

- **Date:** 2026-07-17
- **Status:** Accepted (extends ADR 0013)
- **Deciders:** Jay (asked for ChatGPT support in Desktop Connect), Claude Code

## Context

ADR 0013 made one-click Connect register NorthKeep's bundled stdio MCP server
with **Claude Desktop** (hand-edited JSON) and **Claude Code** (via the `claude`
CLI). Jay asked for the same for **ChatGPT**.

Two things had to be true for this to be honest, and both were verified against
the primary source (`learn.chatgpt.com/docs/extend/mcp`, 2026-07-17):

1. The **consumer ChatGPT desktop app** — not only the Codex CLI — reads local
   **stdio** MCP servers. The doc: the ChatGPT desktop app, Codex CLI, and IDE
   extension "support MCP servers and share MCP configuration for the same Codex
   host."
2. That shared config lives at **`~/.codex/config.toml`**, registers a stdio
   server as a `[mcp_servers.<name>]` table with `command` / `args`, and supports
   an `env` table — so our `NORTHKEEP_SCOPES` capability allowlist (M4, enforced
   fail-closed) survives and stays enforceable.

(A remote path to ChatGPT already exists via the hosted **connector** — ADR 0019
— which ChatGPT reaches as a custom OAuth connector. This ADR is the *local*,
no-server, no-subscription path, matching Claude Desktop.)

## Decision 1: Register in `~/.codex/config.toml`, same bundled server as ADR 0013

`connect chatgpt` writes:

```toml
[mcp_servers.northkeep]
command = "<the running node binary>"
args = ["<…/@northkeep/mcp-server/dist/index.js>"]

[mcp_servers.northkeep.env]      # only when a scope preset is chosen
NORTHKEEP_SCOPES = "work,personal"
```

`command`/`args` come from the same `resolveMcpCommand()` used for the other
targets (the Node bundled inside `NorthKeep.app`), so a consumer who only
downloaded the app needs no repo, terminal, or separate Node. Registering here
also lights up the Codex CLI and IDE extension for free (they share the file).
The user is told to **restart ChatGPT** (it reads the config only at launch).

## Decision 2: TOML gets a text-surgical writer, not a round-trip (crown-jewel invariant)

The crown-jewel invariant of ADR 0013 — *we edit files we don't own; touch ONLY
`mcp_servers.northkeep`, back up once, refuse an unparseable file, preserve
everything else* — applies here too, but TOML raises the stakes over Claude
Desktop's JSON in two ways: `config.toml` is **routinely hand-edited with
comments** and holds **other MCP servers' secrets** in their `env` tables. A
parse→serialize round-trip (what the JSON writer does) would drop comments and
reorder keys. So the ChatGPT writer preserves the file text **verbatim** and
rewrites only our own table:

1. **Parse** with a real TOML reader (`smol-toml`) purely to **refuse** an
   unparseable file before touching anything.
2. **Text-strip** our canonical `[mcp_servers.northkeep]` table and any
   `[mcp_servers.northkeep.<sub>]` subtables, leaving every other line —
   comments, other servers, root keys, blank lines — byte-for-byte.
3. **Refuse, don't mangle:** if after stripping the parsed config still shows an
   `mcp_servers.northkeep` (i.e. it was declared as an inline table or dotted
   keys, a form we don't rewrite), abort with a clear message telling the user to
   remove that entry and reconnect. Fail closed; never duplicate or corrupt.
4. **Append** our freshly-rendered table.
5. **Verify before writing:** re-parse the result and confirm our entry decoded
   to exactly the intended `command`/`args` (and `NORTHKEEP_SCOPES` when scopes
   were given). Only then write, **atomically** (temp + rename) and
   **mode-preserving** (new files 0600, since the file can hold others' secrets),
   after a **one-time backup** to `<file>.northkeep-bak`.

Disconnect uses the same strip-and-refuse path, removing only our table(s).

## Decision 3: `smol-toml` dependency

Reading/validating TOML by hand is exactly the kind of parser the invariants
warn against, so we take a dependency: **`smol-toml`** (spec-compliant, pure JS,
no network access, small, actively maintained, MIT) in `@northkeep/mcp-server`.
It is used only to parse for validation and post-write verification; writing is
our own text splice. Invariant #7 (ADR + Jay's OK for **network-access** deps)
does not gate it — it has none — but it is recorded here per the standing
"document consequential dependency choices" rule.

## Honest limits

- ChatGPT/Codex must be **restarted** to load the change.
- If NorthKeep was previously registered in `config.toml` in an inline/dotted
  form (e.g. by hand), Connect refuses rather than risk mangling it; the user
  removes that line and reconnects.
- Same Mode-2 honesty as ADR 0013: Connect hands ChatGPT your owned memory under
  the chosen scope; it does **not** redact what you type into ChatGPT. For a
  redaction firewall over your chat, use Converse.
- We offer ChatGPT unconditionally (like Claude Desktop), even if it isn't
  installed yet — writing the config is harmless and the restart note is honest.

## Testing

`packages/mcp-server/test/connect.test.ts` gains a Codex suite (via a
`NORTHKEEP_CODEX_CONFIG` path override, so no real config is touched): creates a
clean table; writes `NORTHKEEP_SCOPES`; **preserves other servers, root keys, and
comments including a secret**; reconnect replaces (never duplicates); disconnect
removes only ours; backs up once; **refuses** an unparseable file and an
inline-form northkeep entry; status reflects connected + scopes.

## Acceptance test (Jay)

```
northkeep connect chatgpt --scope work
cat ~/.codex/config.toml            # shows [mcp_servers.northkeep] + env, your other keys/comments intact
# restart ChatGPT, open a new chat, enable the NorthKeep connector, ask something from "work"
northkeep disconnect chatgpt        # removes only our table
```
