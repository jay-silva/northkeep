# ADR 0039 — Projects as vault memories: the project scope convention and MCP project tools.

- **Date:** 2026-08-24
- **Status:** Accepted (M13)
- **Deciders:** Jay (product owner; confirmed the six recommended choices), Claude Code
- **Does not touch:** ADR 0035 (refresh tokens), ADR 0038 (F3 sync replay)

## Context

The product outcome for M13 is: start a project in Claude Desktop, end the
session, open Claude Code or Codex cold, and it picks up the same status, next
actions, and log from the local vault.

NorthKeep already stores memories with a `scope` field that accepts
`project:<name>` (`SPEC/memory-schema.md` §Scopes) and a `working` type. The
missing piece is a convention plus tools so an agent treats one live document
per project as shared state, rather than scattering status across ad-hoc
memories.

This is a convention on existing schema, not a schema change. Vault version
stays 0.3. No new tables. The review gate does not fire (nothing new leaves
the machine, no new decision authority, no untrusted input to a model, no
crypto, no networked dependency), but the ADR is written first so the
convention is pinned before the tools land.

## Decision 1: One live `working` memory per `project:<slug>` scope

A project is a vault memory, not a new object.

- Scope: `project:<slug>` where `slug` matches `[a-z0-9-]{1,40}`. That is a
  subset of the existing MCP `scopeSchema` (`[a-z0-9:_.-]`, max 64), so a
  project scope is a valid scope today.
- Type: `working`. The live document is the live (not superseded, not
  forgotten) `working` entry in that scope.
- If more than one live `working` entry exists in the same project scope, the
  newest wins. Duplicates are an accident, not a merge.
- The document is Markdown with five fixed section headings: **What & Why**,
  **Current Status**, **Next Actions**, **Decisions**, **Log**. Extra headings
  (for example Open Questions) are allowed and are preserved verbatim. They
  are not required.
- There is no stored INDEX memory. `project_list` *is* the index: it returns
  each live `project:*` scope and the first line of that doc's Current Status.

Edits go through the existing supersession primitive (`Vault.editMemory`,
ADR 0015). Updating a project appends a new live entry and keeps the previous
document as superseded history. The provenance chain stays intact.

## Decision 2: MCP surface is `memory_edit` plus three project tools (local only)

Local MCP (`packages/mcp-server`) gains:

- `memory_edit(id, content?, type?)` — correct or update an existing memory
  instead of storing a near-duplicate. Calls `vault.editMemory` with the
  connection's `allowedScopes`. **No `scope` parameter.**
- `project_list()` — live `project:*` scopes the connection can see, each with
  the Current Status first line.
- `project_get(project)` — the live doc. Newest live `working` entry wins.
- `project_update(project, what_why?, status?, next_actions?, log_entry?,
  decision?)` — create if absent (and in-grant), otherwise merge via the core
  project-doc module and supersede. Structured merge: replace Current Status /
  Next Actions / What & Why; append a dated entry to Decisions; prepend a
  dated entry to Log (newest first). Not whole-document replacement.

Tool descriptions carry the contract: read `project_get` at session start when
the user names a project; call `project_update` with status, next actions, and
a log entry when a working session ends. A standing-instruction string in
`project-recipe.ts` says the same thing so it can be stored as a procedural
memory.

The Cloud Connect connector does **not** grow these tools this milestone.
Claude.ai and ChatGPT see a project only if its scope is Shared, through the
generic memory tools. Connector project tools are M14.

## Decision 3: `memory_edit` cannot change scope over MCP

A scope change over MCP could turn private content into shared content (or
the reverse) without the GUI's share-confirmation path. Rescope stays in the
GUI and the CLI (`northkeep rescope`, Memories → Move scope).

`memory_edit` therefore accepts only `id`, `content`, and `type`. The
implementation never passes `scope` into `vault.editMemory`, even if a future
SDK change forwarded extra keys. The connection's `allowedScopes` still apply:
a scoped grant cannot see or edit a memory outside its grant.

## Decision 4: 16 KiB cap, refuse, never silent truncate

`PROJECT_DOC_MAX_CHARS = 16384`. `project_update` refuses a merged document
past that size with a message that tells the caller to prune the Log. The
server must not silently truncate. Every update already stores a full
superseded copy (ADR 0015); the cap keeps a long-running project's doc from
growing without bound. The ~4 MB sync cap still bounds the whole vault.

## What this milestone deliberately does not build

- No Curator (the unnamed AI pass that would organize memories and flag
  contradictions). Recorded as a later feature; not started here.
- No connector project tools (M14).
- No Cursor one-click, no mobile project UI, no billing change, no product
  rename, no new CLI commands, no schema version bump, no new tables.
- `working` memories still do not age out. The type's "ages out" description
  remains aspirational; a stale project sits until the user archives it.

## Adversarial pass: `memory_edit` scope enforcement (light, against the design)

The review gate does not fire, but Decision 3 is the one place a scoped MCP
client could widen what leaves the machine. Findings recorded here before
implementation; the tests in `packages/mcp-server/test/server-tools.test.ts`
pin the ones that are code.

1. **No `scope` argument on the tool.** The Zod input schema omits `scope`.
   Zod's default is strip-unknown, so a client that sends `scope` today has
   that key dropped before the handler runs. Residual: a future SDK or a
   `{ strict: false }` change could start forwarding extra keys. Defense in
   the handler: the patch object is built from `content` and `type` only;
   `scope` is never copied from the request. Exact: the handler does not
   mention `scope`. Residual: a later edit that "just passes the args
   through" would regress this. The unit test calls the tool with a forged
   extra `scope` and checks the memory did not move.

2. **Grant is enforced by the store, not the tool.** `vault.editMemory(id,
   patch, granted)` uses `resolveEditable`, which adds `scope IN (...)`. A
   scoped connection naming an id outside its grant gets "No memory found",
   same as `forget`. Exact for the allowlist. Residual: the error does not
   distinguish "does not exist" from "exists but you cannot see it", which
   is the intended fail-closed reading.

3. **In-grant type change is allowed.** A grant that includes
   `project:foo` can change that doc's type from `working` to `semantic`,
   which makes it disappear from `project_list` / `project_get`. That is
   not a scope escape; it is an in-grant edit. Heuristic honesty: the
   convention is advisory. An agent (or a user in the GUI) can break it.

4. **Content edit is not a rescope.** Replacing a project doc's body with
   content copied from another in-grant memory does not change the scope
   mark, so it does not change what Cloud Connect would push if that scope
   is Shared. The share boundary stays the scope mark (ADR 0038), not the
   words inside.

5. **GUI / CLI rescope is unchanged.** Those paths still call
   `vault.rescope` / `editMemory` with a scope patch, as the owner, with no
   MCP allowlist. Decision 3 is an MCP-surface rule, not a store rule.
   Residual: a future "expose rescope over MCP" proposal has to come back
   to this ADR.

No finding required a design change. The tests cover (1) extra `scope` is
ignored, (2) out-of-grant edit refuses, and the superseded original survives
with the chain intact.

## Consequences

- A project started in one local MCP client is readable by the next, from
  the same vault, without a sidecar file or a stored index.
- Scope changes stay visible and reversible in the GUI/CLI, where share
  confirmation already lives.
- Long-running projects need occasional Log pruning by hand. The tool will
  say so rather than drop history on the floor.
- Two machines editing the same project before sync still lose one side
  (whole-vault last-writer-wins). Same limit as every memory; projects make
  it more visible because they change often. Recorded in KNOWN-LIMITS.
