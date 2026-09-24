# ADR 0060: Pre-release privacy fixes for 0.22.0 (D2, D3, D4, D6, D7, D8)

- **Date:** 2026-09-24
- **Status:** Proposed. **Not reviewed.** This is a design only; nothing
  here is implemented. It changes what leaves the machine (D2, D4),
  puts third-party text in front of the model (D3), changes a trust
  level (D6) and publishes claims, so the CLAUDE.md review gate
  requires an adversarial review against code before any
  implementation starts. The review history section at the end is
  empty on purpose.
- **Deciders:** Jay (product owner), Claude Code
- **Jay's decisions already taken (2026-09-24):** D2 "Redact it"; D7
  "Log before writing". The remaining open choices are listed under
  "Decisions for Jay" near the end.
- **Source:** the defect table in
  `Reviews/release-0.22.0/doc-vs-code.md` (rows D2, D3, D4, D6, D7,
  D8), re-verified against branch `fix022/privacy` (HEAD `6d67dd2`).
  Two citations in that table are wrong and are corrected here: the
  review adapter is `packages/converse/src/reviewApi.ts` (not
  `apps/web/src/reviewApi.ts`), and the agent loop is
  `packages/converse/src/task.ts` (not `src/tools/task.ts`).
- **Amends:** ADR 0043 P3 and P8 (D2), ADR 0033 Decision 3 (D6), ADR
  0052's call-log rule (D7).
- **Does not touch:** crypto or key handling, the vault schema, sync,
  the connector store, the hosted connector's tools, export or the
  mirror, the set of Tier-1 kinds, the ADR 0029 screens. No new
  dependency.

## Context

Six defects from the release doc-versus-code pass sit on privacy or
trust boundaries. Each is described here from the code as it stands.

**D2. The cloud memory review sends memory text with no redaction.**
The web route `startReviewApiRun` (apps/web/src/api.ts:2138) builds a
generator with `createReviewApiGenerator` (api.ts:2186) and hands it to
`runReviewPass` (api.ts:2188). `runReviewPass` formats each pack as
`id / scope / type / created_at / content` blocks
(packages/librarian/src/review.ts:75-84) and calls `generateJson`
(review.ts:250), which calls `provider.chat` with that prompt verbatim
(packages/converse/src/reviewApi.ts:77). No redaction step exists
anywhere on the path. Invariant 1(a) says plaintext goes to the chosen
provider only "after the active redaction tier has run", and ADR 0043
P8 was written as "Full content of the included entries leaves."
Jay decided: redact it.

**D3. A failed MCP tool call's error text reaches the model unfenced.**
Successful tool output is wrapped with `wrapUntrusted` (task.ts:960-966).
Failures are not: `resultContent` is the bare `truncateChars(toolOut.content)`
(task.ts:967). Three paths put third-party text into that bare content:
the MCP client's `isError` branch puts the server's text into `detail`
(packages/converse/src/tools/mcp/client.ts:396-397); a tool that throws
(including the MCP SDK throwing an `McpError` built from the server's
reply) lands in the catch at task.ts:936-947, which copies
`err.message` into `detail`; and any tool whose `meta.ok` is false
passes its content through unchanged. The start-up sanitizer
(`sanitizeServerText`, identity.ts:227) runs on descriptions only.

**D4. `NORTHKEEP_REDACT_TIER=2` or `3` over MCP silently means no
masking.** `returnRedactionTier` returns 1 only for the exact string
`'1'` and 0 for everything else (packages/mcp-server/src/server.ts:73-75).
The CLI duplicates the same check (packages/cli/src/projectsCmd.ts:655).
A user who asks for more masking gets none, and nothing says so. That is
invariant 6 ("never silently drop a privacy tier"). Two related gaps:
`refuseProjectWriteUnderTier1` tests `=== 1` (server.ts:330-336), and
`memory_edit` with `content` is allowed under Tier 1 even though the
model only saw masked text.

**D6. The vault's own server is added as `strict`.** The catalog entry
`vault` (packages/converse/src/tools/mcp/catalog.ts:62-75) carries no
trust level, the GUI add route calls `addServer` without one
(apps/web/src/api.ts:1078-1091), and `addServer` defaults to `strict`
(packages/converse/src/tools/mcp/config.ts:326). A `strict` server's
arguments get the Tier-1 floor (task.ts:909-924), so
`memory_remember("my email is bob@example.com")` stores
`my email is [EMAIL_1]`. The code comment at task.ts:912-914 already
says this corrupts saves. `trusted` is reachable only by hand-editing
`mcp.json`. The config comment (config.ts:36-47) and ADR 0033 Decision 3
say "local or ours does not earn it".

**D7. A write can land with no log row.** `run()` executes the tool
body inside `withVault`, and only afterwards calls `appendCallLog`
(server.ts:268-277). If the append throws (a directory at the log
path, a full disk, a permission change) the write is already saved,
the catch appends again (server.ts:285-292), that throws too, and the
client receives an error for a write that succeeded. A client that
retries writes twice. ADR 0052 said the log is written before the tool
runs. Jay decided: log before writing.

