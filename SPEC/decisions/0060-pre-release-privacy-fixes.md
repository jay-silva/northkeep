# ADR 0060: Pre-release privacy fixes for 0.22.0 (D2, D3, D4, D6, D7, D8, D9)

- **Date:** 2026-09-24
- **Status:** Accepted and built; first released in 0.22.0
  (2026-09-24). Design CLEARED WITH WOUNDS after its
  recheck; the code review and its recheck ran, and the last findings were
  fixed and checked by targeted tests (see Review history). O1 and O2 use
  the recommended defaults, confirmed by Jay on 2026-09-24 ("accept all
  the recommended defaults"). Provider handling of the tagged tokens (R10)
  stays unverified until Jay's one real-provider run on a throwaway vault.
  "Build notes" below lists every place the build differs from the text.
  It changes what leaves the machine (D2, D4), puts third-party text in
  front of the model (D3), changes a trust level (D6) and publishes
  claims, so the CLAUDE.md review gate applies.
- **Deciders:** Jay (product owner), Claude Code
- **Jay's decisions (2026-09-24):** D2 "Redact it"; D7 "Log before
  writing"; and "Accept all" on the five open calls of the first draft,
  recorded as Decision 7.
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

Memory `content` goes through the redaction pipeline at the chosen tier.
The frame around it (instructions, ids, markers) is ours. Every field
sent, per tier:

| field | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| `id` | sent; must be a UUID or `prepare` refuses the run | same | same |
| `type` | sent; must be one of `MEMORY_TYPES` or `prepare` refuses | same | same |
| `scope` (collection name) | **Tier 1** | **Tier 1** | **Tier 1, then every date to year** |
| `created_at` | sent; must be an ISO 8601 UTC date-time or `prepare` refuses | same | **year only** (`2026`), Jay 2026-09-24 |
| `content` | Tier 1 | Tier 2 | Tier 3 |

Collection names (F6). The scope line of each block is run through
Tier-1 masking in the same run session as content (1.3), so
`patient:508-555-0142` goes out as `patient:[k7q2:PHONE_1]`. At Tier 3
the date layer also runs over the scope line (F7, recheck attack 7), so
`visit:2026-10-03` goes out as `visit:[k7q2:DATE_2026_1]`; otherwise a
user who chose Tier 3 to keep appointment dates coarse would still send
an exact date whenever a collection is named after one. Names in
collection names are not run through name detection at any tier
(residual R1). Consequences: the consent panel, the saved report and the
apply dialog show the real collection names, because they are local and
read from the vault, not from the wire; the model never has to echo a
scope, and proposals are keyed by entry id, so masking the scope costs
no review quality; a token whose only occurrence was in a scope line can
never be restored into a proposal (the `uncited_original` rule in 1.4).

`prepare` validates `id` against the UUID shape, `type` against the
enum and `created_at` as an ISO 8601 UTC date-time, and refuses the run
on any other value, so no caller can smuggle free text into the frame
through those fields (first review note 10, recheck note 4). Every
current id is minted by `uuidv4`; a future import that kept foreign ids
would make the review refuse, which is the safe direction.

### 1.2 The seam, and why the guarantee sits at the send

`@northkeep/redact` imports `@northkeep/librarian`
(packages/redact/src/index.ts:1), so `runReviewPass` cannot call
`redact()` without a dependency cycle. The seam:

- `createReviewApiGenerator` (converse, which already depends on redact:
  task.ts imports `applyTier1`) stops accepting a prompt string. It
  exposes two methods and nothing else:
  - `prepare(packs: MemoryEntry[][], tier)`: redacts every pack (1.3)
    and returns one opaque handle per pack, each carrying that pack's
    **token set**, plus the run's token mapping and the tier actually
    applied. A pack's token set is defined from the masking output: the
    tokens the redaction session issued while masking that pack's own
    content and scope lines. It is never computed by scanning the built
    prompt (recheck note 1), so the instruction sentence cannot add a
    token to it.
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
  functions over plain data (`Array<{token, original, kind}>` and each
  pack's token set), so librarian still does not import redact.

The web route is the only caller that passes a `ReviewOutbound`; it must,
because the adapter no longer offers a free-text send.

### 1.3 One numbering across the whole run, in a namespace of its own

Redaction gains an optional shared state,
`RedactOptions.session?: RedactionSession`, holding the Tier-1 `seen`
map, per-kind counters, a fresh pseudonym map (never shared with chat
or MCP), and a **run tag**. `prepare` creates one session per run.

**The run tag (F1).** Stored memories can already contain text that
looks exactly like a placeholder: `[EMAIL_1]` or `Person-1` written by a
Tier-1 host, or by the pre-0060 `strict` vault server (review attack 3).
Numbering from the session maps alone therefore collides with those
literals (review A1, A3, A4: the therapist's email restored into the
note about the ex; a literal `Person-1` restored to "Donna Keller").
So, inside a session, every placeholder issued by every layer uses one
grammar that stored text cannot contain:

    [<tag>:<KIND>_<n>]        e.g. [k7q2:EMAIL_1], [k7q2:PERSON_3]
    [<tag>:DATE_<year>_<n>]   e.g. [k7q2:DATE_1948_2]
    [<tag>:DATE_<n>]          a date with no recoverable year

- `<tag>` is four characters from `[a-z0-9]`, starting with a letter,
  drawn at random per run. `prepare` redraws it until the string
  `[<tag>:` occurs in no stored `content`, scope name, id or type in the
  run (at most 32 draws, then the run refuses). "Cannot occur" is
  therefore checked, not probable.
- Dates are **numbered inside a session**, so two different 1948 dates
  are `[k7q2:DATE_1948_1]` and `[k7q2:DATE_1948_2]`. Outside a session
  (chat, CLI `redact`, mobile, MCP) placeholder shapes do not change.
- Every layer's placeholder guard (Tier-1 guards, date guard, name
  dictionary, NER span guard) treats a tagged token as already masked,
  so a later layer never masks inside one (for example the year inside
  `DATE_1948_2`, or the tag read as a name).
- Untagged placeholder-looking text in stored content (`[EMAIL_1]`,
  `Person-1`) is plain text: it is sent as written (it is already
  masked text) and it is never a restoration target.

Properties (tested):

- the same original gets the same tagged token everywhere in the run;
- two different originals never share a token, including dates;
- no tagged token equals any substring of stored text in the run;
- without `session`, `redact()` output is unchanged for every existing
  caller.

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

0. **Only this pack's tokens count (F2).** Each prepared pack records
   the set of tagged tokens its own prompt contained. A reply for that
   pack may use only those. Any other tagged token (issued to another
   pack, or never issued) is treated as a forgery: in a quote it cannot
   match, in `proposed_content` it drops the proposal with reason
   `foreign_placeholder`, in `explanation` or `question` it stays
   visible unrestored. Review attack A2 (pack B naming pack A's
   `[EMAIL_1]`) becomes a drop.

   **Variant forms** (recheck note 2). Any text that contains the run
   tag followed by `:` compared case-insensitively, with or without the
   brackets (`[K7Q2:EMAIL_2]`, `k7q2:EMAIL_2`, `[k7q2:email_2`), and is
   not exactly an issued token of this pack, is treated as a forgery:
   `proposed_content` drops with `foreign_placeholder`, a quote cannot
   match, and `explanation` or `question` show it unrestored. A variant
   is never kept as literal text in a suggested wording.
1. Split the quote into literal runs and tagged-token occurrences, where
   a token is any string in this pack's token set.
2. Build a matcher: each literal run matches itself exactly; each token
   matches its one original. Name kinds (person, org, location) match
   case-insensitively, because replayed pseudonyms carry the lowercased
   map key as their original (redact/src/index.ts:163); every other
   kind matches exactly. Untagged placeholder-looking text is a literal
   run like any other.
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

- only tokens in this pack's token set are restored (step 0);
- each token has exactly one original (1.3), so there is no ambiguous
  case; if an implementation bug ever produced two, the proposal drops
  with `ambiguous_placeholder`;
- **the original must occur in the stored content of an entry the
  proposal cites** (`entry_ids`); otherwise the proposal drops with
  `uncited_original`. This stops a token that appeared only in a scope
  line, or only in an uncited entry of the same pack, from being
  spliced into a suggested wording (F1, F2 defence in depth). For a
  name kind the surface form is the one found in the target entry's
  stored content, else in another cited entry;
- untagged placeholder-looking text (`[EMAIL_1]`, `Person-1`) is kept
  only if it occurs literally in a cited entry's stored content;
  otherwise the proposal drops with `unmapped_placeholder`.

**The merge case, accepted** (recheck attack 5, note 3). A proposal that
cites two memories of the same pack may carry a value from one into the
suggested wording for the other (for example m2's email into m1). The
`uncited_original` rule allows it, because both memories are cited and
the model saw both, masked. Today's plaintext review can make the same
suggestion, so this is not a regression; the Save dialog shows the exact
text before anything is written (P6).

**`explanation` and `question` (display only, never applied).**
Tokens from this pack's set are restored; anything else stays visible
as written. Nothing is dropped for these fields.

**Prompt amendment (ADR 0043 P3).** The pinned prompt used on the API
path gains one sentence, with this run's tag filled in: "Some values
are replaced by placeholders such as [k7q2:EMAIL_0]. Copy them exactly
as written; do not guess what they hide." The example uses number 0,
which the session never issues (counters start at 1), so the example is
never a real token and never names the run's first email (recheck
note 1). The local path's prompt is unchanged.

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
  describing that tier>. Secrets in collection names are masked too;
  names in collection names are not. Memory types and ids are sent as
  written. At Tier 3 the recording date is reduced to the year."
  It also replaces "This run will send N memories" with "This run will
  send N memories, masked at Tier N". The Send button reads
  "Mask and send N memories to <host>".

### 1.6 Degraded tiers (invariant 6), per item and per run

All packs are redacted before the first send (1.2), so every failure is
known while nothing has left. Degradation is judged **per redaction
call**, not only "model not running": `applyTier2` reports `degraded` on
any name-model exception, timeout or unavailability, for that one call
(review attack 7: one memory at Tier 2, the next silently at Tier 1).

- **Tier 2, any item degraded (F3):** that item's redaction is retried
  once. If it is still degraded, the **whole run is refused** before any
  send: job `failed`, message "Name masking failed for N of M memories.
  Nothing was sent. Start the local model, or choose Tier 1 or Tier 3."
  Audit completion row `ok: false`, `error: tier2-unavailable`. A run is
  never sent with a mix of Tier-2 and Tier-1 items.
- **Tier 3, any item degraded:** the run proceeds (Tier 3's guarantee is
  its deterministic layers, as in chat, turn.ts:399-422). The run-level
  flag is the OR of all items, and the progress line, the saved report
  and the audit row all say "Tier 3, deterministic only (name model
  offline for N of M memories)".
