# ADR 0033: The MCP client trust model (M11 foundation)

Status: Accepted 2026-07-25, implemented by M11 · Review: none recorded · http identity superseded by ADR 0035; GUI add route by ADR 0034; vault-server trust corrected by ADR 0060 (2026-09-24)

Superseded in part by ADR 0066 (accepted 2026-10-15): Converse is no longer presented as a product mode.

## Context
M11 makes the harness an MCP client of servers we did not write. Grants keyed on host, our own tool definitions, and a visible destination no longer hold.

## Decision
- D1: Grants key on `(server, tool)` plus a launch fingerprint. stdio: hash of the resolved command path (symlinks re-resolved at launch), argv, working directory and configured env names and values; absolute path, `PATH` never consulted. A mismatch means every call asks again. http origins are ADR 0035.
- D2: Tool definitions are untrusted input, more dangerous than results. Every tool is namespaced `server__tool`, server ids `[a-z0-9-]+`. Definitions are fenced, size-capped and pinned: sha256 over canonical JSON of every tool's `name`, `description` and `inputSchema`; a change re-asks. `notifications/tools/list_changed` invalidates the connection immediately. Server text never alters gating, tiering, budgets or audit. Every successful tool result is fenced.
- D3: MCP arguments get the deterministic Tier-1 mask over string leaves before the server sees them. Tier 3 is the target, not shipped (it would refuse whenever Ollama stops; if adopted, that refusal must be loud). Relaxing is user-declared trust, never inferred. Per ADR 0060, the catalog's vault server is added `trusted`; an older install keeps `strict` until the user confirms, behind the passphrase, for the exact bundled launch only; the launch pin cannot detect that file replaced in place.
- D4: `always` is offered only for `safe-read` tools; consequential tools ask every time. `never` is always available. Risk is user-declared per tool; unclassified means consequential.
- D5: The vault's own server goes first, through the identical gate; disclosure is logged per call.
- D6: The model can never add servers, edit fingerprints or change trust.

## Consequences
- Limits (KNOWN-LIMITS): a local server is a program with the user's privileges. The fingerprint detects configuration changes, not program changes: a replaced file or changed `node_modules` keeps it identical. A loopback http origin is a port any local process can claim. Namespacing stops shadowing, not persuasive descriptions. An MCP server fronting a paid API has no spend cap until a per-server call cap exists.
- Not in M11: filesystem or browser tools, discovery, sampling.

## Rejected
- Connect-time-only pin: theatre.

## What leaves the machine
The original has no egress section. It states MCP arguments are Tier-1 masked before the server sees them unless the user declared the server `trusted` (or, per the ADR 0060 correction, it is the catalog vault server). Its limits say: "We can prove what we sent a server. We cannot prove what it did next", and the proof must say so. `@modelcontextprotocol/sdk` is already in the tree, so no new networked dependency.

## Links
Parents: ADRs 0027, 0029 · Superseded in part by: ADRs 0034, 0035 · Corrected by: ADR 0060 · Full record: docs/design/adr-0033-mcp-client-trust-model.md