**D8. Stale model-facing text.** The local `project_update` description
says documents over 16384 characters are refused and to prune the Log
(server.ts:768-770). Since ADR 0045 the host rolls the oldest Log
entries into archive memories (`rollProjectLog`,
packages/core/src/project-doc.ts:241; called from
project-handoff.ts:193), so the instruction is wrong and makes agents
delete their own history. The `mergeProjectDoc` docstring
(project-doc.ts:161-165) still says it throws on oversize; the inline
note at project-doc.ts:193-195 says the opposite and is correct.

Two facts found while designing, confirmed by a probe under a temporary
`NORTHKEEP_HOME` (nothing written):

1. Tier-1 numbering restarts on every `applyTier1` call
   (packages/redact/src/tier1.ts:309-314): `bob@example.com` in one call
   and `carol@example.com` in the next are both `[EMAIL_1]`.
2. Date placeholders are not numbered: `03/15/1948` and `04/02/1948` both
   become `[DATE-1948]` (dates.ts:125-128), and at Tier 3 a formatted
   pack's `created_at: 2026-09-24T12:00:00.000Z` line becomes
   `created_at: [DATE-2026]`. Entry ids and the `===BEGIN MEMORY DATA===`
   marker survived Tiers 1 and 3 in the probe.

Both facts shape D2: a placeholder in a model reply cannot always be
turned back into one original by string replacement.

## Decision 1 (D2): the cloud review redacts at the active tier

### 1.1 What is redacted, and where

Only the `content` of each memory goes through the redaction pipeline.
The frame around it (instructions, ids, markers) is ours and is not
redacted, so ids can never be masked into `dead_id` drops.

Metadata sent with each memory, per tier:

| field | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| `id` | sent | sent | sent |
| `type` | sent | sent | sent |
| `scope` (collection name) | sent as written | sent as written | sent as written |
| `created_at` | sent | sent | **year only** (`2026`) |
| `content` | Tier 1 | Tier 2 | Tier 3 |

Plain language: Tier 3 promises "all dates to year", so the one date we
add ourselves follows the same rule. Collection names are labels the
user typed; they are not run through name detection, and the consent
panel says so (1.5). `created_at` is NorthKeep's recording time, not
user content, which is why Tiers 1 and 2 send it unchanged.

### 1.2 The seam, and why the guarantee sits at the send

`@northkeep/redact` imports `@northkeep/librarian`
(packages/redact/src/index.ts:1), so `runReviewPass` cannot call
`redact()` without a dependency cycle. The seam:

- `createReviewApiGenerator` (converse, which already depends on redact:
  task.ts imports `applyTier1`) stops accepting a prompt string. It
  exposes two methods and nothing else:
  - `prepare(packs: MemoryEntry[][], tier)`: redacts every pack (1.3)
    and returns opaque handles plus the run's placeholder mapping and
    the tier actually applied.
  - `send(handle, opts)`: builds the prompt **itself**, from the
    redacted content held behind the handle, using the prompt formatter
    exported by librarian (`formatReviewPrompt`, today's
    `reviewPrompt`, review.ts:82-84) plus the placeholder sentence
    below, then calls `provider.chat`.
  A handle is checked at runtime, not only by type: `send` accepts only
  objects present in a module-private `WeakSet` that `prepare` filled.
  TypeScript brands vanish at runtime, so the WeakSet is the guarantee.
  No method on the adapter takes free text, so no later caller can reach
  `provider.chat` with unredacted memory text through it.
- `runReviewPass`'s second parameter becomes a union:
  `Pick<OllamaClient, 'generateJson'>` (the local path, unchanged) or
  `ReviewOutbound` (`{ prepare, send }` as above). With a
  `ReviewOutbound`, `runReviewPass` calls `prepare` once with **every**
  pack before the first `send`, never formats a prompt string itself,
  and validates each reply through the restoration rules in 1.4. With an
  Ollama client (the local path, `northkeep review`, and the web local
  route at api.ts:2090) the prompt is byte-for-byte what it is today.
- Placeholder restoration and quote matching live in librarian as pure
  functions over a plain mapping (`Array<{placeholder, originals[], kind}>`),
  so librarian still does not import redact.

The web route is the only caller that passes `outbound`; it must pass
it, because the adapter type no longer offers a free-text send.

### 1.3 One numbering across the whole run

Redaction gains an optional shared state,
`RedactOptions.session?: RedactionSession`, holding the Tier-1
`seen` map and per-kind counters, alongside the existing shared
`pseudonyms` map. `redactReviewPacks` creates one session per run and
redacts each memory's content separately with it. Properties (tested):

- the same original gets the same placeholder everywhere in the run;
- two different originals of a numbered kind (`[EMAIL_n]`, `[PHONE_n]`,
  `Person-n`, ...) never share a placeholder within the run;
- without `session`, `redact()` output is unchanged for every existing
  caller (chat, CLI `redact`, mobile).

`[DATE-YYYY]` and `[DATE]` stay un-numbered (changing them would change
chat and published placeholder shapes). The restoration rules below
handle the resulting ambiguity.

### 1.4 Validating and restoring what the model returns