- The applied tier recorded for a run is the lowest tier any item
  actually received; with the rules above that is always the chosen
  tier.
- Practical note: a cloud review already needs local Ollama, because
  with no embedder `runReviewPass` makes zero model calls
  (review.ts:191-198).

### 1.7 The audit row, written before the send

The cloud review writes no call-log row today. It gains one, under the
same "log before acting" rule as Decision 5: a `pending` row is appended
after redaction and before the first `send`; if it cannot be appended,
the run refuses and nothing is sent. Because the ids to be sent are
known before the first send, the **pending row carries the disclosure
ledger** (`result_ids`, `disclosed_scopes`, `redaction_tier`,
`redaction_degraded`, host, model). The completion row follows with the
outcome. If the completion append fails after sends (review note 9),
the report is still saved and the job ends `done` with the warning "The
review finished, but its log entry could not be completed"; the ledger
of what was sent is already on disk in the pending row.
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
  is refused** (Jay decision 2): the server starts, and every tool call
  returns "NORTHKEEP_REDACT_TIER=<value> is not 0, 1, 2 or 3; nothing was
  done." with no content, logged `ok: false`, `error: invalid_tier`.
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
  (the fields `maskProjectFields` masks today, project-mask.ts:18-22)
  go through `redact()` at that tier. Pseudonyms are consistent for the
  life of the server process: one `PseudonymMap` held in RAM, never
  written to disk, never logged. No run tag is used over MCP: the host
  keeps what it reads, and nothing is ever restored from it.
- **Tier 3 dates in every field except handles (F4).** Tier 3 promises
  all dates to the year, so at Tier 3 every date-valued string in a
  returned payload is reduced to its four-digit year, including fields
  the Tier-1 walk treats as identifiers. **Handle fields are the
  exception**: `scope`, `project`, and the scope and slug strings inside
  `disclosed_scopes`, `granted_scopes` and board rows are names the host
  must send back to call a tool, so they stay exact even when a user
  named a collection or project after a date (`visit:2026-10-03`,
  `care-2026-10-03`). This is scar tissue, residual R12. The date-typed keys, from `publicEntry`
  (server.ts:145-155) and `PROJECT_IDENTIFIER_KEYS`
  (project-mask.ts:8-16): `created_at`, `updated_at`, `checked_at`,
  `saved_at`, `recorded_at`, `opened_at`, `last_read_at`, `oldest`,
  `newest`, `date` (the board's dated items, the value the user typed),
  `last_activity`, `generated_at`, and the new `completed_at`. Because a
  list goes stale, the rule is also structural: at Tier 3 the walker
  reduces any string leaf under an identifier key that parses as a full
  date or date-time to its year. The enforcing test (C9b) calls every
  read tool at Tier 3 and asserts no string leaf outside the handle
  fields matches a month-and-day pattern. Consequence: at Tier 3 the host
  cannot order memories or revisions by exact time, only by year and by
  list order. Revision ids, not dates, remain the write handle, and
  writes are refused under masking anyway.
- **Order.** The slow NER pass runs after the vault is closed, on the
  payload `fn` returned, never inside `withVault`. ADR 0044 already
  learned that holding the vault lock across a loopback model call
  stalls every other tool (see the comment at server.ts:393-395). It
  runs **before** the completion row is written, so the completion row
  records the true outcome: a Tier-2 refusal writes `ok: false`, never
  an `ok: true` disclosure row followed by a refusal (review note 7).
- **Degraded Tier 2, any field (F3):** each field whose redaction reports
  degraded is retried once; if any is still degraded, the **whole call**
  returns an error and no content (never a partial payload): "Name
  masking failed (NORTHKEEP_REDACT_TIER=2); nothing was returned. Start
  the local model or use Tier 1 or 3." Completion row `ok: false`,
  `error: tier2-unavailable`.
- **Degraded Tier 3, any field:** content is returned with the
  deterministic layers applied, the payload carries `redaction_note:
  "Tier 3 ran without the name model; names outside the built-in lists
  may be unmasked."`, one stderr line is written per process, and the
  completion row carries `redaction_degraded: true`. Honest limit:
  whether the user sees the note depends on the host app.
- **Content writes under masking (F5, Jay decision 1).**
  - Any tier of 1 or more: project writes are refused
    (`refuseProjectWriteUnderTier1` becomes
    `refuseProjectWriteUnderMasking`, testing `>= 1`), and `memory_edit`
    with `content` is refused; a type-only edit is allowed.
  - Tiers 2 and 3: `memory_remember` is refused too. The model has read
    `Person-N` pseudonyms whose map lives only in this process's RAM, so
    a saved "Person-3 moved to Boston" could never be turned back into a
    name, and it would seed F1-style literals into later reviews.
  - Tier 1: `memory_remember` stays allowed (a new fact the user states
    is not masked text); residual R9 and open item O1.
  - `memory_forget` writes no content and stays allowed.
  - Refusal text: "Saving text is disabled while NORTHKEEP_REDACT_TIER=N
    because this app only sees masked text."
- **Log rows** record the tier actually applied (2 never degrades to 1
  here: it refuses; 3 degraded stays 3 with the flag), not the env
  string.

## Decision 3 (D3): error text is fenced and sanitized like results

At the single join point in task.ts (where `resultContent` is set,
task.ts:960-967), for **every** tool, not only MCP:

- A failed result is split into our part and theirs. "Ours" is a closed
  set, checked, not assumed: an `error` value is ours only if it is one
  of the error codes NorthKeep's tools and loop define (the web tools'
  `GUIDANCE` keys, the loop's own codes such as `tool_failed`,
  `budget_exceeded`, `tool_definitions_changed`), and a `guidance` value
  is ours only if it is one of the fixed strings those tables, the loop
  and the MCP client define. The MCP client's own pair,
  `tool_failed` / "The tool reported an error." (client.ts:397), is in
  the set (review note 6), so the user-facing line keeps its reason.
  `budget_exceeded`'s guidance is built from `budgetReason`, which is
  one of two fixed strings (task.ts:758-760); both are listed. Checked in code: both web tools build `error` from a code
  constant and `guidance` from their `GUIDANCE` table or a fixed
  fallback (webFetch.ts:43-47, webSearch.ts:154-158); their `detail`
  can carry third-party text (`err.message` at webSearch.ts:259). Our
  part stays bare JSON, re-serialized by us (`JSON.stringify` of the
  two fields only). Everything else is theirs: `detail`, any `error` or
  `guidance` value outside the closed set, and any failed content that
  is not our structured error JSON.
