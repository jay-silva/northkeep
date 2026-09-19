# ADR 0040 - Connector project tools: Cloud can update a shared project.

- **Date:** 2026-08-25
- **Status:** Accepted (M14), KEEP WITH PATCHES
  Decision 5 and Decision 7 amended by ADR 0050 (2026-09-19): a connected app can create a project; the fold marks an empty scope Shared on arrival.
- **Deciders:** Jay (product owner; ordered the adversarial review, then
  implementation of the patched design), adversarial reviewer, Cursor
- **Does not touch:** ADR 0039 (local project tools and `memory_edit`),
  ADR 0020 (row envelope and DEK custody), vault schema 0.3, the ordinary
  `memory_remember` cap, Cursor Connect, the contract installer, the curator

## Context

ADR 0039 made a project a vault memory: one live `working` document in a
`project:<slug>` scope, with local MCP tools `project_list`, `project_get`,
and `project_update`. It left connector project tools for M14.

The product outcome for M14 is: Cloud Claude.ai can `project_update` a
shared project; after `northkeep share sync` the handoff is one live
working document in the vault that local agents `project_get`.

Cloud still cannot create a project. Sharing a project scope from
NorthKeep is what makes a live working document visible to the connector.
`project_update` merges into that document. The desktop fold supersedes
the local live document so the vault keeps exactly one live working row.

Two load-bearing patches from the adversarial review are pinned here:

1. No encrypted-envelope rider. The pending row holds the full merged
   markdown document. `RowPlain` stays `{type, content}`. `/client/pending`
   stays `{server_id, scope, type, content}`.
2. Project identity is `parseProjectSlug` / `PROJECT_SLUG_PATTERN` on every
   connector project tool and on the new fold path. A scope that merely
   starts with `project:` is not a project.

## Decision 1: Three tools, no `memory_edit` on the connector

The hosted connector gains the same three project tools the local MCP
already has:

- `project_list()`: decrypt visible shared entries, group scopes where
  `parseProjectSlug(scope) !== null`, return each slug plus the first
  line of Current Status. Audit records ids only.
- `project_get({project})`: validate the slug with
  `PROJECT_SLUG_PATTERN` before any storage read; return the full
  markdown of the selected working document.
- `project_update({project, what_why?, status?, next_actions?,
  log_entry?, decision?})`: same Zod length caps as local; require at
  least one field; require a decryptable working base document; merge
  with the same `@northkeep/core/project-doc` functions the desktop uses.

`memory_edit` is not added on the connector. Ordinary memories still go
through `memory_remember` / `memory_forget`. The 8 KiB
`memory_remember` cap is unchanged.

## Decision 2: Pending-remember reuse, one pending row overwritten in place

A cloud update is a connector-born pending row, the same write path
`memory_remember` already uses: `origin='connector'`, `pending=true`,
encrypted `{type, content}` envelope, stored `type` column `''`.

There is one pending row per project scope. A later `project_update`
overwrites that row in place under the same entry id, using the existing
`(account, entry id)` upsert. No schema change. No new storage methods.

If the selected base is a vault-pushed working row (not pending), the
first update creates a new `conn_` id. Subsequent updates reuse it.

`MAX_SHARED_ENTRIES` is checked only when creating a new pending row.

## Decision 3: No rider, same envelope, same custody

The pending row holds the full merged markdown. There is no
encrypted-envelope rider, no envelope format change, and no change to
`/client/pending`. Every stored update is ciphertext under the
per-account DEK, same envelope, same custody chain as every other row.

The at-rest claim is unchanged: encrypted at rest, we store no key. The
database alone yields no key and no plaintext.

## Decision 4: Slug-exact validation

A project is only a scope of the form `project:` plus a slug matching
`^[a-z0-9-]{1,40}$`. Every connector project tool validates that before
any read. The push-path 64 KiB cap and the desktop fold use
`parseProjectSlug`, never a `project:` prefix check.

`@northkeep/core` is a connector runtime dependency so the serverless
bundle can import `@northkeep/core/project-doc` (a pure submodule: no
sqlite, no sodium). The connector does not import `@northkeep/core` at
the package root and does not fork `project-doc`.

## Decision 5: Fail-closed; Cloud cannot create a project

`project_update` requires a decryptable working base document: the
scope's pending project row, or a stored row whose encrypted envelope
carries type `working`. A scope with no working document, an unshared
scope, and a never-shared scope all refuse the write with nothing
stored.

Doc selection (one shared function): prefer a pending working-type row;
else decrypted working rows, highest `createdAt`, then highest
`entryId`. If none: "no live project document".

The merged document is capped at 16384 characters by the same pure merge
function the desktop uses. An over-cap merge is refused verbatim, never
truncated.

## Decision 6: 64 KiB cap only for working-type rows in valid project scopes

`PUT /client/entries` keeps the ordinary 8192-byte per-entry cap and the
4 MB per-push total. The per-entry cap of 65536 bytes applies only when
`parseProjectSlug(scope) !== null` and `type === 'working'`. The 413
error text names both caps. `memory_remember` stays at 8 KiB.

## Decision 7: Desktop fold supersedes; old-client residual