The model now sees placeholders, so its quotes contain placeholders, and
ADR 0043 P4 ("the quote must be a verbatim substring of that entry's
stored content") cannot be checked with `entry.content.includes(quote)`
(reviewSchema.ts:99). Everything below runs locally; no original is ever
sent anywhere.

**Restore on parsed values, never on the raw reply.** The reply is
parsed first (`parseReviewResponse`), and restoration is applied to the
parsed string leaves. Substituting into raw JSON would break the parse
for an original containing `"` or `\`.

**Quotes (P4, P5).** For a quote cited against entry E:

1. Split the quote into literal runs and placeholder occurrences, where a
   placeholder is any placeholder string in this run's mapping (longest
   first).
2. Build a matcher: each literal run matches itself exactly; each
   placeholder matches any one of its originals in this run, or the
   placeholder text itself (a memory can literally contain `Person-1`).
   Name kinds (person, org, location) match case-insensitively, because
   replayed pseudonyms carry the lowercased map key as their original
   (redact/src/index.ts:163); every other kind matches exactly.
3. The quote is valid only if the matcher finds a span in E's **stored**
   content. The quote kept in the report is that stored span, copied
   from the vault, never the model's text.
4. No match is a `fabricated_quote` drop, as today.

P4 therefore still means "verbatim in the vault": the kept quote is a
substring of stored content by construction.

**`proposed_content` (the only field that becomes a vault write).**
Every placeholder in it is restored locally, **including Tier-1
secrets**. This differs on purpose from chat, where `restore()` keeps
Tier-1 one-way (index.ts:169-184): in chat the restored text is shown
back to the model's side of the conversation; here it becomes the
user's own memory, the original never left the machine, and writing
`[EMAIL_1]` into the vault would corrupt the memory the user is trying
to fix. Rules:

- a placeholder with exactly one original in this run is replaced by
  it; for a name kind, the surface form is taken from the target entry's
  stored content (first case-insensitive match), else from any cited
  entry, else the proposal is dropped;
- a placeholder with two or more originals (typically `[DATE-1948]`) is
  **ambiguous**: the proposal is dropped with reason
  `ambiguous_placeholder`;
- any token that has a NorthKeep placeholder shape but is not in the
  run's mapping, and does not occur literally in a cited entry's stored
  content, drops the proposal with reason `unmapped_placeholder`.

**`explanation` and `question` (display only, never applied).**
Unambiguous placeholders are restored; ambiguous or unmapped ones are
left visible as placeholders. Nothing is dropped for these fields.

**Prompt amendment (ADR 0043 P3).** The pinned prompt used on the API
path gains one sentence: "Some values are replaced by placeholders such
as [EMAIL_1] or Person-2. Copy placeholders exactly as written; do not
guess what they hide." The local path's prompt is unchanged.

### 1.5 Tier selection and the consent panel

- Preflight and run both take `tier: 1 | 2 | 3` (Off is not offered:
  every review endpoint is `bounded`, and bounded endpoints get Tier 1
  minimum, turn.ts:316). A missing or invalid tier is a 400; there is no
  server-side default.
- The panel's tier selector defaults to the current value of the chat
  tier selector (`convTierSel`, index.html:647), mapped Off to 1. That is
  "the same tier selection chat uses".
- The tier is added to the `operationFingerprint` input at preflight
  (api.ts:2029) and run (api.ts:2163), so the tier the user consented to
  is the tier that runs.
- The panel (index.html:3417-3451) adds, in plain words: "Before sending,
  NorthKeep masks what it can find in each memory at Tier N: <one line
  describing that tier>. Collection names, memory types and ids are sent
  as written. At Tier 3 the recording date is reduced to the year."
  It also replaces "This run will send N memories" with "This run will
  send N memories, masked at Tier N". The Send button reads
  "Mask and send N memories to <host>".

### 1.6 Degraded tiers (invariant 6)

All packs are redacted before the first send (1.2), so a failure is
known while nothing has left.

- **Tier 2 with the name model unavailable:** the run refuses before
  sending anything. Job status `failed`, message modelled on chat's
  (turn.ts:399-420): "Name masking needs the local model and it is not
  running. Nothing was sent. Start the local model, or choose Tier 1 or
  Tier 3." Audit row written with `ok: false`, `error: tier2-unavailable`.
- **Tier 3 with the name model unavailable:** the run proceeds (Tier 3's
  guarantee is its deterministic layers, as in chat, turn.ts:399-422),
  and the progress line, the saved report and the audit row all say
  "Tier 3, deterministic only (name model offline)".
- Practical note: a cloud review already needs local Ollama, because
  with no embedder `runReviewPass` makes zero model calls
  (review.ts:191-198). So "Tier 2 degraded" in practice means
  `nomic-embed-text` is present and `llama3.2:3b` is not.

### 1.7 The audit row, written before the send

The cloud review writes no call-log row today. It gains one, under the
same "log before acting" rule as Decision 5: a `pending` row is appended
after redaction and before the first `send`; if it cannot be appended,
the run refuses and nothing is sent. The completion row follows.
Fields (content-free, existing field names where they exist):
`tool: "review_api"`, `endpoint_host`, `model`, `privacy: "bounded"`,
`redaction_tier` (the tier actually applied), `redaction_degraded`
(new, boolean), `result_count` (memories sent), `result_ids` (ids
sent), `disclosed_scopes`, `ok`, `error`. The saved report's `sent_to`
gains `tier` and `degraded`.

### 1.8 Local review unchanged

`northkeep review` and the GUI's local run pass no `outbound`, send
nothing off the machine, and keep today's prompt and validation.

## Decision 2 (D4): any MCP return tier of 1 or more masks at least Tier 1

- One parser, `parseReturnRedactionTier(env)`, shared by the MCP server
  and the CLI (replacing server.ts:73-75 and projectsCmd.ts:655):
  unset or `0` means 0; `1`, `2`, `3` mean that tier; **any other value
  is refused** (see "Decisions for Jay", item 2, for the proposed
  behaviour).
- **The CLI read path** (projectsCmd.ts:637-660, which "masks under
  NORTHKEEP_REDACT_TIER=1 the way the MCP tool does") follows the same
  rules: at 2 or 3 it masks through the same shared function the server
  uses, a degraded Tier 2 exits non-zero with the same sentence and
  prints no content, a degraded Tier 3 prints the note on stderr, and
  an invalid value exits non-zero naming the value. The CLI never
  silently reads 2 or 3 as 0.
- **Tier 1:** unchanged (Tier-1 masking of returned content and project
  payloads).
- **Tiers 2 and 3:** returned memory content and project payload fields
  (the same fields `maskProjectFields` masks today, project-mask.ts:21)
  go through `redact()` at that tier. Pseudonyms are consistent for the
  life of the server process: one `PseudonymMap` held in RAM, never
  written to disk, never logged.
- **Order.** The slow NER pass runs after the vault is closed, on the
  payload `fn` returned, never inside `withVault`. ADR 0044 already
  learned that holding the vault lock across a loopback model call
  stalls every other tool (see the comment at server.ts:393-395).
- **Degraded Tier 2** (name model unavailable): the call returns an error
  and no content: "NORTHKEEP_REDACT_TIER=2 needs the local name model,
  which is not running. Nothing was returned." A refused call is the
  loudest signal an MCP host shows. Log row `ok: false`,
  `error: tier2-unavailable`.
- **Degraded Tier 3:** content is returned with the deterministic layers
  applied, the payload carries `redaction_note: "Tier 3 ran without the
  name model; names outside the built-in lists may be unmasked."`, one
  stderr line is written per process, and the log row carries
  `redaction_degraded: true`. Honest limit: whether the user sees the
  note depends on the host app showing tool output.
- **Writes under any tier of 1 or more:** project writes are refused
  (`refuseProjectWriteUnderTier1` becomes `refuseProjectWriteUnderMasking`,
  testing `>= 1`). `memory_edit` with `content` is refused under any
  tier of 1 or more; a type-only edit is allowed. Reason: the model only
  saw masked text, so replacement content it writes can silently
  overwrite the real value with a placeholder. (Jay decides, item 1.)
- **Log rows** record the tier actually applied (2 degraded to 1 never
  happens here: it refuses; 3 degraded stays 3 with the flag), not the
  env string.

## Decision 3 (D3): error text is fenced and sanitized like results

At the single join point in task.ts (where `resultContent` is set,
task.ts:960-967), for **every** tool, not only MCP:

- A failed result is split into our part and theirs. "Ours" is a closed
  set, checked, not assumed: an `error` value is ours only if it is one
  of the error codes NorthKeep's tools and loop define (the web tools'
  `GUIDANCE` keys, the loop's own codes such as `tool_failed`,
  `budget_exceeded`, `tool_definitions_changed`), and a `guidance` value
  is ours only if it is one of the fixed strings those tables and the
  loop define. Checked in code: both web tools build `error` from a code
  constant and `guidance` from their `GUIDANCE` table or a fixed
  fallback (webFetch.ts:43-47, webSearch.ts:154-158); their `detail`
  can carry third-party text (`err.message` at webSearch.ts:259). Our
  part stays bare JSON, re-serialized by us (`JSON.stringify` of the
  two fields only). Everything else is theirs: `detail`, any `error` or
  `guidance` value outside the closed set, and any failed content that
  is not our structured error JSON.
