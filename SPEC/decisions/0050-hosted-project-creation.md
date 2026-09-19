# ADR 0050: A connected app can create a project

- **Date:** 2026-09-19
- **Status:** Accepted for implementation 2026-09-19. Fifth review
  returned CLEARED WITH WOUNDS; the wounds are pinned as binding
  amendments below and verified by the post-implementation review. Jay decided the consent
  question on 2026-09-19: mark on arrival, badge only; revisions 3 and 4
  narrowed when that mark may be made until the rule needs no
  provenance signal at all.
- **Deciders:** Jay (product owner; chose "hosted connector too" on
  2026-09-19), adversarial reviewer, Claude Code
- **Amends:** ADR 0040 Decision 5 ("Cloud cannot create a project") and
  Decision 7 (the desktop fold), the hosted line of the ADR 0042 contract,
  the tombstone clear-on-reshare in the ADR 0038 addendum (made
  unconditional), and the "loudly confirmed" clause of CLAUDE.md invariant
  #1 (one named exception)
- **Does not touch:** the row envelope and DEK custody (ADR 0020), vault
  schema 0.3, the `scopes` table shape (ADR 0038), `memory_remember` and
  its 8 KiB cap, revision-bound local handoffs (ADR 0048), the sync server

## Context

The site already promises "Create a project in any connected app, or in
NorthKeep" (`site/start.html`, step 10). Only half of that is true. The
local MCP server creates a project when `project_update` is called with
`expected_revision: null`, and has since ADR 0039. The hosted connector
refuses: ADR 0040 Decision 5 pinned "Cloud cannot create a project" and the
installed contract tells agents "never create a project there".

That was the right call for M14, when the fold that turns a connector row
into a vault document was new. It is now the wrong shape for the product.
A project that starts in Claude.ai has nowhere to live until the user opens
NorthKeep, creates the scope, shares it, and asks the agent to try again.
Jay asked for hosted creation on 2026-09-19.

Two things make this more than a tool addition, and both sit under the
CLAUDE.md review gate:

1. **Who decides that a scope is shared.** ADR 0038 made the shared mark
   in the vault the user's act of consent, stamped on a private-to-shared
   transition. A project created in a connected app has no private
   history to disclose, but a shared mark is forward-looking: every later
   write into `project:<slug>`, including a local agent's log entry, will
   be pushed to the connector on the next share sync. This ADR lets the
   desktop fold make that mark without a dialog. That is a change in who
   decides, argued below.
2. **A new hosted write path into the vault.** The connector already
   writes pending rows that the fold applies. Creation reuses that path
   exactly, but it is the first hosted write that can bring a scope into
   existence rather than merge into one the user already opened.

## What the fold does today, and why it forks

`downSyncConnector` (ADR 0040 Decision 7) already handles a pending
`working` row in a slug-valid project scope with no live local working
document: it calls `vault.remember`. So the vault side of creation exists.
What is missing is the scope mark. The scope is not marked shared, so:

- `pushSharedScopes` never includes it. The server keeps the acked row
  (pending cleared, id remapped) and every later hosted `project_update`
  merges against that server copy.
- Local edits never reach the server. Hosted edits reach the vault and
  supersede the local document. The two sides fork silently, with the
  hosted side always winning.
- The Projects page shows no Shared badge, so the user has no signal
  that a connected app can write this document.

This is why creation cannot be "just lift the refusal". The mark is the
load-bearing piece.

## Decision 1: A dedicated `project_create` tool, on both servers

Creation is its own tool, not a mode of `project_update`.

- Hosted `project_update` stays fail-closed on an unknown slug. A typo in
  a slug must keep returning "no live project document", never quietly
  spawn a second project. This is the one place the local and hosted
  tools were already different (local accepts `expected_revision: null`),
  and the hosted tool has no revision argument to make intent explicit.
- The local server gains `project_create` too, so the contract can name
  one tool on every surface. Local `project_update` with
  `expected_revision: null` keeps working; it is not deprecated.

Signature, identical on both servers:

```
project_create({
  project: slug,                 // PROJECT_SLUG_PATTERN, validated first
  title?: string (<= 120),       // hosted: accepted and stored in the
                                 // document only if the hosted doc format
                                 // already carries it; see Decision 6
  what_why: string (1..16384),
  status: string (1..16384),
  next_actions?: string (<= 16384),
})
```

`what_why` and `status` are required. An empty project is not a project;
the agent must say what it is and where it stands. Log and Decisions start
empty. No `log_entry` on create: the first log entry belongs to the first
session that does work.

## Decision 2: Hosted create writes one pending working row, same envelope

Hosted `project_create` builds the document with the same pure functions
the desktop uses (`emptyProjectDoc`, `mergeProjectDoc`,
`serializeProjectDoc`, `assertProjectDocSize`), encrypts it as
`{type: 'working', content}` under the per-account DEK, and stores it as
`origin='connector'`, `pending=true`, stored type column `''`, id
`conn_<uuid>`. That is byte-for-byte the row `project_update` already
writes when it starts from a vault-pushed base (ADR 0040 Decision 2). No
new storage method, no schema change, no envelope change, no change to
`/client/pending`.

The at-rest claim is unchanged: the database alone yields no key and no
plaintext.

**A pending create does not make the scope writable for other rows.**
Today `memory_remember` treats a scope as shared when any row exists in
it, and a pending create row would satisfy that. It changes to require at
least one row in the scope that is **not pending**. A row stops being
pending only when the user's device acked it (the fold applied it) or
when the device pushed it. Held rows stay pending, so a held scope stays
closed. The check is on the `pending` flag, not `origin`: the in-memory
store leaves `origin` unset on pushed rows and the Neon re-push upsert
never rewrites `origin`, so an acked connector row keeps `origin =
'connector'` under its vault id forever; `pending` is the one column both
stores maintain the same way. `project_update` keeps treating the pending
create as its base (ADR 0040 Decision 2), so the app can keep refining the
one document before the first sync, and the Log roll of ADR 0045 may add a
pending archive row beside it; neither opens the scope to
`memory_remember`. When the check refuses, the message says the scope has
no memory from the vault yet and to add or re-share one in NorthKeep; it
does not say the scope is unshared, because it may well be shared.