`downSyncConnector` treats a pending entry where
`parseProjectSlug(scope) !== null` and `type === 'working'` as a project
update: identical-content dedupe first; else if a newest live working
row exists in that scope, `vault.editMemory` and ack with the
superseding id; else `vault.remember`. All other entries are unchanged.

A client that predates M14 folds a project update as a new working
memory instead of a supersession. Newest-wins then shows the folded
document; the prior document remains live and recoverable. Nothing is
deleted.

## What this milestone deliberately does not build

- No `memory_edit` on the connector.
- No ordinary-memory cap raise.
- No rider / no envelope change / no `/client/pending` shape change.
- No schema bump, no new storage methods, no migration.
- No Cursor Connect, no contract installer, no curator.
- No prefix-only project checks in the connector or the new fold path.

The connector does not import `@northkeep/core` at runtime. Vercel's Node
preset loads the compiled function as CommonJS; a workspace ESM subpath
(`@northkeep/core/project-doc`) is left as a live `import` and crashes
with `Cannot use import statement outside a module`. The pure
`project-doc.ts` module is therefore compiled as a local file under
`apps/connector-server/src/`, identical to `packages/core/src/project-doc.ts`.
A test requires the two files to be byte-identical so the copy cannot
drift. Vercel must not run connector `tsc`: the Node preset then loads
the ESM emit as CommonJS and 500s (`Cannot use import statement outside
a module`). `vercel.json` `buildCommand` is `true` so Vercel compiles
`src/index.ts` itself.

### Adversarial review: what was inspected, what is enforced

**Inspected:** `apps/connector-server/src/mcp.ts` (tool surface, remember fail-closed, caps), `create-server.ts` (push caps, `/client/pending`, `/client/ack`), `crypto.ts` (row envelope, DEK custody), `storage.ts` and `neon-storage.ts` (`putEntry` upsert semantics, `replaceScopes` pending shield, `deleteScope`), `packages/sync/src/connector-client.ts` (`downSyncConnector` fold), `packages/core/src/project-doc.ts` (parse, merge, 16384-char cap, slug regex), `packages/core/src/vault.ts` (`editMemory` supersession, `setScopeShared`), `packages/mcp-server/src/server.ts` (local newest-wins and slug validation), and the c2/c3/c4/encryption test suites.

**Enforced exactly:**
- A project is only a scope of the form `project:` plus a slug matching `^[a-z0-9-]{1,40}$`, validated on every connector project tool before any read. A scope that merely starts with `project:` is not a project.
- Cloud cannot create a project. `project_update` requires a decryptable base document: the scope's pending project row, or a stored row whose encrypted envelope carries type `working`. A scope with no working document, an unshared scope, and a never-shared scope all refuse the write with nothing stored.
- The merged document is capped at 16384 characters by the same pure merge function the desktop uses; an over-cap merge is refused verbatim, never truncated.
- One pending row per project scope: updates overwrite in place under the same entry id, using the existing (account, entry id) upsert. No schema change.
- Every stored update is ciphertext under the per-account DEK, same envelope, same custody chain as every other row. The row envelope format did not change.
- Unshare deletes the scope's rows including a not-yet-delivered project update; the revoke wins.
- The per-entry push cap of 65536 bytes applies only to working-type rows in valid project scopes; the ordinary 8192-byte cap and the 4 MB per-push total are unchanged, as is the `memory_remember` cap.

**Heuristic:**
- If a project scope abnormally holds more than one live working row (or more than one pending row after a concurrent-update race), the base document is chosen deterministically (pending first, then newest created, then highest entry id). Local supersession normally guarantees exactly one, so this fires only in an already-degenerate scope and never loses data: unchosen rows remain stored.

**Residual (documented, accepted):**
- A client that predates M14 folds a project update as a new working memory instead of a supersession. The connector's merged document then shadows the prior local document under newest-wins; the prior document remains live in the vault and is recoverable. Nothing is deleted.
- Tool handlers are check-then-write without a cross-request transaction, so an update racing an unshare within one request window can land a pending row after the scope delete. This window is identical to the pre-existing `memory_remember` race and is bounded by one request.
- Project documents in a shared scope are served in full by `memory_retrieve`, `memory_list`, and ChatGPT's `search`/`fetch`, like every other shared memory. This is the consented sharing contract, not a leak; no filter is applied.
- The server, while answering a request, briefly holds the decrypted document, exactly as it already does for every shared memory. The at-rest claim is unchanged: the database alone yields no key and no plaintext.
- Vercel Node serverless loads the function as CommonJS. A workspace ESM subpath is left as a live `import` and 500s. The connector therefore compiles a byte-identical copy of `project-doc.ts` as a local file so it bundles with the rest of `src/`.

## Consequences

- A shared project updated in Claude.ai is one live vault document after
  `northkeep share sync`, readable by local agents via `project_get`.
- Unshare remains the revoke: the pending update is deleted with the
  scope.
- Long-running projects still need occasional Log pruning. The 16384
  character merge cap refuses rather than truncates.
- An un-upgraded desktop keeps both documents until the user upgrades
  and a later sync supersedes.