- Their part is sanitized by Unicode category, not by lists: every code
  point in `\p{Cc}` (C0 and C1 controls, newline included), `\p{Cf}`
  (zero-width, bidi marks, BOM), `\p{Co}`, `\p{Cs}`, and `\p{Zl}`/`\p{Zp}`
  is replaced by a space; the result is capped at 2000 characters. This
  closes the gap that `sanitizeServerText` misses zero-width characters
  and BOM while `wrapUntrusted`'s list misses C0/C1.
- The sanitized text is then wrapped with `wrapUntrusted` (per-task
  nonce, fence-lookalike defang), source label `<tool name> (error)`.
- `resultContent` becomes our bare JSON, a newline, then the fence. The
  MCP client (client.ts:396-397) and the catch (task.ts:936-947) keep
  producing `detail`; they no longer decide fencing.
- The `errorLine` shown to the user (task.ts:970-980) is built only from
  `error` and `guidance` values inside the closed set; a value outside it
  is replaced by `tool_failed`. Never `detail`.

## Decision 4 (D6): the catalog's vault server is `trusted`

- `McpCatalogEntry` gains `trust: McpTrust`. The `vault` entry declares
  `trusted`. The GUI catalog add route passes `entry.trust` to
  `addServer`. A custom add by path still defaults to `strict`; trust is
  never inferred on load and never inferred from a matching command.
  The CLI has no catalog add (no use of `getMcpCatalogEntry` or
  `listMcpCatalog` in packages/cli/src), so `northkeep mcp add` keeps its
  current `strict`-only behaviour.
