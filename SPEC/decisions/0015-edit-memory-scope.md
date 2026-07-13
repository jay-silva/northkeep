# ADR 0015 — Editing a memory's scope (by supersession, not mutation)

- **Date:** 2026-07-13
- **Status:** Accepted
- **Deciders:** Jay (product owner; asked to be able to change an existing memory's scope, e.g. personal → work), Claude Code

## Context

Until now the only ways to change the vault were `remember` (append) and
`forget` (tombstone — blank the content, keep the row). There was no way to fix
a memory that landed in the wrong scope: if the concierge or an import filed a
work fact under `personal`, the only recourse was to forget it and re-add it,
which loses provenance and is clumsy. Jay asked for the obvious thing: "a user
should be able to edit memories already added (e.g. change the scope to work)."

The complication is the M0 provenance chain. Each entry's `entry_hash` is a
BLAKE2b hash over its fields **including `scope`** (`computeEntryHash`,
`vault.ts`), and every entry's `prev_hash` links it to the previous entry's
`entry_hash`. So `scope` is not a free-floating column — it is committed into a
tamper-evident append-only ledger. A naïve `UPDATE memories SET scope=…` would
change that entry's hash, which would (a) fail `verifyChain` for that row and
(b) invalidate every subsequent row's `prev_hash` down to the chain head. The
whole point of the chain is to make silent edits detectable; letting the edit
button perform exactly the mutation the chain is designed to catch would gut the
guarantee.

## Decision: edit = supersession (append-only), never in-place mutation

Re-scoping a memory **appends a new entry** carrying the same content in the new
scope, and marks the original as `superseded_by` the new one. Concretely
(`Vault.rescope(idOrPrefix, newScope, allowedScopes?)`):

1. Resolve the live, non-superseded entry by full id or unambiguous prefix
   (same prefix/charset guards as `forget`, plus `superseded_at IS NULL`).
2. Append a new entry: same `content`, `type`, `source`, `source_model`,
   `confidence`, `valid_from`, `metadata`; new `id`, new `created_at`, the new
   `scope`; `prev_hash = chain_head`; a freshly computed `entry_hash`. This
   advances the chain head like any other write.
3. Mark the original: `UPDATE memories SET superseded_at, superseded_by`.
4. Both steps run in a single better-sqlite3 transaction, so a crash can't leave
   two live copies.

This works **because `superseded_at` / `superseded_by` are deliberately excluded
from the hash** (like `forgotten_at`) — they are mutable bookkeeping. Marking a
row superseded therefore does not change its `entry_hash` and does not break the
chain. `verifyChain` stays green (confirmed by test and by a real CLI run).

The schema already reserved `superseded_at` / `superseded_by` for exactly this;
they existed since M0 but nothing wrote them. This ADR is the first writer.

### Why not tail-rehash (keep the same id)?

The alternative — mutate `scope` in place and rehash that entry plus every entry
after it (the mechanism `migrate()` uses for the 0.1→0.2 upgrade) — keeps the
memory's id stable but **rewrites history**. After a tail-rehash you can no
longer distinguish a legitimate scope edit from tampering, because both look
like "hashes changed." For a system whose product promise is a tamper-evident,
user-owned ledger, that is the wrong trade. Supersession records the edit as a
new, honest event and leaves the past immutable. The cost — the memory gets a
new id — is invisible in the GUI (which shows content + scope, not ids) and
stated plainly in the CLI output.

## Visibility rule change

`list()` now excludes superseded entries by default (a new
`superseded_at IS NULL` clause), gated by a new `ListFilter.includeSuperseded`
flag. Without this, a re-scoped memory would appear twice (old scope + new
scope). This is backward-compatible: nothing wrote `superseded_at` before, so no
existing entry is affected. `export()` opts back in (`includeSuperseded: true`)
so the full history — including superseded versions and their forward links —
remains in the canonical export, per Invariant #4. `retrieve()` already filtered
superseded entries; that filter is now redundant but harmless.

## Capability enforcement

`rescope` honors the same scope allowlist as `forget`/`list`, and adds one more
guard: a scoped connection (non-empty `allowedScopes`) **cannot move a memory
into a scope outside its grant** — that would carry the memory past the
allowlist that is supposed to contain it. The source-side clause already
prevents it from touching an entry it can't see. In practice the GUI and CLI run
as the vault owner (no allowlist → unrestricted); the guard matters if a future
scoped MCP surface ever exposes editing.

## Surfaces

- **Core:** `Vault.rescope()` (`packages/core/src/vault.ts`);
  `ListFilter.includeSuperseded` (`types.ts`).
- **CLI:** `northkeep rescope <id> <scope>`.
- **Web API:** `POST /api/memories/rescope` `{ id, scope }` → returns the new
  `publicEntry`. Scope validated against the same charset as add/import.
- **GUI:** a "Move scope" button on each memory card opens an inline picker
  (known scopes + "+ new scope…"), mirroring the add-a-memory scope control.

## Consequences

- Editing scope is now a first-class, provenance-preserving operation.
- A re-scoped memory changes id. Anything that pinned the old id sees it as
  superseded (still present via `includeSuperseded`/export).
- The supersession primitive generalizes: a future "edit content" or
  "adjust confidence" can reuse the same append-new-mark-old mechanism. Only
  scope is exposed for editing today.

## Invariants check

- **#4 (portable, text-canonical export):** upheld — export includes superseded
  entries and their links; nothing is silently dropped.
- **#3 (no hand-rolled crypto):** unchanged — same `computeEntryHash`, no key
  handling touched.
- **#1/#2 (plaintext/ciphertext boundaries), #5 (no telemetry):** untouched.
- Provenance chain integrity: preserved by construction and verified in tests
  (`verifyChain().ok === true` after a rescope, including after reopen).
