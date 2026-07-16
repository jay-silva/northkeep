# NorthKeep — Codex Instructions

## What this is
A local-first, user-owned memory vault for AI. Encrypted SQLite vault on the user's
machine, exposed to AI apps via MCP, with tiered on-device PII redaction and
client-side-encrypted sync. The user owns the memory; we never see plaintext.
Read SPEC/memory-schema.md and SPEC/security-model.md before any structural work.

## Founder context
The founder (Jay) is a compliance professional, not an engineer. Therefore:
- Explain consequential technical choices in plain language before implementing.
- Every milestone must end with an acceptance test Jay can run himself from the
  CLI, copy-paste exact commands.
- Write an ADR in SPEC/decisions/ for every consequential choice (schema changes,
  crypto, dependencies with network access, licensing-relevant code).

## Non-negotiable invariants (violating these is a critical bug)
<!-- DRAFT (ADR 0019, phase C5): invariants #1 clause (b) and #2's connector
     sentence re-word the opt-in per-scope connector. Pending Jay's compliance
     sign-off before any design partner shares real memory. Keep verbatim-in-sync
     with CLAUDE.md. -->
1. Plaintext memory content NEVER leaves the machine except (a) to the model
   provider the user explicitly selected, after the active redaction tier has
   run, or (b) content in scopes the user has explicitly, individually marked
   Shared, which is copied to NorthKeep's connector store so the user's own AI
   apps can reach it. Default is private; sharing is per-scope, opt-in, loudly
   confirmed, badge-visible, and reversible with server-side deletion.
2. Our vault-sync server stores ciphertext only. No plaintext, no derived
   plaintext (no server-side embeddings, logs, or analytics on content). The
   connector store is a separate opt-in service; it holds plaintext of shared
   scopes only, never private scopes, never keys, and derives nothing from
   content (no embeddings, no content logs, no analytics).
3. No hand-rolled crypto. libsodium primitives only. Key handling changes require
   an explicit adversarial-review session before merge.
4. The vault file must remain portable and text-canonical: export must always
   produce complete, human-readable JSON per SPEC/memory-schema.md. Embeddings
   are disposable cache — never required to rebuild a vault.
5. No telemetry. None. Crash reports are opt-in and content-free.
6. Degrade privacy loudly: if Tier-2 redaction is unavailable (no Ollama), the
   user must be told visibly. Never silently drop a privacy tier.
7. New dependencies with network access require an ADR and Jay's explicit OK.

## Stack (decided — do not relitigate)
TypeScript / Node 20+, pnpm monorepo per 03-BUILD-BLUEPRINT.md structure.
SQLite + sqlite-vec. @modelcontextprotocol/sdk (stdio first). Ollama for local
models (llama3.2:3b extraction, nomic-embed-text embeddings), graceful degradation
without it. sodium-native for crypto. Vitest for tests. Stripe (Phase 3).

## Engineering standards
- Tests with every feature: unit tests + one e2e scenario per milestone in /e2e.
- The e2e "leak test" (seeded-secrets corpus through the redaction pipeline,
  zero Tier-1 misses) runs in CI on every commit once M3 lands.
- Small commits, imperative messages, tag a release every Friday.
- Keep KNOWN-LIMITS.md current — honesty about limits is a product feature.
- Prefer boring, popular, audited dependencies; total dependency count is a
  metric to minimize, not a convenience.

## Milestones
Work one milestone at a time per 03-BUILD-BLUEPRINT.md §3 (M0–M5). State which
milestone the session targets at the start. Do not begin the next milestone
until Jay confirms the current acceptance test passed on his machine.