- Why this is safe, stated as conditions the reviewer can check:
  1. The destination of the arguments is the vault on this machine. The
     server is our own `packages/mcp-server/dist/index.js`, launched with
     the running Node (catalog.ts:47-58), and the launch fingerprint pin
     (ADR 0033 Decision 1) refuses a swapped program under the same id.
  2. It sends arguments nowhere by itself. Its only model client is
     Ollama, and `ollamaUrl()` refuses any non-loopback host with no
     override (packages/librarian/src/ollama.ts:20-29).
  3. What leaves after a write leaves on paths that already have their
     own rules, exactly as for a GUI write: the standalone server's
     auto-sync (mcp-server/src/auto-sync.ts, ADR 0044) pushes the
     encrypted vault (invariant 2); whether it also pushes Shared-scope
     content to the connector was not confirmed while writing this ADR
     (a grep of packages/sync/src/auto.ts found no connector push), and
     the reviewer must check it. If it does, that push is invariant
     1(b), which the user opted into per scope.
  4. The arguments are the user's own conversation, going into the
     user's own vault. The Tier-1 floor on `strict` servers exists
     because a local program may forward what it receives (invariant 1,
     last paragraph); conditions 1 to 3 show this one does not.
- What does not change: the ADR 0029 screens still run on the
  arguments, so an SSN, card number, IBAN or API key in a
  `memory_remember` call is still hard-denied (residual R4).
  `memory_remember` and `memory_forget` stay consequential and ask every
  time.
- ADR 0033 Decision 3 and the comment at config.ts:36-47 are amended:
  "local or ours" alone still does not earn `trusted`; the catalog's
  vault entry earns it because conditions 1 to 4 hold for that program.
- Existing installs keep `strict` until the user acts (Jay decides the
  upgrade path, item 3).

## Decision 5 (D7): log before acting

### 5.1 The row pair

`run()` becomes:

1. Mint `call_id` (random UUID). Append a **pending** row:
   today's `base` fields plus `phase: "pending"`, `call_id`, `ok: false`,
   `error: "pending"`. If this append throws, the tool body does **not**
   run; the client gets "NorthKeep could not write its call log, so
   nothing was done." No vault is opened.
2. Run the tool body.
3. Append the **completion** row: today's row shape plus
   `phase: "done"` and the same `call_id`. Its `ts` stays the call's
   start time, as today (`base.ts` is set before `withVault`,
   server.ts:260), so the open-session derivation, which sorts by `ts`
   (open-sessions.ts:115-117), sees exactly the ordering it sees now. A
   new `completed_at` field carries the end time.
4. `run()` does not guess which tools write. Each registration passes
   `kind: 'read' | 'write'` explicitly (write: `memory_remember`,
   `memory_edit`, `memory_forget`, `project_create`, `project_update`,
   `project_checkpoint`, `project_wrap`; everything else read).
5. If the completion append fails:
   - after a **write** that saved: return success, but only a minimal
     acknowledgement with no content: `{ saved: true, id or revision,
     log_warning: "The change was saved, but its log entry could not be
     completed." }`. Returning an error is the retry bug D7 is about;
     returning the full document (project writes return it today) would
     be a disclosure with no ledger row, which the read rule forbids.
   - after a **read**: withhold the payload and return an error. The
     disclosure ledger (which ids went out) lives in the completion row,
     so a read whose ledger cannot be written discloses nothing.
   - after a failed tool body: return the tool's error as today.
   (Jay decides, item 5.)

The catch path's append is wrapped too; an append failure there no
longer replaces the tool's own error message.

### 5.2 Why `ok: false` on the pending row

Every derivation that exists today, in this build and in older ones,
counts only `ok === true` rows as reads or writes
(open-sessions.ts:89-92). A pending row with `ok: false` is therefore
ignored by all of them, which is the safe direction: it can never open a
session or close one, in any version. New readers use `phase`.

### 5.3 Readers

- **Open sessions:** pending rows are ignored (as above). A crash
  between a landed project write and its completion row leaves that
  session looking open. Closing that gap: a tracked session is also
  closed when the project's revision history names that session as the
  writer (ADR 0052 provenance, `session_id`, project-handoff.ts:165-175)
  on a revision recorded at or after its last read. This uses data the
  vault already has; nothing new is stored.
- **`northkeep log`, the GUI activity list (api.ts:706), audit JSON and
  CSV:** a pending row with a matching completion row is folded into the
  completion row. A pending row with no completion is shown as
  "outcome unknown (interrupted)", never as success and never hidden.
  CSV appends two columns at the end, `phase` and `call_id`
  (audit.ts:28 says columns are appended, never inserted).
