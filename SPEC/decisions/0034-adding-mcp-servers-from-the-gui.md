# ADR 0034: Adding an MCP server from the GUI

Status: Accepted 2026-07-25 (implemented 2026-07-25); amended 2026-07-25 by ADR 0035 · Review: the property wording was sharpened after review; no verdict is recorded in the original

## Context
In M11 only the CLI could add an MCP server, so app-only users could not use MCP. An add route is no real escalation against attackers the design currently stops (local processes can already write `~/.northkeep/mcp.json`; remote callers lack the custom-header token, and the Host check stops DNS rebinding; `net.ts` keeps `web_fetch` off loopback, ADR 0028). The genuine concern: a free-form add would turn a confidentiality failure (an SSRF classifier gap, three found and fixed so far, or a leaked token) into persistent code execution. Adding does not spawn; inspecting does.

## Decision
- Property preserved: causing NorthKeep to spawn an attacker-chosen program must require something an automated caller cannot produce, even holding a valid session token. An automated caller can at most add a server we vetted, whose command comes from our template.
- D1: A catalog (mirroring M9's `KNOWN_PROVIDERS`) covers the common case, starting with NorthKeep's own vault server. The request carries only a catalog id; command, arguments and environment come from our template. Catalog adds need no extra authentication.
- D2: A free-form path requires re-authentication with the vault passphrase, verified through the same derive-and-open path as `/api/unlock`. It is side-effect free: it proves the key, zeroes it, and changes no session state.
- D3: GUI free-form commands must resolve inside an allowlisted root: the app's own resources, `~/.northkeep/mcp-servers/`, `/opt/homebrew`, `/usr/local`. Anything else is refused by name with the CLI offered. The CLI stays unrestricted.
- D4: The GUI form does not accept environment variables (`--env` is stored in plain text in `mcp.json`); catalog templates may set what their server needs.
- Amendment (ADR 0035, M12): a GUI remote-add route exists and is not passphrase-gated, because it stores an address and spawns nothing. The passphrase gate for a remote server sits on connecting.

## Consequences
- Easier: app-only users can add NorthKeep's own server in one click.
- Harder: custom paths cost a passphrase entry (about 1s Argon2id) and must live in an allowed root.
- Limits: the passphrase gate stops automated callers, not a human at an unlocked machine. A catalog entry is still a program; vetting means we chose it, and it goes through the same review, pin and approval flow. An added server offers no tools until its definitions are approved (ADR 0033 Decision 2).

## Rejected
- A native Tauri confirmation dialog (not built, worth revisiting): new plumbing; the passphrase gives the same property against automated callers.
- A directory allowlist on the CLI: protects nobody who already has a shell.
- Auto-installing third-party servers: the catalog never downloads.

## What leaves the machine
Not addressed in the original record; see the design file.

## Links
Full record: docs/design/adr-0034-adding-mcp-servers-from-the-gui.md · Parent: ADR 0033 · Amended by: ADR 0035 · Related: ADR 0028