- Their part is sanitized by Unicode category, not by lists, in this
  order: NFKC normalization (so fullwidth brackets and NBSP become their
  ASCII forms before the fence check); every code point in `\p{Cc}`
  (C0 and C1 controls, newline included), `\p{Cf}` (zero-width, bidi
  marks, BOM, tag characters), `\p{Co}`, `\p{Cs}`, `\p{Zl}`, `\p{Zp}`
  and the variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF) is
  replaced by a space; any fence lookalike, closed or not
  (`\[\s*(END\s+)?EXTERNAL\s+CONTENT`, case-insensitive), is replaced
  by `[fence-marker-removed]`; then the text is capped at **2000 code
  points**, cut on a code point boundary so no lone surrogate can be
  produced (review note 5). This closes the gaps that
  `sanitizeServerText` misses zero-width characters and BOM, and that
  `wrapUntrusted`'s list misses C0/C1. The success path's `wrapUntrusted`
  and `truncateChars` are unchanged (residual R8).
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
     the running Node (catalog.ts:47-58). The launch fingerprint pin
     (ADR 0033 Decision 1) refuses a changed command, path or env under
     the same id. It does **not** detect a file replaced in place: it
     hashes the resolved path, command and env, not file content (review
     attack 16). That does not weaken this decision: a program that can
     replace NorthKeep's own server file already has everything the
     server has, including read access to the whole vault, so `trusted`
     gives it nothing more.
  2. It sends arguments nowhere by itself. Its only model client is
     Ollama, and `ollamaUrl()` refuses any non-loopback host with no
     override (packages/librarian/src/ollama.ts:20-29).
  3. What leaves after a write leaves on paths that already have their
     own rules, exactly as for a GUI write: the standalone server's
     auto-sync (mcp-server/src/auto-sync.ts, ADR 0044) pushes only the
     encrypted vault (invariant 2). Shared-scope content reaches the
     connector only through `pushSharedScopes`, whose callers are
     `/api/share/add`, `/api/share/sync` (the Share "Sync now" button)
     and the CLI `share` commands, all user-initiated (confirmed by the
     first review, attack 17). That push is invariant 1(b).
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
- Existing installs (Jay decision 3): the MCP settings list shows, for a
  stdio server whose resolved command and args equal the bundled vault
  server's **and which has no `env` and no `cwd`** (F8), one button,
  "This is my NorthKeep vault: save exactly what I say". It opens a confirm that names the program path, and only the
  confirm sets `trusted`. This is the one sanctioned exception to "never
  inferred from a matching command": the match only offers the button,
  and the user decides. C15 is amended accordingly: a matching custom
  server stays `strict` until that confirm.
- **Why no `env` and no `cwd`** (F8, recheck attack 9). `northkeep mcp
  add` accepts `--env NAME=VALUE` and `--cwd` (packages/cli/src/mcpCmd.ts:70-86).
  An entry with the bundled command and args plus
  `env: {NORTHKEEP_HOME: <another home>}` launches our own server
  against a different vault; the recheck saved a memory through such an
  entry and found it in the other home. Condition 1 is false for it, so
  the button is not offered for it, and a confirm that shows only the
  program path could not have warned the user. The stricter rule was
  chosen over "show every env value in the confirm" because it costs
  nothing: the catalog add passes neither (`resolveVaultServer` returns
  command and args only, catalog.ts:47-58), so the bundled server's own
  launch never has an `env` or `cwd` override, and an exact args match
  already excludes an extra `--vault` argument. The same rule applies to
  the catalog add itself: a catalog entry is added with no `env` and no
  `cwd`, as today (api.ts:1084-1088).

## Decision 5 (D7): log before acting

### 5.1 The row pair

`run()` becomes:

1. Mint `call_id` (random UUID). Append a **pending** row:
   today's `base` fields plus `phase: "pending"`, `call_id`, `ok: false`,
   `error: "pending"`. If this append throws, the tool body does **not**
   run; the client gets "NorthKeep could not write its call log, so
   nothing was done." No vault is opened: `memory_retrieve`'s
   pre-embedding step (`preEmbedForRetrieve`, server.ts:171-190, called
   at server.ts:396), which today opens the vault before `run()`, moves
   inside the envelope, after the pending row (review note 8). The
   start-up warm-up call at server.ts:995 is not a tool call, discloses
   nothing to a client, and is unchanged.
2. Run the tool body, then (reads) the return masking of Decision 2.
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
   (Jay decision 5, recorded in Decision 7.)