- **Mixed rows:** chat and task rows written by `runTurn`/`runTask`
  share the file and carry no `phase`. A row with no `phase` is read
  exactly as today.
- **Older builds after a downgrade** show each pending row as an extra
  failed call with error `pending`. Cosmetic only; no derivation changes.

### 5.4 Scope

This applies to every tool registered through `run()` in the local MCP
server, reads included. It does not change chat or task audit rows
(they already write after the provider call, and are not write paths
into the vault through MCP), or the hosted connector.

## Decision 6 (D8): tool description and docstring

Local `project_update` description, replacing server.ts:765-770
(adapted from the hosted wording, apps/connector-server/src/mcp.ts:787-795):

> Create or update a project document. Call this when a working session
> ends, with the new Current Status, Next Actions, and a log entry
> describing what was done. Optional What & Why replacement and a dated
> decision. Updates merge into the existing sections; they do not
> replace the whole document. The live document keeps only its newest
> Log entries; older ones roll into an archive memory in the project
> scope (the result's archive_summary counts them), so a log entry is
> never refused for size. Only a document whose hand-written sections
> alone exceed 16384 characters is refused. NorthKeep never truncates.

`mergeProjectDoc` docstring (project-doc.ts:161-165): drop "Throws if the
serialized result exceeds PROJECT_DOC_MAX_CHARS" and say that size is
enforced by the caller through `rollProjectLog` and
`assertProjectDocSize` (ADR 0045), matching project-doc.ts:193-195.

## Claims this ADR publishes, and the test that enforces each

Every test that opens a vault or writes the log sets `NORTHKEEP_HOME` to
a temp directory. No test calls a real provider; providers are local
stubs injected into the generator. Test paths follow the repo layout
(`<package>/test/*.test.ts`). The last column says whether the test
**fails on old code** (`fix022/privacy` at `6d67dd2`), which is the
proof the defect was real, or is a **guard** that passes on old code
and exists to stop a later regression. A guard is not evidence of a fix.

| # | claim | test (planned file) | old code |
|---|---|---|---|
| C1 | A cloud review sends no seeded Tier-1 value; at Tier 3 no seeded full date, no dictionary name, and `created_at` as year only | `apps/web/test/review-api-redact.test.ts`: stub provider records wire text; corpus seeded into memories; assert no original and no full `created_at` appears | fails: wire text is the raw prompt |
| C2 | The API adapter has no free-text send | `packages/converse/test/reviewApi.test.ts`: `send` rejects a hand-built object and a string; only a `prepare` handle passes | fails: `generateJson(prompt)` accepts any string |
| C3 | Placeholder numbering is consistent across a run | `packages/redact/test/session.test.ts`: two different emails in two calls sharing a session get `[EMAIL_1]`, `[EMAIL_2]`; the same email twice gets one placeholder | fails: numbering restarts per call |
| C3g | Without a session, `redact()` output is unchanged | same file, against today's corpus outputs | guard |
| C4 | A quote containing placeholders validates against stored text, and the report keeps the stored span | `packages/librarian/test/review-restore.test.ts`, including a `[DATE-1948]` quote over an entry with two 1948 dates and a lowercased pseudonym original | fails: `includes()` rejects any placeholder |
| C5 | `proposed_content` is restored, including Tier 1; ambiguous or unmapped placeholders drop the proposal | same file; drop reasons `ambiguous_placeholder`, `unmapped_placeholder` | fails: placeholder text would be written |
| C5b | `explanation` and `question` restore unambiguous placeholders and keep ambiguous ones visible, without dropping | same file | fails: no restoration |
| C5c | Restoration runs on parsed leaves: an original containing `"` and `\` round-trips | same file | fails: no restoration |
| C6 | Tier 2 degraded refuses the review before any send | web test, NER stub offline: stub provider receives zero calls, job `failed`, audit row `tier2-unavailable` | fails: no tier exists |
| C6b | Tier 3 degraded proceeds; audit row has `redaction_degraded: true`; report `sent_to` has `tier: 3, degraded: true` | same file | fails: no fields |
| C7 | The consented tier is the tier that runs | web test: preflight at Tier 3, run with Tier 1 and the Tier-3 fingerprint returns 409 | fails: tier not in fingerprint |
| C8 | A cloud review writes a pending audit row before sending, and refuses if it cannot | web test with a directory at the log path: zero provider calls | fails: no row at all |
| C8g | The local review prompt is byte-identical to today's | `packages/librarian/test/review-local-prompt.test.ts`: snapshot of the prompt passed to a stub `generateJson` | guard |
| C9 | `NORTHKEEP_REDACT_TIER=2` and `=3` mask returned content, over MCP and in the CLI read path | `packages/mcp-server/test/redact-tier.test.ts` with an NER stub; `packages/cli/test/redact-tier.test.ts` | fails: plaintext |
| C10 | Tier 2 degraded over MCP returns an error and no content; Tier 3 degraded returns masked content with a note | `packages/mcp-server/test/redact-tier.test.ts` | fails: plaintext, no note |
| C11 | Project writes and content edits are refused under any tier of 1 or more | same file, tiers 2 and 3 | fails: `=== 1` lets 2 and 3 write |
| C12 | An invalid tier value is refused, never read as 0 | same file and the CLI file, `NORTHKEEP_REDACT_TIER=yes` | fails: read as 0 |
| C13 | Error text reaches the model inside a nonce fence with Cc, Cf, Co, Cs, Zl, Zp removed | `packages/converse/test/task-error-fence.test.ts`: stub server returns `isError` with a forged fence, a zero-width space, a BOM, U+0085 and a newline; plus a throwing tool; plus a web tool error with a third-party `detail` | fails: detail is bare |
| C13b | An `error` or `guidance` value outside the closed set is fenced, and `errorLine` shows `tool_failed` instead | same file | fails: passes through |
| C13g | `errorLine` never contains `detail` | same file | guard |
| C14 | The catalog vault server receives `memory_remember` content unmasked | `packages/converse/test/mcp-catalog-trust.test.ts`: catalog add, then a task call (gate stub approves once) with an email in content; the stub server records the arguments | fails: arrives as `[EMAIL_1]` |
| C15 | A custom-added server with the vault's exact command stays `strict` | same file | guard |
| C16 | When the log cannot be appended, a write does not happen | `packages/mcp-server/test/log-first.test.ts`: directory at the log path, `memory_remember` and `project_update`: vault bytes unchanged, error returned | fails: write lands |
| C17 | When the completion row fails after a write, the client gets a content-free acknowledgement plus `log_warning`; after a read, no payload | same file, append injected to fail on its second call | fails: error returned after the write |
| C18 | Pending rows never open or close a session | `packages/mcp-server/test/open-sessions.test.ts`, run against this build's derivation and against a copy of the pre-0060 derivation | guard (both pass on old code by the `ok === true` rule; the test pins it) |
| C18b | A session is closed when a project revision recorded at or after its last read names it as the writer, even with no completion row | same file | fails: derivation reads only the log |
| C18c | A pending row with a completion folds into one row in `northkeep log`, the GUI list and audit JSON/CSV; one without shows "outcome unknown (interrupted)" | `packages/cli/test/log-fold.test.ts`, `packages/mcp-server/test/audit.test.ts` | fails: no phase handling |
| C19 | The project_update description no longer says to prune the Log | `packages/mcp-server/test/tool-text.test.ts`: description contains "roll" and not "prune" | fails: says "prune the Log" |

## Residuals (documented, not closed)

- **R1. Collection names, ids and types leave as written** at every tier.
  A collection named after a client or patient leaves with every review.
  The panel says so.
- **R2. Masking is only as good as the tier.** Tier 1 masks secret
  shapes, not names; Tier 2 depends on the local name model's recall;
  Tier 3's floor is its dictionaries. Anything the tier does not detect
  leaves in plain text, as in chat.
- **R3. Review quality drops.** The model reasons over placeholders; a
  stale-date finding between two `[DATE-1948]` values cannot be
  established at Tier 3, and some proposals will drop as ambiguous. This
  is the cost of Jay's "Redact it".
- **R4. Screens still apply to the trusted vault server.** A
  `memory_remember` containing an SSN, card, IBAN or API key is
  hard-denied by ADR 0029 even though the destination is the local
  vault. Changing that is a screening change with its own review.
- **R5. The MCP degraded-Tier-3 note is only as visible as the host app
  makes it.** stderr and the log are ours; the tool-output display is
  the host's.
- **R6. Tier 2/3 over MCP adds latency.** The name model runs on every
  returned entry; large `memory_list` results will be slow.
- **R7. A crash between a landed memory write and its completion row**
  leaves a pending row with no outcome. Readers show "outcome unknown";
  memories carry no writer session id, so unlike projects this cannot be
  reconciled from the vault.
- **R8. The error fence reduces, and does not remove, prompt injection
  through error text** (same limit KNOWN-LIMITS states for results).

## What this does not build

- No change to chat, task, or mobile redaction; no change to published
  placeholder shapes (`[DATE-YYYY]` stays un-numbered).
- No restoration of Tier-2 pseudonyms in MCP replies (there is still no
  response hook; ADR 0003's parked proxy).
- No override that lets a loopback stub count as a `bounded` endpoint.
  Adding one would be a bypass in a privacy classifier.
- No automatic upgrade of existing `strict` vault entries.
- No change to the hosted connector, sync, or the ADR 0029 screens.
- No audit of other cloud send paths (guided consolidation, ADR 0047)
  beyond what the release pass already checked.

## Documents the implementation will make stale (gated claims)

KNOWN-LIMITS lines added in `6d67dd2` (only `=1` masks over MCP) and the
D2/D3/D6/D7 notes from `e9ff699`; README and site lines from `453a58d`
that name the cloud review as an exception to masking; ADR 0043 P8
("Full content of the included entries leaves") and P3's pinned prompt;
ADR 0033 Decision 3 and the config.ts comment; ADR 0052's call-log
correction note. Each rewrite is a published claim and ships under the
same review gate.

## Decisions for Jay

1. **`memory_edit` under masking.** Proposed: refuse content edits when
   any MCP tier of 1 or more is on (type-only edits still work). The
   alternative is to allow them and accept that a model can overwrite a
   real value with a placeholder it saw.
2. **An invalid `NORTHKEEP_REDACT_TIER` value** (for example `yes` or
   `4`). Proposed: the server starts, but refuses every tool call with
   "NORTHKEEP_REDACT_TIER=<value> is not 0, 1, 2 or 3", so the mistake
   shows in the AI app rather than only in a log. Alternative: treat it
   as Tier 1 plus a note, which keeps working but hides the typo.
3. **Existing vault servers added as `strict`.** Proposed: the Tools
   settings list shows, for a server whose launch matches the bundled
   vault server, one button "This is my NorthKeep vault: save exactly
   what I say", which sets `trusted` after a confirm. Alternative: a
   release-note line telling users to remove and re-add it.
4. **Tier 3 and `created_at`.** Proposed: year only at Tier 3 (1.1).
   Alternative: always send it, for better stale detection.
5. **Completion row failure.** Proposed: a write returns a content-free
   "saved" acknowledgement with a warning; a read returns an error and no
   payload (5.1).

## Acceptance (Jay, from the CLI)

Run from the worktree after `pnpm -r build`, in a throwaway home.
Nothing here touches `~/.northkeep`, and nothing calls a real provider.
Decisions 2, 5 and 6 use a disposable MCP client,
`scripts/adr-0060-mcp.mjs`, modelled on `scripts/adr-0054-mcp.mjs`: it
refuses any home other than `/tmp/nk-0060-acceptance/home` and, unlike
the 0054 client, **sets** `NORTHKEEP_REDACT_TIER` from its first argument.
The cloud review (Decision 1) has no CLI surface and a local stub is
classified private and refused, so its acceptance is a named test run
with an injected stub provider, not a live send.

```sh
export NORTHKEEP_HOME=/tmp/nk-0060-acceptance/home NORTHKEEP_NO_KEYCHAIN=1 \
       NORTHKEEP_PASSPHRASE='adr 0060 acceptance passphrase'
rm -rf /tmp/nk-0060-acceptance && mkdir -p "$NORTHKEEP_HOME"
nk() { node packages/cli/dist/index.js "$@"; }
app() { node scripts/adr-0060-mcp.mjs "$@"; }
nk init >/dev/null
nk remember "Reach me at bob@example.com, born 03/15/1948" --scope personal
```

1. **Tier 1 over MCP, unchanged.** `app 1 list personal` prints the
   memory with `[EMAIL_1]` and the date as written.
2. **Tier 3 over MCP masks more (D4).** Point the name model at a port
   nothing listens on, so the degraded case is certain whether or not
   Ollama is running (`ollamaUrl()` accepts any loopback address):
   `NORTHKEEP_OLLAMA_URL=http://127.0.0.1:9 app 3 list personal` prints `[EMAIL_1]`, `[DATE-1948]`, and the line
   `note: Tier 3 ran without the name model`.
3. **Tier 2 without the name model refuses (D4).**
   `NORTHKEEP_OLLAMA_URL=http://127.0.0.1:9 app 2 list personal` prints `refused: NORTHKEEP_REDACT_TIER=2 needs the local name model`
   and no memory text.
4. **A typo is refused (D4).** `app yes list personal` prints
   `refused: NORTHKEEP_REDACT_TIER=yes is not 0, 1, 2 or 3`.
5. **No project writes while masking (D4).** `app 2 update demo` prints
   a refusal naming masking; `nk projects list` shows no `demo`.
6. **Log before writing (D7).** `mv "$NORTHKEEP_HOME/mcp-calls.log" /tmp/nk-0060-acceptance/log.bak; mkdir "$NORTHKEEP_HOME/mcp-calls.log"`,
   then `app 0 remember "should not be saved"` prints
   `refused: NorthKeep could not write its call log`, and
   `nk list --scope personal | grep -c "should not be saved"` prints `0`.
   Restore with `rmdir "$NORTHKEEP_HOME/mcp-calls.log"; mv /tmp/nk-0060-acceptance/log.bak "$NORTHKEEP_HOME/mcp-calls.log"`.
7. **Pending rows fold (D7).** `app 0 list personal` then `nk log -n 2`
   shows one row for that call, not two.
8. **Vault server saves what you say (D6).**
   `app catalog-remember "my email is bob@example.com"` adds the vault
   server from the catalog in the throwaway home, runs one task through a
   local stub model that calls `memory_remember`, with a permission gate
   injected by the client that approves that one call (the call is
   consequential and the email raises an ADR 0029 warning, so an
   unattended run would otherwise stop at the prompt), and prints
   `stored: my email is bob@example.com`.
9. **Error text is fenced (D3) and the review is masked (D2).**
   `pnpm exec vitest run packages/converse/test/task-error-fence.test.ts apps/web/test/review-api-redact.test.ts packages/librarian/test/review-restore.test.ts`
   passes.
10. **Tool text (D8).** `app 0 describe project_update | grep -c "prune"`
    prints `0`.
11. **Clean up.** `rm -rf /tmp/nk-0060-acceptance`.

## Review history

None yet. The adversarial review of this design, against code, is
required before implementation and is recorded here when it runs.
