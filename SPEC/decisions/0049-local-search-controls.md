# ADR 0049: Explicit local-search controls

Status: Implemented; owner approved the UI mock · Review: final independent review CLEAN / PASS · Ships first in release 0.22.0 (correction 2026-09-24); installed-app acceptance of the fixed build is still pending

## Context
Mac Memories search sent users to a terminal to start Ollama and fetch the embedding model; setup conflated a stopped runtime with a missing install.

## Decision
- D1: An inline search status with an explicit start action for the installed Ollama Mac app; keyword search stays available. No installing Ollama and no new dependency.
- D2: Startup is a POST-only route behind the loopback Host/session-token boundary, requiring an unlocked vault, the desktop marker and macOS. It accepts no arguments and runs `/usr/bin/open` with fixed arguments via execFile, no shell. Work is bounded and coalesced; errors carry no subprocess output.
- D3: Runtime and embedding-model availability are reported separately. A bare model name matches exactly or its `:latest` tag; an explicit tag needs exact equality; prefixes never count. (d4455b3 applied this to the review path and CLI.)
- D4: Downloading the model is a separate click, using the existing loopback client and fixed configured tag. Jobs coalesce, use the one-hour client timeout, keep at most 32 completed receipts, and never register the model as a chat endpoint.
- D5: Memories excludes project scopes before ranking, limits, counts and navigation.
- D6 (2026-09-12 fix): `createCachedEmbedder`, an in-process LRU (8192 entries) keyed by model plus SHA-256 of the text; no disk, no vault bytes; `/api/lock` clears it. A repeated search went from about 20 s to 0.04 to 0.08 s.
- D7 (owner, 2026-09-12): warm on open, superseding the original "no model launch because a page loads" for the embedding model only. `apps/web/src/search-warm.ts` runs once per unlocked session, may call the same gated start route, never downloads, embeds outside the vault lock, writes nothing, stops on lock or failure, backs off 60 s. Open: the original forbade starting a service automatically; the record does not reconcile that with the warmer starting Ollama.
- D8 (owner, 2026-09-13): MCP `memory_retrieve` searches by meaning via `retrieveSemantic` and the same cached loopback embedder, reporting `search_mode` and a fallback `note`; candidates are embedded outside the vault lock.

## Consequences
- Easier: no terminal needed; agents and the app rank alike.
- Harder: the first search per launch pays the full embedding cost; the page says so.
- Limits: no visual browser verification or native launch acceptance is claimed; automated tests mock launch and network.

## Rejected
- Installing Ollama; arbitrary service managers or client-supplied paths.
- Automatic model download.

## What leaves the machine
The original has no egress section; its review gate states no new egress path or recipient. The model pull uses the existing registry download boundary and sends no vault content. Plaintext goes only to the loopback embedder, now once per process instead of once per search; `@northkeep/librarian` talks only to the loopback Ollama runtime.

## Links
Full record: docs/design/adr-0049-local-search-controls.md · Related: ADRs 0014, 0044
