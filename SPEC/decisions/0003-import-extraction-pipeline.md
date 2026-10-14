# ADR 0003: Import and extraction pipeline

Status: Accepted 2026-07-04 (M2) · Review: adversarial review 2026-07-04, positive assurance with fixes applied (see design file)

## Context
M2 turns platform exports (ChatGPT ZIP, Claude export, "paste this prompt" output) into vault memories. Extraction runs a local model, and conversation plaintext is the most sensitive data the product ever handles.

## Decision
- D1: Extraction calls Ollama at `http://127.0.0.1:11434` with Node's built-in fetch. `NORTHKEEP_OLLAMA_URL` exists for tests and non-default ports, but any non-loopback hostname is a hard error, with no escape hatch. All Ollama fetches use `redirect: 'error'`. Model: `llama3.2:3b` (env-overridable).
- D2: Import is extract, dedupe, summary, user approval, write. Candidates live only in process memory; there is no staging file. `--yes` skips review, `--dry-run` stops before it. Review runs with the vault closed and unlocked; the write is a short locked window at the end, so an MCP write mid-review is deduped against a snapshot (worst case a duplicate the user can forget).
- D3: Without Ollama, or when one generation fails, extraction falls back to conservative first-person pattern matching at confidence 0.4, and the CLI prints a DEGRADED banner with the fix commands. Never silent.
- D4: Near-duplicates collapse by token Jaccard (>= 0.6), keeping the higher-confidence phrasing. Similarity 0.35 to 0.6 against existing entries is shown as a possible conflict. No auto-supersede.
- D5: ZIPs are read with the OS `unzip -p <resolved path> conversations.json`, streaming one member to stdout, with paths `path.resolve`d so a leading `-` cannot be a flag. Output capped at 512 MB. An extracted `conversations.json` is accepted directly.
- D6: Model output is parsed defensively (`sanitizeCandidates`): types clamped to the schema enum, confidence to [0,1], content to 8 to 2000 chars, at most 8 candidates per conversation, C0/C1 control characters stripped. Paste-prompt claims enter at confidence 0.7; review is the control.

## Consequences
- Easier: no new dependency; `@northkeep/importers` and `@northkeep/librarian` have zero external dependencies.
- Harder: imports require macOS/Linux (Windows is post-Phase-4).
- Limits: parsing very large exports causes a transient memory spike (`--limit` applies after parse), accepted as LOW and noted in KNOWN-LIMITS.md. Semantic dedupe waits for semantic retrieval.

## Rejected
- A configurable non-loopback Ollama URL: a redirected URL would ship conversation plaintext off the machine.
- A plaintext staging file: it would undo the vault's encryption.
- Auto-resolving conflicts: contradiction handling stays a human decision until the model-assisted flow earns trust.
- A ZIP library: the OS binary avoids a dependency and extraction to disk.

## What leaves the machine
No separate section in the original. Its controls keep extraction on the machine: Ollama calls are loopback-only with redirects refused, and the review found nothing plaintext written to disk or the call log.

## Links
Full record: docs/design/adr-0003-import-extraction-pipeline.md
