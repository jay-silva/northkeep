# NorthKeep: instructions for coding agents

## What this is
A local-first, user-owned memory vault for AI: memories and projects,
coordinated across the user's AI apps. Encrypted SQLite vault on the user's
machine, exposed to AI apps via MCP, with tiered on-device PII redaction and
client-side-encrypted sync. The user owns the memory; we never see plaintext,
except scopes the user explicitly shares to the opt-in connector (invariant #2).
Read SPEC/memory-schema.md and SPEC/security-model.md before any structural work.
Current decisions are the ADRs in SPEC/decisions/ (highest number is newest);
docs/design/ holds the full design records behind those short ADRs.
KNOWN-LIMITS.md is what the product does not do.

Jay, the founder, is a compliance professional, not an engineer. Explain
consequential technical choices in plain language before implementing.

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
   server-side deletion. One named exception to "loudly confirmed" (ADR
   0050): an unshared project scope with no live entry on this device, when
   a connected app's rows for it arrive and exactly one of them is the
   project document, is marked Shared without a dialog and receives exactly
   those rows; from then on it is an ordinary shared scope (everything later
   written into it is pushed, badge-visible, unshare revokes it). Any other
   rows a connected app sends to an unshared project scope are held,
   unapplied, until the user shares the scope.
   Under (c) NorthKeep sends only those arguments: never the vault, never
   the transcript. This invariant bounds what NORTHKEEP
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

## Review gate

An ADR **and** an adversarial review are required before implementing anything
that:

- changes **what leaves the machine** — a new egress path, a new recipient, or a
  change to redaction, tiers, or screening;
- changes **who decides** — permission gates, grants, approvals, the privacy
  ceiling;
- puts **untrusted input** in front of the model, or in front of a human review
  surface (a server's own tool descriptions, a fetched page, an error message
  from a third party);
- touches **crypto or key handling** (invariant #3 already requires this);
- adds a **dependency with network access** (invariant #7).

It is also required before **publishing a claim** about what the system enforces
— in KNOWN-LIMITS.md, an ADR, the site, or release notes. For this product a
false claim is a defect, so a claim ships under the same gate as the code.

**Ordinary work does not need this**, and saying so is part of the rule: copy
fixes, refactors that cross no boundary, tests, build tooling. A gate that covers
everything gets routed around, and a routed-around gate weakens the ones that
matter.

How the review has to be run, learned by doing it badly first:

- **It verifies against CODE, not against the document's prose.** Every finding
  worth having came from opening files and checking, not from reading the claim
  and judging it plausible.
- **Findings are recorded in the ADR itself**, so the document carries its own
  history instead of the reasoning living in a commit message nobody reads.
- **A clean result is stated plainly.** "Nothing found, here is what I tried" is
  a result, not a failure.

**Before any release, do a doc-versus-code pass** over KNOWN-LIMITS and every
ADR claim about current behaviour. Prose that was true when written stops being
true when the next decision lands, and *nothing fails when it does* — no test
catches this, and it is the most common way this repo has been wrong.

## How work runs here
- One milestone at a time; say which one the session targets. Each ends with
  an acceptance test Jay runs himself: copy-paste commands. Run it yourself on
  throwaway data (a temp vault directory, never Jay's vault) first. Do not
  start the next milestone until Jay says it passed on his machine.
- An ADR in SPEC/decisions/ (shape of 0063) for every consequential choice:
  schema, crypto, dependencies with network access, licensing-relevant code.
  Add the adversarial review whenever the gate above applies.
- Docs and ADRs stay under 500 words; long reasoning goes in docs/design/.
  Update KNOWN-LIMITS.md in the same PR as the behaviour it describes.
- Tests with every behaviour change. Small commits, imperative messages.
- Branches and pull requests only. Jay merges; agents never push to main.
- Prefer boring, popular, audited dependencies, and as few as possible.

## Ship safely
- Tests, as CI runs them after `pnpm install --frozen-lockfile && pnpm build`:
  `pnpm exec vitest run packages/redact/test/leak.test.ts` (the leak gate,
  zero Tier-1 misses, runs first), then `pnpm test`, then
  `pnpm exec vitest run --config e2e/vitest.config.ts`. Run them as a
  non-root user; root ignores file permissions and some tests fail.
- main is production. A push to main redeploys apps/sync-server and
  apps/connector-server through Vercel's Git integration (see
  .github/workflows/hosted-probe.yml), so merging stays with Jay.
- A release bumps `version` in apps/desktop/src-tauri/tauri.conf.json,
  `APP_VERSION` in apps/web/src/api.ts, and `buildNumber` (and `version`)
  in apps/mobile/app.config.ts. Release 0.24.0 (6bebcf3) is the pattern.
- Mac signing and notarization: scripts/desktop-bundle/README.md. The Apple
  credentials are environment variables on Jay's machine; none are in the repo.
- Schema changes are a new sequential step in `migrate()` in
  packages/core/src/vault.ts; an older build refuses a newer vault. An MCP
  server keeps the code it started with, and orphaned old servers once broke
  writes in three apps at once (packages/mcp-server/src/server.ts, around
  line 1276). Keep its exit-on-close and out-of-date exit working.
- Stack (decided, do not relitigate): TypeScript, Node 20+ (CI and the
  desktop sidecar use 24), pnpm workspace, better-sqlite3, sodium-native,
  @modelcontextprotocol/sdk, Ollama for local models with graceful
  degradation, Vitest, Tauri desktop, Expo iPhone app, Stripe billing in
  apps/sync-server.