## Decision 3: Fail-closed preconditions, checked in this order

Nothing is stored unless every check passes.

1. **Slug.** `PROJECT_SLUG_PATTERN` before any storage read. A scope that
   merely starts with `project:` is not a project (ADR 0040 Decision 4).
2. **Tombstone.** If the account has an unshare tombstone for this scope,
   refuse with the ADR 0038 message: "This scope was unshared. Re-share it
   deliberately if you want it back." This check does not honour
   `CONNECTOR_TOMBSTONE_ENFORCE`; it is unconditional. Unshare is the
   revoke, and a connected app must never be able to undo a revoke by
   creating the scope again. Only a deliberate re-share from NorthKeep
   reopens the scope. Three things make that true without depending on an
   env flag:
   - **`/client/pending` never delivers a row in a tombstoned scope.** The
     route reads the pending rows first and the tombstones second, then
     withholds and deletes every pending row whose scope has a tombstone,
     with no timestamp comparison. The fourth review proved a timestamp
     guard can never fire: unshare deletes every row in the scope, so the
     only pending row that can exist in a tombstoned scope is one written
     after the tombstone. Purging all of them is safe for the same reason.
     Reading pending rows before tombstones is what protects a row written
     after a deliberate re-share: the re-share deletes the tombstone
     before the app can write, so a tombstone read that follows the
     pending read cannot name that row's scope. A `project_update` or
     `project_create` that lost the race to an unshare therefore leaves
     nothing deliverable; the revoke wins even when the write landed after
     the delete. The two reads are **sequential awaits**, pending rows
     first, then tombstones, never `Promise.all`: the fifth review showed
     the reversed order destroys a row written after a deliberate
     re-share, and that the existing route reads with `Promise.all`,
     which on Neon is two independent statements with no order. The test
     for this interleaves a real re-share and app write between the two
     reads through a storage hook; a test that only runs the sequence
     end to end passes with either order and proves nothing.
   - **A tombstoned scope is invisible and unwritable to the app.**
     `visibleEntries()` excludes rows whose scope has a tombstone, so
     `project_get`, `project_list`, `memory_retrieve`, `memory_list`,
     `search` and `fetch` do not show a row that landed after an unshare;
     and `project_update` checks the tombstone before writing, the same
     way `project_create` does. Until a device sync purges it, the stored
     row is one encrypted, unreachable row.
   - **Clear-on-reshare runs on every accepted push.** Today the
     `PUT /client/entries` route in `create-server.ts` calls
     `replaceScopesAcceptingReshare` only when `CONNECTOR_TOMBSTONE_ENFORCE`
     is on, and plain `replaceScopes` otherwise, so with the flag off a
     later `shared_at` never clears the tombstone. The route changes to
     always try the accepting path; with the flag off, a
     `TombstoneConflictError` falls back to `replaceScopes` (the push is
     accepted as today and the tombstone stays); any other error from the
     accepting path is a 503 in both flag states, as the flag-on branch
     already returns. Acceptance semantics are unchanged in both flag
     states; only the clear becomes unconditional.
   - **What still depends on the flag is pre-existing and stated.** With
     the flag off, a stale device that pushes an old `shared_at` into a
     tombstoned scope is accepted (ADR 0038 addendum behaviour). Production
     has run with the flag on since 2026-08-26. This ADR does not widen
     that window and does not claim to close it.
