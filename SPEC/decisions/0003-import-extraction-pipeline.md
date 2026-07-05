# ADR 0003 — Import and extraction pipeline

- **Date:** 2026-07-04
- **Status:** Accepted (M2)
- **Deciders:** Jay (approved the M2 plan), Claude Code

## Context

M2 turns platform exports (ChatGPT ZIP, Claude export, "paste this prompt"
output) into vault memories. Extraction runs a local model; conversation
plaintext is the most sensitive data the product ever handles.

## Decision 1: Ollama over loopback ONLY — no override

Extraction calls Ollama at `http://127.0.0.1:11434` via Node's built-in
fetch (no new dependency). `NORTHKEEP_OLLAMA_URL` exists for tests and
non-default ports, but any non-loopback hostname is refused with a hard
error — there is deliberately no escape hatch, because a redirected URL
would ship conversation plaintext off the machine (invariant #1). Model:
`llama3.2:3b` (env-overridable per blueprint).

## Decision 2: Review-before-write, candidates never touch disk

Import is extract → dedupe → summary → user approval → write. Candidates
exist only in process memory; there is no staging file (a plaintext staging
file would undo the vault's encryption). `--yes` skips review, `--dry-run`
stops before it. The interactive review runs with the vault CLOSED and
UNLOCKED — extraction (minutes) and human review must never hold the file
lock; the write is a short locked window at the end. Consequence: an MCP
write landing mid-review is deduped against a snapshot, not live state —
harmless (worst case a duplicate the user can forget).

## Decision 3: Degrade loudly to heuristic extraction (invariant #6)

Without Ollama (or when a single generation fails), extraction falls back to
conservative first-person pattern matching at confidence 0.4, and the CLI
prints an unmissable DEGRADED banner with the fix commands. Never silent.

## Decision 4: Lexical dedupe; conflicts flagged, never auto-resolved

Near-duplicates collapse by token Jaccard (≥ 0.6), keeping the
higher-confidence phrasing; 0.35–0.6 similarity against existing vault
entries is surfaced as a possible conflict for the user. No auto-supersede:
contradiction handling stays a human decision until the model-assisted flow
earns trust. Semantic (embedding) dedupe arrives with semantic retrieval.

## Decision 5: ZIP via the OS `unzip` binary

`unzip -p <resolved path> conversations.json` streams one member to stdout —
no extraction to disk, no ZIP library dependency. Paths are `path.resolve`d
so a filename starting with `-` can't parse as a flag. Cost: imports require
macOS/Linux (Windows is post-Phase-4 per the blueprint); an
already-extracted `conversations.json` is accepted directly.

## Model-output trust boundary

LLM output is parsed defensively (`sanitizeCandidates`): JSON may be
malformed, types are clamped to the schema enum, confidence to [0,1],
content to 8–2000 chars, at most 8 candidates per conversation. The
paste-prompt flow trusts a *chatbot's own claims* about the user at
confidence 0.7 — review is the control.

## Dependencies introduced

None. (`@northkeep/importers` and `@northkeep/librarian` are workspace
packages with zero external dependencies.)

## Adversarial review (2026-07-04)

Reviewed with this milestone. Positive assurance: loopback enforcement
(userinfo/lookalike/IPv6 tricks all refused), unzip invocation (no injection),
sanitize clamps, prototype-pollution-safe parsing, lock phasing, nothing
plaintext to disk or the call log. Fixed from the review: `redirect: 'error'`
on all Ollama fetches (a hostile process squatting the port could otherwise
307 the plaintext POST body off-box); C0/C1 control characters stripped from
candidate content in both the LLM and paste paths (terminal escapes could
have made review display something other than what got stored); unzip output
capped at 512 MB. Accepted as LOW: transient memory spike parsing very large
exports (`--limit` applies after parse), noted in KNOWN-LIMITS.md.