The catch path's row is a completion row like any other: `phase:
"done"`, the same `call_id`, `ok: false`, and the error code. Its append
is wrapped too; an append failure there no longer replaces the tool's
own error message (review notes 7 and 21).

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
  completion row. A pending row with no completion is shown as "in
  progress" while it is under five minutes old and as "outcome unknown
  (interrupted)" after that, never as success and never hidden.
- **Counting:** `readCallLog(n)` folds first and then takes the last `n`
  calls, so `northkeep log -n 2` shows two calls, not two raw rows.
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
> scope (the result's archive_summary counts them), so the Log's
> history never makes an update fail. An update is refused only when the
> document is still over 16384 characters with just the newest Log entry
> kept: long hand-written sections, or a long new entry on a nearly full
> document. NorthKeep never truncates.

This is the true rule: `rollProjectLog` keeps at least the newest entry,
then `assertProjectDocSize` refuses (project-doc.ts:241-264,
project-handoff.ts:193). The first draft's "a log entry is never refused
for size" was false at the edge (review attack 24: a 14116-character
document plus a 4000-character entry is refused). The hosted
description (apps/connector-server/src/mcp.ts:791-793) has the same
flaw; fixing it is a connector deploy and is listed under "What this
does not build".

`mergeProjectDoc` docstring (project-doc.ts:161-165): drop "Throws if the
serialized result exceeds PROJECT_DOC_MAX_CHARS" and say that size is
enforced by the caller through `rollProjectLog` and
`assertProjectDocSize` (ADR 0045), matching project-doc.ts:193-195.

## Decision 8 (D9): the name model reads the whole text, in windows

**The defect** (missed by the first review, found by the recheck,
attack 12). `detectEntities` sends the name model only
`text.slice(0, 6000)` (packages/redact/src/tier2.ts:124) and reports
nothing about the cut. Memory content reaches 8192 characters over MCP,
`memory_edit` and project fields 16384, and chat prompts carry whole
histories. A name after character 6000 is never seen, so it goes out in
plain text while the call reports Tier 2 (recheck: a 6.1k memory sent
with `applied:[2]` and "Quennell Abernathy-Vos" intact in the tail).
That is invariant 6's silent drop, and it affects chat, the cloud
review and MCP returns alike, because all three call the same
`applyTier2`.

**The fix.**

- `detectEntities` runs the name model over the **whole** text in
  windows of at most 6000 characters, each overlapping the previous by
  500 characters, so a name that straddles a boundary appears whole in
  at least one window (names are far shorter than 500 characters). A
  window boundary is moved back to the nearest whitespace within its
  last 200 characters when there is one, and never splits a surrogate
  pair.
- Hits from all windows are unioned and de-duplicated before masking;
  masking itself already runs over the full text by span text, so a name
  found in any window is masked everywhere it occurs.
- If any window's call fails (exception, timeout, unparseable output),
  the whole text counts as degraded, and the F3 rule applies unchanged:
  retry once, then refuse the run (cloud review) or the call (MCP) at
  Tier 2, or proceed labelled "deterministic only" at Tier 3. Chat keeps
  its existing rule (turn.ts:399-420): a degraded Tier 2 toward a
  bounded endpoint refuses, now also when only one window failed.
- The prompt format per window is unchanged, including the trailing
  "\nText:\n" marker the mobile client splits on (tier2.ts:110-114).
- Cost: a 16384-character text takes three or four name-model calls
  instead of one (residual R13).



Every test that opens a vault or writes the log sets `NORTHKEEP_HOME` to
a temp directory. No test calls a real provider; providers are local
stubs injected into the generator. Test paths follow the repo layout
(`<package>/test/*.test.ts`). The last column says whether the test
**fails on old code** (`fix022/privacy` at `6d67dd2`), which is the
proof the defect was real, or is a **guard** that passes on old code
and exists to stop a later regression. A guard is not evidence of a fix.

| # | claim | test (planned file) | old code |
|---|---|---|---|
| C1 | A cloud review sends no seeded Tier-1 value, in content **or in a collection name**; at Tier 3 no seeded full date in content **or in a collection name** (`visit:2026-10-03`), no dictionary name, and `created_at` as year only | `apps/web/test/review-api-redact.test.ts`: stub provider records wire text; corpus seeded into memories; assert no original and no full `created_at` appears | fails: wire text is the raw prompt |
| C2 | The API adapter has no free-text send | `packages/converse/test/reviewApi.test.ts`: `send` rejects a hand-built object and a string; only a `prepare` handle passes | fails: `generateJson(prompt)` accepts any string |
| C3 | Placeholder numbering is consistent across a run and tagged | `packages/redact/test/session.test.ts`: two different emails in two calls sharing a session get `[<tag>:EMAIL_1]`, `[<tag>:EMAIL_2]`; the same email twice gets one token; two different 1948 dates get two tokens | fails: numbering restarts per call, dates collide |
| C3g | Without a session, `redact()` output is unchanged | same file, against today's corpus outputs | guard |
| C4 | A quote containing placeholders validates against stored text, and the report keeps the stored span | `packages/librarian/test/review-restore.test.ts`, including a `[DATE-1948]` quote over an entry with two 1948 dates and a lowercased pseudonym original | fails: `includes()` rejects any placeholder |
| C5 | `proposed_content` is restored, including Tier 1; untagged placeholder-looking text not present in a cited entry drops the proposal | same file; drop reason `unmapped_placeholder` | fails: placeholder text would be written |
| C5b | `explanation` and `question` restore unambiguous placeholders and keep ambiguous ones visible, without dropping | same file | fails: no restoration |
| C5c | Restoration runs on parsed leaves: an original containing `"` and `\` round-trips | same file | fails: no restoration |
| C6 | Tier 2 degraded refuses the review before any send | web test, NER stub offline: stub provider receives zero calls, job `failed`, audit row `tier2-unavailable` | fails: no tier exists |
| C6b | Tier 3 degraded proceeds; audit row has `redaction_degraded: true`; report `sent_to` has `tier: 3, degraded: true` | same file | fails: no fields |
| C7 | The consented tier is the tier that runs | web test: preflight at Tier 3, run with Tier 1 and the Tier-3 fingerprint returns 409 | fails: tier not in fingerprint |
| C8 | A cloud review writes a pending audit row before sending, and refuses if it cannot | web test with a directory at the log path: zero provider calls | fails: no row at all |
| C8g | The local review prompt is byte-identical to today's | `packages/librarian/test/review-restore.test.ts` (C8g): the prompt passed to a stub `generateJson` equals a snapshot captured from `6d67dd2` | guard |
| C9 | `NORTHKEEP_REDACT_TIER=2` and `=3` mask returned content, over MCP and in the CLI read path | `packages/mcp-server/test/redact-tier.test.ts` with an NER stub; `packages/cli/test/projectsBoard.test.ts` (ADR 0060 C9, C12 cases) | fails: plaintext |
| C10 | Tier 2 degraded over MCP returns an error and no content; Tier 3 degraded returns masked content with a note | `packages/mcp-server/test/redact-tier.test.ts` | fails: plaintext, no note |
| C11 | Project writes and content edits are refused under any tier of 1 or more | same file, tiers 2 and 3 | fails: `=== 1` lets 2 and 3 write |
| C12 | An invalid tier value is refused, never read as 0 | same file and `packages/cli/test/projectsBoard.test.ts`, `NORTHKEEP_REDACT_TIER=yes` | fails: read as 0 |
| C13 | Error text reaches the model inside a nonce fence with Cc, Cf, Co, Cs, Zl, Zp removed | `packages/converse/test/task-error-fence.test.ts`: stub server returns `isError` with a forged fence, a zero-width space, a BOM, U+0085 and a newline; plus a throwing tool; plus a web tool error with a third-party `detail` | fails: detail is bare |
| C13b | An `error` or `guidance` value outside the closed set is fenced, and `errorLine` shows `tool_failed` instead | same file | fails: passes through |
| C13g | `errorLine` never contains `detail` | same file | guard |
| C14 | The catalog vault server receives `memory_remember` content unmasked | `packages/converse/test/mcp-catalog-trust.test.ts`: catalog add, then a task call (gate stub approves once) with an email in content; the stub server records the arguments | fails: arrives as `[EMAIL_1]` |
| C15 | A custom-added server with the vault's exact command and args, and no env or cwd, stays `strict` until the user confirms the "This is my NorthKeep vault" button; the confirm sets `trusted` | same file | guard for the first half; fails for the button (does not exist) |
| C16 | When the log cannot be appended, a write does not happen | `packages/mcp-server/test/log-first.test.ts`: directory at the log path, `memory_remember` and `project_update`: vault bytes unchanged, error returned | fails: write lands |
| C17 | When the completion row fails after a write, the client gets a content-free acknowledgement plus `log_warning`; after a read, no payload | same file, append injected to fail on its second call | fails: error returned after the write |
| C18 | Pending rows never open or close a session | `packages/mcp-server/test/open-sessions.test.ts`, run against this build's derivation and against a copy of the pre-0060 derivation | guard (both pass on old code by the `ok === true` rule; the test pins it) |
| C18b | A session is closed when a project revision recorded at or after its last read names it as the writer, even with no completion row | same file | fails: derivation reads only the log |
| C18c | A pending row with a completion folds into one row in `northkeep log`, the GUI list and audit JSON/CSV; one without shows "outcome unknown (interrupted)" | `packages/cli/test/log-fold.test.ts`, `packages/mcp-server/test/audit.test.ts` | fails: no phase handling |
| C20 | Literal placeholder text in stored memories never collides with issued tokens (F1): review A1 (a literal `[EMAIL_1]` in the "ex's address" memory alongside a therapist's real email elsewhere in the run), A3 (a literal `Person-1` alongside "Donna Keller" at Tier 3) and A4 (one memory with a literal `[EMAIL_1]` and a real email) each produce a proposal whose restored text contains no value that was not already in the target or a cited entry | `packages/librarian/test/review-restore.test.ts` with the real `redact()` session | fails: shared numbering restores the therapist's email and "Donna Keller" |
| C21 | The run tag occurs in no stored text of the run; a vault seeded with `[<tag>:` for the first drawn tag forces a redraw | `packages/converse/test/reviewApi.test.ts` with an injected tag source | fails: no tag |
| C22 | A reply for pack B that names a token only pack A's prompt contained is dropped as `foreign_placeholder` (F2, review A2) | `packages/librarian/test/review-restore.test.ts` | fails: restored to pack A's original |
| C23 | A restored original that occurs in no cited entry (for example one seen only in a scope line) drops the proposal as `uncited_original` | same file | fails: no rule |
| C24 | Tier-2 cloud review: a name-model stub that fails one memory's call once succeeds on retry and the run proceeds; one that fails it twice refuses the whole run with zero provider calls (F3) | `apps/web/test/review-api-redact.test.ts` | fails: that memory is sent at Tier 1 while the run is labelled Tier 2 |
| C25 | Tier-2 over MCP: one field's name-model call failing twice refuses the whole call with no content; completion row `ok: false` and no `ok: true` row for the call (F3, note 7) | `packages/mcp-server/test/redact-tier.test.ts` | fails: plaintext |
| C9b | At Tier 3 over MCP no string leaf outside the handle fields (`scope`, `project`, scope and slug lists) in any read tool's payload matches a month-and-day date pattern; `created_at` and the board's `date` are years (F4); a dated scope and slug are seeded and stay exact in the handle fields only | `packages/mcp-server/test/redact-tier.test.ts`, walking every read tool | fails: `"date":"2026-10-03"`, full `created_at` |
| C26 | `memory_remember` is refused at Tiers 2 and 3 and allowed at Tier 1 (F5) | same file | fails: allowed at 2 and 3 |
| C27 | `prepare` refuses a non-UUID id, a type outside the enum, or a `created_at` that is not an ISO 8601 UTC date-time | `packages/converse/test/reviewApi.test.ts` | fails: no check |
| C28 | The error sanitizer removes NBSP, fullwidth and unclosed fence lookalikes and variation selectors, and a 2000-code-point cap after an emoji never leaves a lone surrogate | `packages/converse/test/task-error-fence.test.ts` | fails: no sanitizer on the error path |
| C29 | An error-path completion row carries `phase: "done"` and the call's `call_id` | `packages/mcp-server/test/log-first.test.ts` | fails: no call id |
| C30 | `memory_retrieve` with an unwritable log opens no vault (no pre-embed read) | same file, with an instrumented vault open | fails: pre-embed opens it |
| C31 | The review's pending row carries the ids and scopes to be sent; a completion-row failure after the sends still saves the report and ends `done` with the warning | `apps/web/test/review-api-redact.test.ts` | fails: no row |
| C32 | The vault-trust button is offered only for an entry with the bundled command and args and no `env` and no `cwd`; the recheck's case (bundled command plus `env: {NORTHKEEP_HOME: <other home>}`) is not offered the button and stays `strict` (F8) | `packages/converse/test/mcp-catalog-trust.test.ts` and `apps/web/test/mcp-trust-button.test.ts` | fails: button does not exist; the rule guards the new code |
| C33 | A pack's token set comes from the masking output: the prompt's example token `[<tag>:EMAIL_0]` is never issued and never in any set, and an `explanation` in pack B naming pack A's token stays unrestored | `packages/librarian/test/review-restore.test.ts` | fails: no token sets |
| C34 | Variant forms of a run token (`[K7Q2:EMAIL_2]`, `k7q2:EMAIL_2`) drop `proposed_content` as `foreign_placeholder` | same file | fails: no rule |
| C35 | Tier-2 name masking covers the whole text: a name at character 6,100 of a 6,200-character memory is masked, in chat, in the cloud review and over MCP (D9) | `packages/redact/test/tier2-windows.test.ts` with a stub name model that finds names only in the text it is given; plus one case per caller (`turn-windows.test.ts`, `reviewApi.test.ts`, `redact-tier.test.ts`) | fails: the tail is never sent to the model |
| C36 | A name straddling a window boundary (starting 10 characters before character 6000) is masked | same file | fails: truncated at 6000 |
| C37 | One window's name-model call failing makes the whole text degraded, and the F3 rule applies (Tier 2 refuses after one retry; chat refuses toward a bounded endpoint) | same file plus `packages/converse/test/turn-windows.test.ts` | fails: no windows |
| C19 | The project_update description no longer says to prune the Log, and does not say a log entry is never refused | `packages/mcp-server/test/tool-text.test.ts`: contains "roll", not "prune", not "never refused"; plus the edge case of review attack 24 is refused with the cap message | fails: says "prune the Log" |

## Residuals (documented, not closed)

- **R1. Names in collection names leave as written** at every tier;
  secrets in them are Tier-1 masked (F6). Ids and types leave as
  written, and are validated as a UUID and an enum value. A collection
  named after a client or patient leaves with every review. The panel
  says so.
- **R2. Masking is only as good as the tier.** Tier 1 masks secret
  shapes, not names; Tier 2 depends on the local name model's recall;
  Tier 3's floor is its dictionaries. Anything the tier does not detect
  leaves in plain text, as in chat.
- **R3. Review quality drops.** The model reasons over placeholders; at
  Tier 3 it sees `[k7q2:DATE_1948_1]` and `[k7q2:DATE_1948_2]` and cannot
  tell which is later, and some proposals will drop (`uncited_original`,
  `foreign_placeholder`). This is the cost of Jay's "Redact it".
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
  through error text** (same limit KNOWN-LIMITS states for results). The
  success path keeps today's `wrapUntrusted` list and code-unit
  `truncateChars`, so NBSP or fullwidth fence lookalikes, variation
  selectors and a split surrogate can still appear inside a successful
  result's fence; the per-task nonce still holds (review attack 14).
- **R9. `memory_remember` at Tier 1 over MCP** can store a Tier-1
  placeholder the host read (`[EMAIL_1]`) as literal text (review attack
  3). Those literals can no longer collide with a cloud review's tokens
  (F1 closed by the run tag), but the memory itself holds a masked value.
  Open item O1.
- **R10. Provider behaviour with placeholders is unverified against a
  real provider.** Whether real models copy `[k7q2:EMAIL_1]` exactly, or
  invent tokens, has not been observed; F2's likelihood and the drop
  rate depend on it. Before this is called done, one live review run on a
  throwaway vault of fake data against a real provider is required (the
  repo rule on verifying against reality); Jay runs it.
- **R11. Tier 3 over MCP loses exact ordering by time.** All dates are
  years (F4); list order is the only finer ordering the host gets.
- **R12. Dated handles stay exact over MCP at Tier 3** (scar tissue,
  recheck attack 8). A collection or project named after a date
  (`visit:2026-10-03`, `care-2026-10-03`) is returned exactly in
  `scope`, `project` and the scope and slug lists, because the host must
  send those names back to call a tool. The cloud review has no such
  constraint and masks them (F7).
- **R13. Long texts cost more name-model calls at Tier 2 and 3** (D9):
  roughly one per 5500 characters.
- **R14. Some fence lookalikes still survive the error sanitizer**
  (`【END EXTERNAL CONTENT`, Cyrillic look-alike letters,
  `END_EXTERNAL_CONTENT`, split letters; recheck note 5). The nonce is
  intact, so this stays within R8.
- **R15. `mirror_status` keeps a relative time** ("3 hours ago") at Tier
  3. It is operational metadata, not user content (recheck note 7).

## What this does not build

- No change to chat, task, MCP or mobile redaction shapes: the tagged,
  date-numbered tokens exist only inside a cloud review session.
- No restoration of Tier-2 pseudonyms in MCP replies (there is still no
  response hook; ADR 0003's parked proxy).
- No override that lets a loopback stub count as a `bounded` endpoint.
  Adding one would be a bypass in a privacy classifier.
- No automatic upgrade of existing `strict` vault entries (the user
  confirms, Decision 4).
- No fix to the hosted `project_update` description's "never refused for
  size" sentence (a connector deploy; flagged for a separate change).
- Out of scope, noted by the first review: the Tier-1 email detector
  misses `mom+(old)@example.com` (note 11); the review report is
  plaintext JSON on disk with memory snapshots, which contradicts
  log.ts's header claim (note 12). Both are real and need their own
  change.
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

## Decision 7: Jay's decisions (2026-09-24, "Accept all")

1. **Content edits under masking:** `memory_edit` with content is refused
   whenever any MCP tier of 1 or more is on; type-only edits still work
   (Decision 2).
2. **A mistyped `NORTHKEEP_REDACT_TIER`:** every tool call is refused,
   naming the bad value (Decision 2).
3. **Existing installs:** a one-click "This is my NorthKeep vault" fix,
   with a confirm, sets `trusted` (Decision 4).
4. **Tier 3 cloud review:** recording dates go out as the year only
   (1.1).
5. **Log failure after a save:** a write returns a content-free "saved"
   acknowledgement with a warning; a read returns an error and no
   payload (5.1).

## Open items for Jay

- **O1. `memory_remember` at Tier 1 over MCP.** Built with the
  recommended default, confirmed by Jay on 2026-09-24. Proposed: leave it
  allowed (a Tier-1 host still needs to save new facts), accepting R9.
  Alternative: refuse a save whose text contains a NorthKeep placeholder
  shape such as `[EMAIL_1]`, which would also refuse the rare memory
  that legitimately contains that text.
- **O2. Names in collection names (R1).** Built with the recommended
  default, confirmed by Jay on 2026-09-24. They are sent as written at
  every tier. Proposed: accept it, with the panel sentence. Alternative:
  run the tier's name layers over scope names too (cheap, but a
  collection named "Donna Keller" would reach the model as a token).

## Build notes (2026-09-24)

Commits on `fix022/privacy`: a57e789 (redact: windowed name detection,
review sessions), 6b45908 (MCP return tiers, log before acting, D8
text), c331ff9 (cloud review masking, error fence, vault trust),
cf9a1fd (per-caller window tests), 503c4d5 (error codes exact under
masking, acceptance client), 4660b62 (documents), 5f4df6a (review fixes:
runtime fake key, plain call-log message, narrower KNOWN-LIMITS line). Where the build
differs from the text above, and why:

1. **How the session issues tokens (1.3).** The layers themselves are
   unchanged. `maskContentInSession` runs the ordinary `redact()` to
   find what to mask, then rewrites every masked original in the
   *original* text to its run token, longest first, and refuses the run
   if any masked original survives outside a token (fail closed). No
   layer's emitter or placeholder guard changed, so "a later layer never
   masks inside a token" holds because tokens are only written after
   every layer ran. All 1.3 properties are tested (C3, C3g, C20, C21).
   A consequence: every occurrence of a masked value is masked, even an
   occurrence a context-sensitive detector skipped. Over-masking is the
   safe direction.
2. **The vault-trust button is one click and a confirm, no passphrase**
   (as Jay decided). The first build asked for the passphrase, on the
   reasoning that a caller holding only the GUI session token must not
   lift masking. The code review showed that reasoning false: with the
   same token, removing the entry and adding the vault server from the
   catalog (one click by ADR 0034's design) yields the same `trusted`
   entry. Masking the arguments sent to our own vault server protects
   nothing (conditions 1 to 4), so the passphrase was removed rather than
   added to the catalog path too.
3. **Tier-1 return masking now covers `content` in every memory payload**
   (`memory_remember`, `memory_edit` and `memory_forget` replies too), not
   only retrieve and list. A type-only edit used to echo the full
   plaintext at Tier 1.
4. **Refusal error codes stay exact under masking.** Running acceptance
   against a real loopback name model showed it tagging our own
   `invalid_request` code as an organisation; `code` is treated like an
   identifier (C11 now asserts it).
5. **The connector's copy of `project-doc.ts`** was updated with the
   corrected `mergeProjectDoc` docstring, because a test keeps it
   byte-identical to core. Comment only; the hosted `project_update`
   description is still out of scope.
6. **Open sessions from recorded writers (5.3)** are applied in
   `project_resume`, where the revision writers are at hand. The board's
   open-session count still uses the log alone, because a project summary
   carries no writer session id.
7. **The web routes check the tier after the endpoint checks**, so the
   existing error order for a bad endpoint or fingerprint is unchanged.
8. **C28** is a unit test of the new sanitizer module; the stash proof
   below reverted only `task.ts`, so it shows C13 and C13b failing, not
   C28 (the module did not exist at `6d67dd2`).
9. **Acceptance**: `nk remember` needs `--type`; step 3's text and step
   5's shape are corrected above. Every step was run in
   `/tmp/nk-0060-acceptance` against the built CLI and matched.

**Proof that the tests fail on the old code (sample).** With
`packages/redact/src/tier2.ts`, `packages/mcp-server/src/server.ts` and
`packages/converse/src/task.ts` checked out from `6d67dd2` and nothing
else changed, 22 of 26 tests in `tier2-windows`, `redact-tier`,
`log-first` and `task-error-fence` failed (C9, C9b, C10, C11, C12, C13,
C13b, C16, C17, C25, C26, C29, C30, C35, C36, C37); the four that passed
are the guards C13g and "a short text is one call", and the two sanitizer
unit tests (note 8). Restoring the files made all of them pass again.
Second sample, one decision each: with `packages/librarian/src`,
`packages/converse/src`, `apps/web/src` and `apps/web/static` from
`6d67dd2` and rebuilt, all 8 tests in `review-api-redact` failed (C1 saw
the seeded email in the wire; C6, C6b, C7, C8, C24, C31 too). With only
the catalog's `trust: 'trusted'` line removed, C14 failed. With
`server.ts` from `6d67dd2`, C19's description test failed (its edge-case
half is a guard that passes). With `log.ts`, `audit.ts` and
`open-sessions.ts` from `6d67dd2`, C18b and C18c failed and C18 passed, as
a guard should. Everything was restored and rebuilt afterwards.

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
nk remember "Reach me at bob@example.com, born 03/15/1948" --type semantic --scope personal
```

1. **Tier 1 over MCP, unchanged.** `app 1 list personal` prints the
   memory with `[EMAIL_1]` and the date as written.
2. **Tier 3 over MCP masks more (D4).** Point the name model at a port
   nothing listens on, so the degraded case is certain whether or not
   Ollama is running (`ollamaUrl()` accepts any loopback address):
   `NORTHKEEP_OLLAMA_URL=http://127.0.0.1:9 app 3 list personal` prints `[EMAIL_1]`, `[DATE-1948]`, a
   `created_at` that is only a year, and the line
   `note: Tier 3 ran without the name model`.
3. **Tier 2 without the name model refuses (D4).**
   `NORTHKEEP_OLLAMA_URL=http://127.0.0.1:9 app 2 list personal` prints
   `refused: Name masking failed (NORTHKEEP_REDACT_TIER=2); nothing was returned.`
   and no memory text.
4. **A typo is refused (D4).** `app yes list personal` prints
   `refused: NORTHKEEP_REDACT_TIER=yes is not 0, 1, 2 or 3`.
5. **No content writes while masking (D4).** With the name model on or
   off (`NORTHKEEP_OLLAMA_URL=http://127.0.0.1:9` for off),
   `app 2 update demo` prints a refusal whose message is `Saving text is
   disabled while NORTHKEEP_REDACT_TIER=2 ...` (inside a small JSON error,
   code `invalid_request`), and `app 2 remember "Person-3 moved"` prints
   `refused: Saving text is disabled while NORTHKEEP_REDACT_TIER=2`;
   `nk projects board | grep -c demo` prints `0`, and
   `nk list --scope personal | grep -c "Person-3"` prints `0`.
6. **Log before writing (D7).** `mv "$NORTHKEEP_HOME/mcp-calls.log" /tmp/nk-0060-acceptance/log.bak; mkdir "$NORTHKEEP_HOME/mcp-calls.log"`,
   then `app 0 remember "should not be saved"` prints
   `refused: NorthKeep could not write its call log`, and
   `nk list --scope personal | grep -c "should not be saved"` prints `0`.
   Restore with `rmdir "$NORTHKEEP_HOME/mcp-calls.log"; mv /tmp/nk-0060-acceptance/log.bak "$NORTHKEEP_HOME/mcp-calls.log"`.
7. **Pending rows fold (D7).** `app 0 list personal` then `nk log -n 1`
   shows that `memory_list` call, once, as succeeded (not a `pending`
   row).
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

### First review, 2026-09-24: CLEARED WITH WOUNDS

Fresh-eyes subagent, against code at `ae870d3`, in an isolated worktree
with a throwaway `NORTHKEEP_HOME`; no real provider called. Report:
`Reviews/adr-0060/r1-first-review.md`; scripts under the review
worktree's `.adversarial/0060-r1/`. It confirmed by execution that D4
(tiers 2, 3 and `yes` return plaintext) and D7 (a write lands with no
row when the log append fails) are real on old code. No kill shot,
because every cloud-review write needs a per-item Save of the exact
text.

Flesh wounds and how this revision closes them:

- **F1** (run numbering collides with placeholder-looking text already
  stored; the therapist's email restored into the ex's note, a literal
  `Person-1` restored to "Donna Keller"): tokens are issued in a per-run
  tagged namespace whose prefix is checked absent from all stored text,
  dates are numbered inside a session, only issued tokens are restored,
  and a restored original must occur in a cited entry (1.3, 1.4; C20,
  C21, C23).
- **F2** (a reply for one pack could restore a token only another pack
  was shown): restoration accepts only the tokens that pack's own prompt
  contained; others drop as `foreign_placeholder` (1.4 step 0; C22).
- **F3** (one failed name-model call silently degraded one item while the
  run stayed labelled Tier 2): degradation is judged per call, retried
  once, and at Tier 2 refuses the whole run (D2) or the whole call (D4);
  Tier 3 proceeds with a run-level flag (1.6, Decision 2; C24, C25).
- **F4** (exact dates left at Tier 3 over MCP in `date` and
  `created_at`): every date-valued field reduces to the year at Tier 3,
  by key list and by a structural rule, with a test over every read tool
  (Decision 2; C9b).
- **F5** (`memory_remember` allowed under Tiers 2 and 3): refused at
  Tiers 2 and 3; Tier 1 left as open item O1 (Decision 2; C26).
- **F6** (Tier-1 shapes in collection names sent unmasked): scope names
  are Tier-1 masked in the run session; display stays local and real;
  scope-only tokens can never be restored (1.1; C1, C23).

Notes taken: D6 condition 1 reworded (the pin does not detect an
in-place file swap; the conclusion stands) and condition 3 closed with
the review's evidence; the confirm button is named as the one sanctioned
exception to "never inferred" (C15); D8 wording now states the true
rule (C19); the D3 cap counts code points, the sanitizer adds NFKC,
variation selectors and unclosed or lookalike fences, and the MCP
client's fixed error pair is in the closed set (C28); D7 now specifies
the error-path row (`phase`, `call_id`), in-flight versus interrupted
labels, fold-then-slice counting, masking before the completion row,
and the pre-embed moved inside the envelope (C29, C30); D2 1.7 now says
what happens when the review's completion row fails (C31); `prepare`
validates ids and types (C27). Notes 11 and 12 are out of scope and
listed under "What this does not build". The unverified provider
behaviour is residual R10.

### Design fix round, 2026-09-24

Design only, no product code. Jay's five decisions recorded as
Decision 7. Awaiting the recheck.

### Recheck, 2026-09-24: CLEARED WITH WOUNDS

Recheck agent, skill loaded fresh, against `4989099`, in the isolated
review worktree with throwaway homes; no real provider called. Report:
`Reviews/adr-0060/r2-recheck.md`; scripts under `.adversarial/0060-r2/`.
F1 to F6 closed with executed reproductions, no prior finding back, and
the first-review notes held. Treated as a patch within the same
approach. New findings, and how the final text pass closes them:

- **F7** (a dated collection name went to the cloud review exactly at
  Tier 3): the Tier-3 date layer also runs over the scope line (1.1;
  C1).
- **F8** (the vault-trust button matched command and args only, so it
  was offered for an entry whose `env` pointed our server at another
  vault): the button requires no `env` and no `cwd`, the stricter rule,
  which the bundled launch already satisfies (Decision 4; C32).
- **Scar tissue** (dated scope and slug handles stay exact over MCP at
  Tier 3): recorded as R12; the F4 rule and C9b are narrowed to exclude
  handle fields.
- **Missed in first review, now D9** (the name model reads only the
  first 6000 characters and reports nothing): windowed name detection
  over the whole text, failure under the F3 rule, for chat, the cloud
  review and MCP (Decision 8; C35 to C37).
- **Notes taken:** token sets come from the masking output, and the
  prompt's example token is `_0`, which is never issued (C33); variant
  token forms drop (C34); the merge case is stated and accepted (1.4);
  `created_at` is validated in `prepare` (C27); surviving fence
  lookalikes and `mirror_status` relative times are residuals R14 and
  R15.

### Final text pass, 2026-09-24

Design only, no product code. This pass has **not** been re-reviewed.
The next gate is the build, followed by a full adversarial review of
the code. R10 (how real providers handle the tagged tokens) needs Jay's
one real-provider run on a throwaway vault of fake data before the work
is called done.

### Build, 2026-09-24

Built as designed with the differences listed under "Build notes". Every
claims row has a test; a sample was proven to fail on `6d67dd2`. The full
adversarial review of the code has not run yet and is the next gate.

### Code review, first round, 2026-09-24: CLEARED WITH WOUNDS

Fresh-eyes subagent against the built branch in an isolated worktree,
stub models only. Report: `Reviews/adr-0060/code-r1.md`. Findings F1 to
F3 below; notes on `source`, the trust-button rationale and acceptance
step 5. A separate claims review of the README and site
(`cr-claims/.adversarial/claims-r1/b1-readme-site/`) found a kill shot,
and one of KNOWN-LIMITS (`.../b2-kl-docs/`) found tag-stripped tokens
surviving restoration.

### Code fix round, 2026-09-24

- **Kill shot (claims review): a duplicate "entities" key.** A real
  llama3.2:3b replied `{"entities":[...Bob Henderson...],"entities":[...]}`
  in 8 of 10 runs; `JSON.parse` kept the last list, the name was dropped,
  and the text went out unmasked at "Tier 2". The reply is now read by a
  duplicate-aware strict parser (`packages/redact/src/ner-reply.ts`):
  every entity in every "entities" list counts, and a reply that cannot be
  fully accounted for throws, so Tier 2 refuses and Tier 3 is labelled
  deterministic only. Covers chat, the cloud review and MCP (all call
  `applyTier2`). Tests K1 to K4 in `tier2-reply.test.ts` use the review's
  exact replies; K1 and K3 failed on the old parser. Real local model, 10
  runs of the review's synthetic text after the fix: 10 masked, 0 leaked
  (7 replies had the duplicate key). Not fixed: the phone's per-kind NER
  pass (`packages/platform-mobile/src/local-model/per-kind-ner.ts`) has
  its own `JSON.parse` of on-device replies; it needs the same change and
  a phone build (open item O3).
- **F1 (uncited splice).** A memory counts as cited only when a quote
  from it validated against its stored text. The API prompt now asks the
  model to quote any memory whose placeholder it uses. Test A-W1 (and its
  control) in `review-restore.test.ts`; A-W1 failed on the old code.
- **F2 (detected name sent elsewhere in plain text).** The cloud review
  now detects across every memory and collection name first, then renders
  all of them with every token the run issued (`detectContentInSession`,
  `detectScopeInSession`, `renderInSession`); MCP masks each call in the
  same two passes. A name found by detection is therefore also masked
  inside collection names, which is stricter than O2 stated. Tests A-W2
  (redact side and through the web route) and A-M7; all failed on the old
  code.
- **F3 (landed write reported failed).** A write whose reply cannot be
  masked at Tier 2 returns a content-free `saved` with a warning and logs
  `ok: true` with `redaction_degraded: true`. Test A-M3; failed on the old
  code.
- **Mis-copied placeholders (KNOWN-LIMITS review).** Suggested text is
  dropped when it holds any placeholder shape the redactor or session can
  emit, from one label list (`PLACEHOLDER_LABELS`, checked against the
  redactor's kinds by a test), with or without brackets, tag or colon,
  case-insensitive: `[DATE_1948_1]`, `EMAIL_1`, `<EMAIL_1>`,
  `[k7q2 EMAIL_1]`, `[DATE-1948]`, `[REDACTED]`. Plain prose such as
  "date of birth" is not a placeholder. Test "Claims-review wire case";
  failed on the old code.
- **Item 5.** `northkeep redact --tier 3`, `converse --tier 3` and
  `/api/redact` with tier 3 now run Tier 3, and any other value is refused
  by name (tests `tier-flags.test.ts` and the `/api/redact` case). The
  memory `source` field is masked like content at Tiers 1 to 3 (test M2).
  Write refusals under masking keep their own words when the name model
  is down, which fixes acceptance step 5; the step now uses
  `nk projects board` (there is no `projects list`). The trust button
  lost its passphrase (build note 2).
- KNOWN-LIMITS: only the three lines this round's code changed were
  edited (trust button, cited quotes, unreadable model replies); the
  final KNOWN-LIMITS pass is the lead's after merge.

## Open items for Jay (added in the code fix round)

- **O3. The phone's name pass reads on-device replies with `JSON.parse`**
  and has the same duplicate-key exposure. Closed the same day, because
  build 28 ships with this release (below).

### O3 fix, 2026-09-24 (phone build 28 ships with this release)

- The strict reply reader moved to `@northkeep/core` (`readNerReply`) so
  the phone can share it; `@northkeep/redact` re-exports it.
- `per-kind-ner.ts` (the retired Apple FM per-kind path, kept for
  rollback) reads each pass reply with it: every duplicate "entities"
  list counts, and an item without a string text or more entities than
  the cap fails the pass instead of being skipped or cut.
- Fail closed at run level: any failed, timed-out or skipped pass now
  fails the whole run, which `applyTier2` turns into `tier2Degraded`, so
  the phone shows its existing "Tier 2 name detection was unavailable"
  warning and a Tier-2 send to a cloud model refuses. Before, the other
  passes' results were returned as a clean Tier 2.
- The NLTagger client (the live phone path) returned "no entities" for a
  prompt shape it did not recognise; it now throws, so the turn degrades
  and says so. Its native spans are serialized with `JSON.stringify` and
  read by the same strict reader in `applyTier2`.
- Tests: `packages/platform-mobile/test/per-kind-ner.test.ts` (O3 cases,
  including a duplicate "entities" reply) and
  `apps/mobile/test/nltagger-ner-closed.test.ts`. On the old phone code 8
  per-kind tests and the NLTagger unknown-prompt test failed. Mobile
  typecheck, the offline Metro export (iOS bundle, 7.7 MB), the mobile
  tests, the full suite and e2e pass.

### Code review recheck and final targeted fix, 2026-09-24

Recheck report: `Reviews/adr-0060/code-r2-recheck.md`. K1, F2, F3 and F6
closed; F1 still open by another route; a missed shape found. Jay approved
this final targeted fix with no further review round; the lead verifies
the tests.

- **F1, second route.** A restored original may come only from a memory
  that is both listed in the proposal's `entry_ids` and quoted with a
  validated quote. Before, a validated quote from an unlisted memory
  (its own placeholder, or one real character of it) cited that memory,
  and the report, which shows only listed memories' quotes, hid it while
  its value was spliced in. Tests R1a and R1b in `review-restore.test.ts`;
  both failed on the old code.
- **Names under an unexpected key.** The strict reader now also requires
  each item's keys to be only "text" and "kind", so a nested "entities"
  list or a name under another key fails the reply (Tier 2 refuses, Tier 3
  runs deterministic only) instead of being ignored. The reader's header
  and the phone parser's length comment now say only what the code checks.
  Tests R2 in `tier2-reply.test.ts` (desktop) and `per-kind-ner.test.ts`
  (phone); both failed on the old code. The recheck saw this shape in 0 of
  54 real replies; it predates this ADR.
- **Placeholder detector false positives.** The detector now matches only
  shapes the redactor or a session emits and their mis-copies: a label
  with an underscore index (in any brackets, with or without a tag),
  bracketed `[DATE]`, `[DATE-1948]` and `[REDACTED]`, and `Person-3`,
  `Org-2`, `Place-4`, `Location-1`. "(ZIP 02532)", "ip-10-0-0-12" and
  "(email)" are kept (test R3, failed on the old code); every earlier
  mis-copy case still drops.
- **W2 (claims recheck): Tier 3 masked fewer org names than Tier 2.** The
  Tier 3 name-model pass used a strict gate that dropped finds made only
  of common English words, so "First National Bank" and "Acme Widgets"
  went out at Tier 3 while Tier 2 masked them, labelled Tier 3. Tier 3 now
  runs the same full pass as Tier 2, reading the text before the name
  lists (what Tier 2 sees), and masks its finds on top of the lists; when
  the lists already masked part of a find, each remaining word of it is
  masked. Tier 3 therefore masks at least everything Tier 2 masks on the
  same text and name model. Property tests on `redact`, chat, the cloud
  review and MCP (`tier3-superset.test.ts` in redact, converse and
  mcp-server; shared inputs in `redact/test/superset-fixture.ts`): all 10
  failed on the old code. Two older Tier 3 tests that pinned the strict
  gate's non-masking were changed to assert Tier 2 parity. Real local
  model, synthetic text: "Meet Dana at First National Bank" is
  `Org-1` at both tiers (3 of 3); for "Call Zorblax Quintavius at Acme
  Widgets" the model replied with a stray top-level "text" key, which is
  unreadable, so both tiers report degraded (Tier 2 refuses toward a cloud
  model, Tier 3 is labelled deterministic only). The CLI converse banner
  now reads "everything Tier 2 masks, plus every date to the year and
  names on the built-in lists" (it printed "OFF" for Tier 3 on this
  branch), and KNOWN-LIMITS states the Tier 3 superset rule.

