# NorthKeep — Codex Instructions

## What this is
A local-first, user-owned memory vault for AI. Encrypted SQLite vault on the user's
machine, exposed to AI apps via MCP, with tiered on-device PII redaction and
client-side-encrypted sync. The user owns the memory; we never see plaintext,
except scopes the user explicitly shares to the opt-in connector (invariant #2).
Read SPEC/memory-schema.md and SPEC/security-model.md before any structural work.

## Founder context
The founder (Jay) is a compliance professional, not an engineer. Therefore:
- Explain consequential technical choices in plain language before implementing.
- Every milestone must end with an acceptance test Jay can run himself from the
  CLI, copy-paste exact commands.
- Write an ADR in SPEC/decisions/ for every consequential choice (schema changes,
  crypto, dependencies with network access, licensing-relevant code). See the
  review gate below for when an adversarial review is required too.

## Review gate

An ADR **and** an adversarial review are required before implementing anything
that changes what leaves the machine, changes who decides (permission gates,
grants, approvals, the privacy ceiling), puts untrusted input in front of the
model or a human review surface, touches crypto or key handling, or adds a
dependency with network access — and before publishing a claim about what the
system enforces. The review verifies against code, not prose; findings are
recorded in the ADR itself; a clean result is stated plainly. Ordinary work
(copy fixes, refactors that cross no boundary, tests, build tooling) does not
need this. CLAUDE.md carries the full statement of this gate; if the two ever
disagree, CLAUDE.md wins.

## Non-negotiable invariants (violating these is a critical bug)
1. Plaintext memory content NEVER leaves the machine except (a) to the model
   provider the user explicitly selected, after the active redaction tier has
   run, (b) content in scopes the user has explicitly, individually marked
   Shared, which is copied to NorthKeep's connector store so the user's own AI
   apps can reach it, or (c) the arguments of a tool call the user allowed —
   whether to a web tool's destination or to a tool server the user explicitly
   connected that runs off this machine — screened for secret shapes, protected
   names and vault content while still unmasked, then masked by the tool-egress
   redaction floor before they are sent, and only per call or under a grant the
   user created at a live prompt and can revoke. Default is private; sharing is
   per-scope, opt-in, loudly confirmed, badge-visible, and reversible with
   server-side deletion. Under (c) NorthKeep sends only those arguments: never
   the vault, never the transcript. This invariant bounds what NORTHKEEP
   transmits — a tool server running on this machine is outside that boundary
   rather than an exception to it, because a local program the user installed
   may forward what it is given (many wrap a cloud API) and that is its egress,
   not ours, which is why arguments to a `strict` server get the tool-egress
   redaction floor before it sees them.
2. Our vault-sync server stores ciphertext only. No plaintext, no derived
   plaintext (no server-side embeddings, logs, or analytics on content). The
   connector store is a separate opt-in service; it stores shared-scope content
   encrypted at rest (ciphertext only, never private scopes) and keeps no key in
   that database that can read it: the key is rebuilt for each request from the
   connected app's own credential plus a secret held on our server. It decrypts
   transiently to serve each legitimate request (so a compromised runtime is not
   protected against), and it derives nothing from content (no embeddings, no
   content logs, no analytics). Scope names, entry ids, counts, ciphertext sizes,
   and timestamps remain visible to it.
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
SQLite (better-sqlite3; sqlite-vec is planned, not shipped — semantic search
ranks embeddings in-process). @modelcontextprotocol/sdk (stdio first). Ollama for local
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