3. **No existing document.** If any row in the scope in
   `storage.listEntries` (every stored row, including pending rows and
   rows with a queued forget) is a working document, refuse: "Project
   already exists; use project_update." Not `visibleEntries()`: that
   helper hides forget-queued rows. Rows of other types may exist (the
   fifth review reached a scope holding only pending Log archives after
   the app forgot its own document; without this rule `project_create`
   said "use project_update" and `project_update` said "no live project
   document", and the slug was dead from the hosted side). A create into
   such a scope adds the document beside those rows; the fold's group
   rule (Decision 4) then applies them together.
4. **One row per scope, without a lock.** Two creates for the same slug
   in flight at once must yield exactly one row. The create row's id is
   deterministic: `conn_create_` plus the first 32 hex characters of
   sha256 of the scope. Both stores upsert on `(account, entry id)`, so
   concurrent creates collapse into one row (both are app-authored
   skeletons; the later body wins) with no new storage method and no
   lock, which the Neon serverless driver could not hold across the
   app-side decrypt anyway. A later `project_update` overwrites that same
   pending row in place (ADR 0040 Decision 2); once acked, the row lives
   under its vault id and a new create is refused by check 3.
5. **Cap.** `MAX_SHARED_ENTRIES`, counting the one row this call adds.
6. **Size.** The serialized document must pass `assertProjectDocSize`
   (16384 characters). Over cap is refused verbatim, never truncated.

Check-then-write without a cross-request transaction, as every connector
tool is. A create racing an unshare of the same scope within one request
window is bounded the same way ADR 0040 bounds `project_update`, and the
tombstone check narrows it further: the delete writes the tombstone, so
the race window is between the tombstone read and the row insert.

## Decision 4: The fold marks the scope shared, and that is the consent change

The second review proved that a shared mark is never "just the
document": the next push sends every live memory in the scope. The third
review proved that no provenance field on a memory can carry consent: the
`source` string is caller-set and inherited through every local edit and
rescope. So the rule uses the one fact a local edit cannot manufacture:
whether the scope was empty on this device when the document arrived.

`downSyncConnector` groups the pending rows by scope. For a slug-valid
project scope that is **not** marked shared locally, before any dedupe or
apply:

- **The scope has no live local entries, and the group contains exactly
  one `working` document.** Apply every row in the group with
  `vault.remember` (the document, plus any `episodic` Log archives the
  ADR 0045 roll produced while the app refined the document before the
  first sync) and then `vault.setScopeShared(scope, true)`. Nothing else
  is in the scope, so the push that follows sends exactly the rows the app
  wrote. This is the hosted create landing. Decision 2 guarantees that no
  `memory_remember` row can be in this group, because the scope had no
  non-pending row.
- **Anything else**: the scope has any live local entry, or the group has
  no working document or more than one. Every pending row in that group
  is **held**: not applied, not acked, not deduped. They stay pending on
  the server and are offered again on every sync. `DownSyncResult` gains
  `held` and `held_scopes`, and each sync surface says: "A connected app
  wrote to project <slug>, which is private on this device. Share
  project:<slug> in NorthKeep to accept it." Once the user shares the
  scope, the next sync applies the rows under ADR 0040 Decision 7, exactly
  as any hosted write to a shared project.

The order inside the fold is pinned: apply the rows, set the mark, save
the vault, and only then ack. The mark travels in the same save that
precedes the ack, so a crash between save and ack leaves the row
re-deliverable (the dedupe makes the retry a no-op) with the mark already
in place, and a crash before save leaves nothing applied and nothing
acked. Ack before mark would recreate the non-healing fork under Residual
on a new client.

When a held group is later accepted because the user shared the scope,
the rows are applied under ADR 0040 Decision 7, and that means the app's
document supersedes the live local one; the local document stays in
history. The sync surface's hold message says so: "Sharing it lets the
app's document replace the one on this device; the current one stays in
history."

"Empty" means `vault.list({scope})` returns nothing: no live entry.
Superseded and forgotten rows may remain in the scope's history; they are
never pushed, because `pushSharedScopes` lists live entries only. That
dependency is named here so a future change to what push sends re-opens
this decision.

Rows in scopes that are already marked shared locally, and rows in
non-project scopes, take the existing M14 path unchanged.

Why this is the whole consent story: the mark is made only into an empty
scope, where nothing private exists to ride along, and every other case is
resolved not by the fold but by the user's own share, which is the ADR
0038 consent act. The collision case (hosted create meets a local
same-slug project) is held. A scope the user emptied by unsharing on this
device still holds its entries, so it is not empty and is held. The
old-client residual (a create folded without the mark) does not self-heal:
the scope is no longer empty, so the next hosted rows are held until the
user shares by hand; that is stated under Residual.

Why the mark is made without a dialog:

- **The project was created in the connected app.** The user, in that
  app, asked for it. The document's entire content came from that app.
  Marking the scope shared discloses nothing that the app did not just
  write.
- **A project that is not shared cannot be tracked across agents**, which
  is the only reason to create one from a connected app. Refusing the mark
  produces the silent fork described above, which is worse than either
  outcome the user could have chosen.
- **The mark is visible and reversible.** The Projects page and
  `project_get` already show `shared: true`. Unshare deletes the server
  rows and tombstones the scope; the vault keeps the document.
- **The forward-looking cost is already governed.** The installed contract
  forbids secrets, credentials, PHI, and personal identifying information
  in any project document, on every surface, shared or not. A local
  agent writing into a project it did not create is bound by the same
  line.

What this does not do: it does not mark any scope for a non-working row
or a non-project scope, it does not re-share a tombstoned scope (Decision
3 keeps such rows from ever being delivered), it never applies any hosted
row into a non-empty unshared scope, and it does not change how a human
shares from NorthKeep.

**Invariant #1 amendment.** CLAUDE.md invariant #1 says sharing is
"opt-in, loudly confirmed, badge-visible, and reversible". Jay decided on
2026-09-19 that this is the one named exception to "loudly confirmed",
stated exactly: an unshared project scope with no live entry on this
device, when a connected app's rows for it arrive and exactly one of them
is the project document, is marked Shared without a dialog and receives
exactly those rows. From then on it is an ordinary shared scope:
everything later written into it is pushed to the connector, it is
badge-visible, and unshare revokes it. Any other rows a connected app
sends to an unshared project scope are held, unapplied, until the user
shares the scope. CLAUDE.md and AGENTS.md carry that wording.

The fold sets `shared_at` to the fold time. That is strictly after any
tombstone that could exist, but Decision 3 guarantees no tombstone exists
when a create is accepted, so the mark never clears one.

## Decision 5: Every sync surface runs the fold whenever a connector is configured, then re-reads the shared list

Today the desktop `POST /api/share/sync` (`apps/web/src/api.ts`), CLI
`share sync` (`packages/cli/src/shareCmd.ts`) and mobile
`runConnectorSyncNow` (`apps/mobile/src/lib/connect-flow.ts`) all return
"nothing shared" before `downSyncConnector` runs. A user whose first
project is created in a connected app therefore never receives it on any
surface. All three change to: if a connector server is configured, run the
fold; then read the shared list fresh; if it is empty after the fold, skip
the push and report that nothing is shared (and report any held rows);
otherwise push exactly that list. The desktop and mobile already re-read
after the fold; the CLI reads once before and must re-read. Mobile does
re-push to the connector in the same run today; that is kept.

"A connector is configured" is not enough on its own: mobile always has
the default hosted URL, and a fold call creates a server account row and,
on a gated server, returns 402. So the fold from an empty shared list runs
only on a device that has started a pairing. Every `startPairing` success
writes `paired_at` into that device's connector settings: `connector.json`
for the desktop and CLI (which exists at that moment even when no vault
does, as the fourth review showed), and the mobile connector settings
store. The marker is device-local and is not vault state, so it needs no
open vault, no schema change, and no export field. `loadConnectorConfig`
and `saveConnectorConfig` carry `paired_at` (today the loader returns only
`server` and the saver drops every other key). Changing the connector
server to a different URL clears `paired_at`, because a pairing belongs to
one server; setting the same URL again keeps it. A device that never
paired makes no new network call and sees the same "nothing shared"
message as today. A paired device already has its server account row from
`/pair/start`, so the fold creates nothing new there. A second device that
did not pair itself does not fold from an empty list until it pairs or
until something is shared; that is recorded under Residual. The sync stays
user-initiated on every surface; nothing here runs automatically.

Until the re-push runs, the server holds the acked row under its remapped
vault id and no other row for that scope. `project_get` and
`project_update` on the hosted side keep working against it. Nothing is
lost in the gap.

## Decision 6: Title parity is out of scope

The local server accepts `title` on `project_update` (2c59469). The hosted
document format is the byte-identical `project-doc.ts` copy, so if the
hosted copy already parses the title line, hosted `project_create` passes
it through; if it does not, the hosted tool omits `title` from its schema
and the local tool keeps it. Hosted title support and revision parity were
parked in the NorthKeep project record on 2026-09-13 and stay parked. The
implementation states which case applied.

## Decision 7: The contract changes one sentence

ADR 0042 pinned the hosted line as: "On a hosted surface, use the
NorthKeep connector project tools if they are present; never create a
project there." It becomes:

"Create a project with project_create only when the user asks for one;
never create one to hold notes that belong in an existing project or in a
memory."

The line applies on every surface, so the hosted qualifier is dropped. P6
(graceful degradation) is unchanged and stays verbatim. The composed
contract stays under 2048 bytes with no em dash; the existing test
enforces both. `northkeep contract install` rewrites the installed files
(Claude Code rule, Codex `AGENTS.md`, Cursor rule) with the new text; the
ownership markers make that idempotent.

## Decision 8: Gate statement

`project_create` is an MCP tool behind the connector's existing OAuth
bearer on the hosted server and behind the stdio process on the local
server. No new HTTP route, no new env var, no new default-open check.

## What this deliberately does not build

- No approval queue for connected-app creations in the NorthKeep UI. The
  Shared badge and unshare are the controls.
- No `log_entry` or `decision` on create.
- No change to `memory_remember`: it still cannot invent a scope.
- No ChatGPT-specific surface; ChatGPT reaches projects through
  `search` and `fetch` as before.
- No mobile project tools.
- No schema bump, no storage method, no migration.

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by |
|---|---|
| A connected app can create a project only in a slug-valid, empty, never-tombstoned scope | Decision 3 checks, in order, before any write; tests for each refusal store nothing |
| Creation never undoes an unshare | Unconditional tombstone check; test: unshare, then create, refused, no row |
| Every stored create is ciphertext under the account DEK | Same `encryptRow` call as `project_update`; test asserts `nkc1:` prefix and that plaintext phrases are absent from the dump |
| After share sync, the created project is one live working document in the vault, in a scope marked shared, and the re-push includes it, including when nothing was shared before | Fold test: remember, mark, `sharedScopes()` contains the scope; CLI and desktop tests starting from an empty shared list assert the fold ran and the push named the new scope |
| The fold marks only project scopes that received a working row, and only when not already marked | Fold tests: non-project pending row and a `semantic` row in a project scope leave `sharedScopes()` unchanged; an already-shared scope keeps its `shared_at` |
| A deliberate re-share clears a tombstone regardless of the enforcement flag | Storage test with the flag unset: push with later `shared_at` leaves no tombstone; push with earlier `shared_at` keeps it |
| A scope with a forget-queued row is not empty | Connector test: queue a forget, create refused, no row added |
| The fold marks only an empty scope receiving exactly one working document (plus its archives), and holds every row for any other unshared project scope | Fold tests: empty scope plus one working row marks; empty scope plus one working and one episodic archive marks and applies both; local episodic with a canary (any `source`, including one forged as `connector:`) holds, canary absent from the following push body, nothing applied or acked; a group with two working rows into an empty scope holds all; a lone episodic row into an empty scope holds; an unshared scope emptied by a local unshare still holds |
| A pending create does not let the app write other rows into the scope | Connector tests, in-memory and against the Neon SQL shape: seed a pending create, `memory_remember` refused; after the row is acked, accepted; after a re-push that leaves `origin` as the store leaves it, still accepted |
| A hosted write that lost the race to an unshare is never delivered, never shown, never updated, and the fold never re-shares that scope | Route test with enforcement on: shared scope, unshare, late `putEntry` in that scope; `project_get` and `memory_list` omit it, `project_update` refuses; `/client/pending` returns nothing for it and the row is gone; a fold and push afterwards leave the tombstone in place |
| The purge reads pending rows before tombstones, sequentially | Route test with a storage hook that performs a real re-share and app write between the two reads: the row is delivered, not purged; the same hook with the reads reversed must fail |
| Two concurrent creates yield one row | In-memory test under `Promise.all` asserts one row with the deterministic id; the Neon upsert is the existing `putEntry` |
| The fold marks before it acks | Fold test with a fault injected after save and before ack: on retry the mark is present and the row dedupes |
| A server change clears `paired_at` | Config test: set server B after pairing with A, marker gone; set A again, marker kept |
| The `/client/pending` purge never deletes a row written after a re-share | Route test: tombstone, re-share clears it, app writes, pending delivers it |
| A device that never paired makes no network call from an empty shared list | Per-surface test: no `paired_at`, zero shared scopes, sync reports nothing shared with no fetch; with `paired_at`, the fold runs |
| A pending row in a tombstoned scope is never delivered | Route test: unshare after a hosted write that landed late; `/client/pending` omits it and the row is gone; fold sees nothing |
| A later `shared_at` clears a tombstone with the flag off, and an earlier one does not | Route tests in both flag states |
| Mobile, desktop and CLI each run the fold from an empty shared list | One test per surface starting with no shared scopes |
| A typo in `project_update`'s slug still cannot create a project | Existing M14 test "refuses unshared, never-shared" stays green |
| Unshare deletes a not-yet-delivered create | Existing `deleteScope` path; test reused from M14 |
| Local `project_create` refuses when a live document exists | Core `writeProject` with `expected_revision: null` throws `stale_project` on an existing head; the tool maps it to "already exists" |

## Residual (documented, accepted)

- **A client that predates this ADR folds a hosted create without the
  mark.** The document lands in the vault unshared; the scope is then not
  empty, so every later hosted row for it is held until the user shares
  the scope by hand. Nothing is deleted, nothing self-heals.
- **Multi-device lag.** A phone can write private memories into a project
  scope while the Mac, not yet having pulled that vault version, sees the
  scope as empty and marks it. The mark replicates, and the phone's next
  share sync pushes those memories. This is the same window as any
  whole-vault last-writer-wins race (KNOWN-LIMITS M13) and is recorded, not
  closed.
- **A device that did not pair does not fold from an empty shared list.**
  The `paired_at` marker is per device. The device the user paired on
  receives the hosted create; a second device receives it through vault
  sync afterwards, or folds itself once it pairs or once any scope is
  shared.
- **A held row identical to a live local entry never drains by dedupe.**
  Today's fold would ack it as a duplicate; under the hold-before-dedupe
  order it stays pending until the user shares. One encrypted row.
- **A shared scope with no live vault entry refuses app writes.** If the
  user forgets every memory in a shared scope and re-pushes, the scope's
  only rows are the app's own pending ones; Decision 2 then refuses
  `memory_remember` until the user adds a memory or re-shares. The message
  says that; it does not claim the scope is unshared.
- **Accepting a held create by sharing replaces this device's document.**
  The local document stays in history (Decision 4 says so in the hold
  message).
- **After unshare plus local delete, the only reopen is re-sharing an
  empty scope,** which the desktop share picker cannot offer today (it
  lists scopes that hold live entries); the CLI can. Recorded; a picker
  that accepts a typed scope is a separate change.
- **A sub-second window remains** where an unshare followed by a re-share
  between the two pending-route reads delivers a row the unshare deleted.
  The user re-shared the scope; recorded, not chased.
- **Scale.** One sync can mark as many project scopes as the app created,
  bounded only by the entry cap, and an app can pre-create slugs the user
  never used; a later local create of that slug is refused as
  `stale_project` and local notes into it are pushed. This is the decided
  "mark on arrival, badge only" trade at scale.
- **With the flag off, a purged late write is silently lost** while
  `project_get` still shows a scope a stale device reopened. Pre-existing
  flag-off residual, narrowed to production having the flag on.
- **A held row is offered on every sync until the user shares or the app
  forgets it.** It is one encrypted row on the server, subject to the same
  cap and unshare as every other row. There is no server-side expiry.
- **With `CONNECTOR_TOMBSTONE_ENFORCE` off, a stale device's push can
  reopen an unshared scope.** Pre-existing ADR 0038 behaviour; production
  has the flag on. Not widened by this ADR.
- **Deleting a project in NorthKeep does not unshare its scope.** After a
  local delete the next push empties the scope server-side, the scope has
  no rows and no tombstone, and a connected app may create it again. That
  is a create into a scope the user left shared, which is consistent with
  "share is write access" (KNOWN-LIMITS M14). Unshare, not delete, is the
  revoke.
- **Stale-base last-writer-wins on hosted updates** is unchanged from
  ADR 0040; the hosted tools remain revision-free.

## Adversarial review

### 2026-09-19 pre-implementation review (fresh-eyes subagent, against code)

Baseline: the M14 connector tests, the sync fold tests, and the contract
tests were green (38/38) before the attack. Every vault the attacker
opened was under a temporary NORTHKEEP_HOME; no repo file was modified,
nothing was pushed or deployed. Attack scripts and outputs live outside the
repo. Verdict: **NOT CLEARED**.

**Kill shot.** Desktop `POST /api/share/sync` (`apps/web/src/api.ts`) and
CLI `share sync` (`packages/cli/src/shareCmd.ts`) both return "No scopes
are shared yet" before `downSyncConnector` runs. A user whose first
project is created in a connected app has no shared scope, so the fold
never runs on the two surfaces that re-push, and the ADR's headline claim
fails for exactly that user. Executed: CLI run with zero shared scopes
made no network call and folded nothing. Resolution required in Decision
5: remove the zero-scope early return whenever a connector is configured,
and add the empty-shared-list case to the claims table and tests.

**Flesh wounds.**

1. The old-client residual does not self-heal. Executed: a pre-ADR fold
   drains the pending row on ack; a later hosted update meets a live local
   document and takes the supersede branch, which Decision 4 as written
   never marks. The fork is permanent until the user shares by hand.
2. A hosted create arriving after the user created the same slug locally
   supersedes the local document (recoverable in history) and, under
   Decision 4's "no live local document" condition, leaves the scope
   unshared. The ADR took no position.
3. "A deliberate re-share clears the tombstone" is true only when
   `CONNECTOR_TOMBSTONE_ENFORCE` is on. Executed: with the flag off, a push
   with a later `shared_at` returns 200 and the tombstone stays. An
   unconditional "any tombstone exists" create check would then refuse
   forever in a scope the user legitimately re-shared.
4. The emptiness check must read `storage.listEntries`, not
   `visibleEntries`: the helper hides forget-queued rows, so a scope with
   a queued forget would read as empty.
5. CLAUDE.md invariant #1 says sharing is "opt-in, loudly confirmed". The
   ADR makes a mark with no confirmation and does not amend the invariant.

**Scar tissue.** A single hyphen is a valid slug (pre-existing). The
per-field 16384 bound admits inputs the document cap can never accept
(max `what_why` is 16310 with a one-character status). Two concurrent
creates on Neon can plausibly leave two pending rows; the in-memory store
could not reproduce it. `vault.ts` has an unreachable `stale_project`
branch after the `not_found` throw (out of scope).

**Also confirmed by execution:** today's fold calls `vault.remember` and
sets no mark; the CLI reads the shared list once before the fold and a
mark made during the fold is not pushed in the same run; local
`writeProject` with `expected_revision: null` over an existing head throws
`stale_project`; hosted slug attacks (41 chars, uppercase, trailing
newline, underscore, Cyrillic, empty) are rejected at the schema layer;
unshare deletes pending rows and writes a tombstone even for a scope that
was never on the server; the hosted `project-doc.ts` is byte-identical to
core and neither carries a title, so Decision 6 resolves to "omit `title`
from the hosted schema".

**Residual the review could not reach:** the production value of
`CONNECTOR_TOMBSTONE_ENFORCE`; Neon behaviour of the create race; the tool
itself, which does not exist yet.

### Binding amendments, 2026-09-19 (applied to the body above)

1. Decision 5: the desktop and CLI sync run the fold whenever a connector
   is configured and read the shared list after it; the zero-scope early
   return moves after the fold. Closes the kill shot.
2. Decision 4: the mark condition is "any connector-born working row in a
   slug-valid project scope whose scope is not already marked", not "no
   local document". Closes wounds 1 and 2; the collision case is accepted
   and recorded under Residual.
3. Decision 3: the tombstone clear-on-reshare becomes unconditional; only
   the 412 refusal stays behind `CONNECTOR_TOMBSTONE_ENFORCE`. Closes
   wound 3.
4. Decision 3: emptiness is checked on `storage.listEntries`. Closes
   wound 4.
5. Decision 4: invariant #1 gains one named exception, decided by Jay
   ("Mark on arrival, badge only", 2026-09-19). Closes wound 5.
6. Decision 6 resolves to: hosted `project_create` has no `title`
   argument; the local tool keeps it.
7. Scar tissue accepted and recorded: single-hyphen slug (pre-existing);
   per-field bound looser than the document cap (the size check runs
   after and the message names the cap); a Neon race between two creates
   can leave two pending rows, reconciled by the fold's supersession and
   the next push.

A second review of the amended ADR follows before any code.

### 2026-09-19 second pre-implementation review (fresh-eyes subagent, against code)

Baseline 38/38 green; attacks ran under a temporary NORTHKEEP_HOME with
the in-memory store, real fold, real Vault, real connector routes and a
real MCP `project_update`; nothing in the repo modified. Verdict:
**NOT CLEARED**.

**Kill shot.** The Decision 4 mark turned a hosted create into a
whole-scope push. Executed: a local, never-shared `project:northkeep`
holding a private episodic memory with a canary; a hosted working row
arrives; fold, mark, real `pushSharedScopes`: the canary left in the PUT
body. Same with only a local `semantic` memory in an otherwise empty
`project:plan`. "Discloses nothing that the app did not just write" is
false whenever the scope already holds any local memory, and the contract
itself tells local agents to put detail in episodic memories in the
project scope, so that is the normal shape of a local project. The
invariant #1 wording ("its entire content came from that app") was
untrue in these cases.

**Flesh wounds.**

1. With enforcement on, a `project_update` that loses the race to an
   unshare leaves a pending row in a tombstoned scope; `/client/pending`
   has no tombstone filter; the fold delivers it, the mark and push then
   clear the tombstone. Losing the race undid the revoke. With
   enforcement off, a stale second device's push with an old `shared_at`
   returns 200 and reopens the scope outright.
2. Decision 3 named the wrong seam: `replaceScopesAcceptingReshare`
   already clears tombstones; with the flag off the route in
   `create-server.ts` never calls it (and the Neon path clears inside its
   own transaction).
3. Mobile's `runConnectorSyncNow` (`apps/mobile/src/lib/connect-flow.ts`)
   has the same zero-scope early return, and it does re-push to the
   connector; Decision 5 neither fixed nor described it.
4. The invariant #1 text described a narrower rule than Decision 4
   implemented.

**Confirmed by execution:** local create over an existing head throws
`stale_project`; `storage.listEntries` returns a forget-queued row; the
new contract sentence fits (1305 bytes, no em dash); all three unshare
surfaces delete server-side before the local unmark; hosted
`memory_remember` with type `working` into a shared project scope
replaces the document with arbitrary text (pre-existing since M14, out of
scope, recorded).

### Binding amendments after the second review (applied to the body)

1. Decision 4: the mark is made only when the scope's live local entries
   are empty or all connector-born by `source`; otherwise the row is held
   (not applied, not acked) and surfaced, and the user's own share is the
   consent. Closes the kill shot and the collision wound.
2. Decision 3: `/client/pending` filters and purges rows in tombstoned
   scopes; the push route always attempts clear-on-reshare, falling back
   to plain replace only when the flag is off and the push conflicts.
   Closes wounds 1 and 2 as far as the delivery and clear paths go; the
   flag-off acceptance is recorded as pre-existing residual.
3. Decision 5 covers mobile's `runConnectorSyncNow` and corrects the
   description of mobile's re-push. Closes wound 3.
4. Invariant #1 exception rewritten to say what the mechanism does.
   Closes wound 4.
5. Out of scope, recorded: hosted `memory_remember` with type `working`
   into a shared project scope can replace the document (pre-existing).

A third review follows before any code.

### 2026-09-19 third pre-implementation review (fresh-eyes subagent, against code)

Baseline 123 green; attacks under a temporary NORTHKEEP_HOME with the
real Vault, real fold, real routes and the real CLI binary; nothing in the
repo modified. Verdict: **NOT CLEARED**.

**Kill shot.** The `source` classifier does not measure provenance.
Executed: `northkeep remember --source connector:claude.ai` forged the
prefix from the CLI; `memory_edit` (supersession copies `source`) kept a
locally edited memory classified as connector-born; and an ordinary user
flow, unshare `work` then rescope one of its app-written memories into
`project:plan`, made the hosted create mark `project:plan` and push the
revoked memory back with no dialog.

**Flesh wounds.** A pending create satisfied `memory_remember`'s "already
shared" check, so the app could write memories into a scope the user
never shared, and the fold applied and acked those non-working rows into
the private local scope while holding the document. Decision 5 would have
made an un-paired install call `/client/pending`, creating a server
account row and returning 402 on a gated server; on mobile "configured"
was always true because of the default URL. The `/client/pending` purge
was order-sensitive: read tombstones first and a row written right after a
deliberate re-share is deleted. The invariant sentence claimed provenance
where the mechanism checked a prefix. Scar tissue: classification must
run before the content dedupe; flag-off non-conflict errors were
unspecified; flag-off purge turns the stale-reopen residual into silent
loss.

### Binding amendments after the third review (applied to the body)

1. Decision 4: the mark condition is "the scope has no live local entries
   and the group is exactly one working document"; every other row for an
   unshared project scope is held, whatever its type, before dedupe. No
   provenance field is consulted.
2. Decision 2: `memory_remember` requires a vault-origin row in the scope.
3. Decision 3: `/client/pending` reads pending rows before tombstones and
   purges only rows created at or before the tombstone; flag-off
   non-conflict errors return 503.
4. Decision 5: the fold from an empty shared list is gated on the vault
   meta `connector_paired_at`, written on every successful pairing start.
5. Invariant #1 exception rewritten to the empty-scope rule.
6. Residual gains the multi-device lag window and the flag-off purge.

A fourth review follows before any code.

### 2026-09-19 fourth pre-implementation review (fresh-eyes subagent, against code)

Baseline 123 green; 19 attacks executed with the real Vault, fold, routes,
MCP tools and CLI under a temporary NORTHKEEP_HOME; nothing in the repo
modified. Verdict: **NOT CLEARED**.

**Kill shot.** The `/client/pending` timestamp guard could never fire:
unshare deletes every row in the scope, so the only pending row that can
exist in a tombstoned scope is one written after the tombstone, and
`created_at <= unshared_at` never matches it. Executed end to end with
enforcement on: unshare, lost-race hosted write, local delete of the
project, sync: the fold marked the scope, the push cleared the tombstone,
and the server held the app's post-unshare document.

**Flesh wounds.** The `origin='vault'` writability test diverged by
store: pushed rows carry no `origin` in the in-memory store, and the Neon
re-push upsert never rewrites `origin`, so an acked connector row keeps
`origin='connector'` under its vault id forever and a hosted-created
project would refuse `memory_remember` on production indefinitely. Five
`project_update` calls with long log entries rolled the Log into a second
pending row, so "exactly one row" held an ordinary hosted create for a
scope that holds nothing. `connector_paired_at` had no vault to land in:
the real CLI paired with no vault file present and the desktop pair
handler never opens the vault; `export()` does not carry vault meta. The
invariant sentence promised a mark for any empty scope while the
mechanism held an empty scope receiving more than one row.

**Confirmed by execution:** `deleteProject` and rescope-out leave no
live entry and the push carries no canary; scope names are trimmed so a
whitespace variant collapses into the real scope; a held group does not
wedge the ack of other scopes' rows; the hold-before-dedupe order keeps a
duplicate held row pending; vault sync carries the whole file.

### Binding amendments after the fourth review (applied to the body)

1. Decision 3: purge every pending row in a tombstoned scope, no
   timestamp compare; pending read before tombstone read is what protects
   a post-re-share write.
2. Decision 2: writability is "at least one non-pending row in the
   scope", the one column both stores maintain the same way.
3. Decision 4: the empty-scope group may carry the one working document
   plus its ADR 0045 archive rows; all are applied and the scope marked.
   "Empty" is defined as live-empty, with the live-only push dependency
   named.
4. Decision 5: `paired_at` lives in device-local connector settings, not
   vault meta; a device that did not pair is recorded as residual.
5. Invariant #1 exception rewritten to the group rule.
6. Scar tissue accepted and recorded: the duplicate held row never
   drains by dedupe.

A fifth review follows before any code.

### 2026-09-19 fifth pre-implementation review (fresh-eyes subagent, against code)

Baseline 20/20 green on the cited suites; 25 attacks executed with the
real Vault, fold, routes, hosted MCP tools and connector config under a
temporary NORTHKEEP_HOME; nothing in the repo modified. Verdict:
**CLEARED WITH WOUNDS**. No attack moved private local content off the
machine or undid a revoke of user content.

**Wounds, all executed.** The purge was order-dependent and the named
test was blind to the order (reversed reads destroyed a post-re-share
row; the existing route uses `Promise.all`). "Nothing stored" was false: a
lost-race row stayed readable and updatable by the app until a device
synced. Two concurrent creates produced two rows even in the in-memory
store, and Decision 4 then held them for a scope the desktop share picker
cannot offer. A create, log rolls, and an app `memory_forget` of the
document left a scope of pending archives where create said "use
project_update" and update said "no live project document". Decision 2
refused a shared scope whose live entries the user had all forgotten,
with a message that called it unshared. Accepting a held create by
sharing superseded the user's document. The mark and ack order was
unpinned; a crash between them recreated the non-healing fork on a new
client. `paired_at` survived a server change.

**Scar tissue.** The invariant sentence overstated "in every other case"
(already-shared project scopes and non-project scopes are applied);
unshare plus delete leaves a reopen the desktop picker cannot offer; an
unshare-then-re-share between the two reads delivers a deleted row in a
sub-second window; one sync can mark many scopes and an app can
pre-create slugs; `saveConnectorConfig` drops unknown keys.

### Binding amendments after the fifth review (applied to the body)

1. Decision 3: sequential reads, pending first; the test interleaves a
   real re-share between the reads through a storage hook.
2. Decision 3: a tombstoned scope is invisible to every hosted read tool
   and `project_update` checks the tombstone before writing.
3. Decision 3: the create row id is deterministic per scope, so
   concurrent creates collapse by upsert on both stores (an advisory lock
   is not possible on the Neon serverless driver across an app-side
   decrypt).
4. Decision 3: "already exists" means a working row exists; other row
   types do not block a create.
5. Decision 2: the refusal message no longer claims the scope is
   unshared; the emptied-shared-scope case is recorded as residual.
6. Decision 4: the hold message states that sharing lets the app's
   document replace this device's; recorded as residual.
7. Decision 4: apply, mark, save, then ack, pinned, with a fault-injection
   test.
8. Decision 5: `paired_at` is carried by the config reader and writer and
   cleared on a server change.
9. Invariant #1 exception scoped to an unshared project scope.
10. Remaining scar tissue recorded under Residual.

Implementation follows. The post-implementation review verifies each pin
against shipped code, on the in-memory store and, for the Neon
statements, by review of the SQL, and records its result here.

### 2026-09-19 post-implementation review (two fresh-eyes attackers, against shipped code)

Two attackers, each in a detached worktree from the integration tip with
a temporary NORTHKEEP_HOME: one on the network boundary (hosted tools,
routes, local `project_create`, contract), one on the vault side (fold,
config marker, CLI, desktop, mobile). Both verdicts: **CLEARED WITH
WOUNDS**. Every row of the claims table held under execution, including
the real CLI binary against the real in-memory connector server with a
real encrypted create row. No attack moved private content off the
machine, undid a revoke with enforcement on, produced two rows for one
slug, or leaked an existing document through a refusal.

**Wounds, all executed.**

1. Hosted `project_create` and `project_update` accept section headings,
   carriage returns and whitespace-only text in their fields; core's
   `assertProjectText` refuses the same input locally. A hosted create
   with `## Current Status` inside `what_why` lands, is marked Shared,
   and local `project_get` then refuses the project as having duplicate
   sections. The update half has been open since M14; the create is a new
   entry point and the first document in the scope.
2. `memory_remember` does not read tombstones. Reachable only with
   `CONNECTOR_TOMBSTONE_ENFORCE` off (a stale device's push reopens rows
   under a standing tombstone); with it on the state is unreachable. The
   flag-off residual text was also stale: `project_get` now hides such a
   scope.
3. The two `project_create` signatures differ: hosted `next_actions`
   refuses an empty string, local accepts it; hosted drops an unknown
   `title` silently.
4. The fold's hold is bypassed by an untrimmed scope name: a pending
   working row in `' project:plan'` fails `parseProjectSlug`, takes the
   non-project path, and `vault.remember` trims the scope, landing a
   second live working document inside the user's private project. No
   disclosure (no mark, no push), but `project_get` then refuses the
   project. Reachable only from a buggy or hostile server, since the real
   server trims and slug-validates; the fold is the enforcement point and
   must not depend on that.

**Scar tissue recorded.** A `semantic` row arriving with the create into
an empty scope is applied and the scope marked (content is app-authored;
the fold trusts Decision 2). A forged or restored `paired_at` beside a
fresh device secret makes a never-paired device call `/client/pending`
and creates an account row. A queued forget naming a private entry in a
held scope is applied (pre-existing M14 forget path; the server only
holds vault ids for pushed rows). A group with an invalid type string
used to throw mid-fold (pre-existing); the fix round holds or drops such
rows instead. An app
that forgets its own pending create leaves the slug dead on the hosted
side until a device sync drains the forget. The purge leaves a queued
forget for a row that never landed. A forget-queued non-pending row keeps
a scope writable until the next sync.

### Fix round, 2026-09-19

1. Connector: port the six-line `assertProjectText` rule into the hosted
   tools and apply it to every text field of `project_create` and
   `project_update` (headings, carriage returns, leading or trailing
   newline, whitespace-only); hosted `next_actions` treats an empty string
   as omitted, matching local; `memory_remember` refuses a tombstoned
   scope unconditionally. Tests for each.
2. Fold: trim every pending row's scope before grouping, so the project
   rule sees the scope the vault would store; a row whose trimmed scope is
   empty is dropped unacked. A row whose type is not a valid memory type
   never throws: in an unshared project scope it holds its whole group;
   anywhere else it is dropped unapplied and unacked and counted in a new
   `DownSyncResult.skipped`. Tests for the whitespace variants, the blank
   scope, and the mixed-type groups in both kinds of scope.
3. Residual updated: the flag-off line now says `project_get` hides the
   reopened scope; the forged-marker and semantic-with-create cases are
   recorded above.

### 2026-09-19 fresh attack on the fix round

One fresh-eyes attacker against the fixed tip: **CLEARED WITH WOUNDS**.
All three fix-round claims held under execution: a 33-input corpus gave
identical outcomes and messages between the hosted validator and core's
`assertProjectText`; every text refusal ran before any storage read and
left a content-free audit row; the tombstone refusal held for the exact
and every trim-padded scope name; the fold held nine padded spellings of
a private project and applied a padded empty scope under its trimmed
name; the 233 shipped tests passed. Two wounds, fixed directly by the
lead with one test each: hosted `project_update` still refused an empty
`next_actions` that local accepts (schema `min(1)` dropped; empty
clears); `DownSyncResult.skipped` reached no surface (CLI line, desktop
JSON and mobile summary now report it). Scar tissue recorded: rows with a
blank scope or empty content are dropped uncounted and re-sent on every
sync; pads that `trim()` does not strip (U+200B, U+0085, U+180E, U+200E)
land the app's document in a visually identical lookalike scope beside a
private project, unmarked and unpushed, reachable only from a server
that does not trim; zod-layer refusals use the MCP validation wording
rather than core's; `^` under the `m` flag also matches after U+2028 and
U+2029, an over-refusal identical on both sides.
A narrow fresh check of the two lead fixes cleared them with one
cosmetic wound, accepted: the hosted refusal messages name the argument
(`next_actions`) where core names the heading (`Next Actions`); the
accept and refuse behaviour is identical, and the argument name is the
more useful wording for an API caller.

**Status after review: implemented on branch `adr-0050/finish`, pending
Jay's acceptance test (docs/hosted-project-create-acceptance.md), then a
merge to main and the connector deploy on his explicit OK.**
