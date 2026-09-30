# Sync guardrails (design for ADR 0063)

Status: recheck CLEARED 2026-09-30. Built on `g63/connector` and
`g63/client`, integrated on `g63/integrate` (see "Build notes" at the end).
Not pushed or deployed. See "Review history" at the end.
Rules: `~/Claude/Claude Context/RULES.md`, Version 2026-09-29.2.
Base: branch `adr-0063/sync-guardrails` at `7a7780f` ("Connect: show when this
Mac last pushed to Cloud Connect"). Every file:line below is at `7a7780f`; the
build will shift them. Anything inferred rather than read is marked
**unverified**.

## 1. The incident, traced to code

On 2026-09-30 the founder clicked Sync now. Five projects went back 7 to 9
days; three were genuinely newer from the cloud. The chain:

1. Around 2026-09-21 a cloud bot called hosted `project_update`. It merges into
   whatever `selectProjectWorkingDoc` picks and writes a pending row
   (`apps/connector-server/src/mcp.ts:877`, `:915`, `:930-939`). The row
   records no base: nothing says which document it was merged into.
2. The Mac kept saving. Automatic sync (ADR 0044) never pushes to the
   connector (KNOWN-LIMITS, "Cloud Connect's copy updates only when you push",
   added in `7a7780f`). Pushes happen only on share add, Sync now, and
   `northkeep share push|sync` (`packages/cli/src/shareCmd.ts:114`, `:147`,
   `:194`; `apps/web/src/api.ts:952`, `:1047`).
3. When a push did land, the connector kept serving the pending row.
   `selectProjectWorkingDoc` puts any pending working row ahead of every pushed
   one (`mcp.ts:104-118`, pool at `:107`), and a push never deletes a pending
   connector row (`storage.ts:473-478`; `neon-storage.ts:408-431`). Later cloud
   writes merged into the old pending document and overwrote it in place, with
   the same id (`mcp.ts:915`, `:930`).
4. Sync now ran `downSyncConnector`. For each pending working row in a shared
   project scope it calls `vault.editMemory(live.id, { content })` on the last
   live working entry, with no check of which is newer
   (`packages/sync/src/connector-client.ts:366-374`). Then it saves and acks
   (`:409-418`), and the re-push makes the connector match the rolled-back vault.
5. Separately, the vault sync server had diverged (local v639, server v641).
   `northkeep sync pull` installs the server copy whole and keeps the old file
   as `vault.nkv.bak` (`packages/sync/src/client.ts:472`), with no merge and no
   report of what drops out (`packages/cli/src/syncCmd.ts:102-110`).

The root cause is a missing fact, not a missing check. A cloud write does not
record which document it started from, so no surface can tell a fast-forward
from a rollback. D1 and D2 add that fact for every write from now on. A row
written before this ADR carries no such fact, and nothing on the connector can
recover it (section 6), so such a row is always the user's decision. D3, D4
and D6 make the remaining replace paths visible and reversible. D5 shrinks the
window in which the two copies drift.

## 2. The data shape

Two new plaintext columns on `shared_entries` and one new table. No other
source of ordering exists: `created_at` is not read by any rule in this ADR.

**`base_revision`** on a pending connector row, with three distinct values:

| Value | Meaning | Written by |
|---|---|---|
| a vault entry id | the pushed head this chain of cloud edits started from | hosted `project_update` |
| the literal `new` | created on the connector, no base exists | hosted `project_create` (`mcp.ts:753-765`) |
| SQL `NULL` / JSON absent | **legacy**: written by a connector that predates this ADR | nothing; only old rows have it |

The sentinel keeps "created on the connector" apart from "legacy". Adding the
column with `ADD COLUMN IF NOT EXISTS base_revision text` gives every existing
row `NULL`, so legacy is exactly the set of rows nobody wrote a base for.
Vault entry ids are UUIDs, so `new` can never collide with one. The in-memory
`SharedEntry` (`storage.ts:65-86`) carries the same three states as
`string | 'new' | undefined`.

- A **revision** is the entry id of a live project head. Locally that is
  `getProjectView(...).revision`, the id of the single live working entry
  (`packages/core/src/project-handoff.ts:280-293`). A pushed connector row's
  `entryId` is that same vault id (`connector-client.ts:159-165`), so the
  pushed working row of a project carries the local revision it was pushed at.
- A pending row born on the connector gets a fresh `conn_<uuid>` id
  (`mcp.ts:930`). After the desktop applies it, `ackEntry` renames the row to
  the new local head id and clears `pending` (`storage.ts:576-591`). So the two
  id spaces meet exactly at ack, and a non-sentinel `base_revision` always
  names a vault id.

**`write_seq bigint`** on every row: the value of the scope's counter at the
write that last touched the row. It orders rows. It replaces the `createdAt`
tie-break in `selectProjectWorkingDoc` (`mcp.ts:100-117`), because the two
stores stamp `createdAt` differently: Neon `putEntry` overwrites it on every
upsert (`neon-storage.ts:373-382`), a push keeps Neon's first-insert time
(`neon-storage.ts:400-406`), and the in-memory store re-stamps on every push
(`create-server.ts:679`, `storage.ts:469`). The first review showed the two
stores choosing different heads after an ack (A3).

**`scope_seq (account_hash, scope, seq bigint)`**: one counter per scope that
only goes up. Every connector write that touches a scope increments it in the
same statement or transaction: a push (once per pushed scope), a cloud write,
an ack, a discard, and the drain of a forget. It never goes down, including
when a push empties a scope, so a compare-and-swap on it cannot be fooled by
rows reappearing (an ABA). The in-memory store keeps the same counter in a
`Map`, so both stores give identical answers; the storage tests run both.

- Storage: three idempotent single statements in the schema array
  (`neon-storage.ts:30-90`, ADR 0010): two `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` and one `CREATE TABLE IF NOT EXISTS scope_seq`. Entry ids and scope
  names are already visible to the connector under invariant #2. The counter
  discloses how many writes a scope has had, which the audit log already
  records.
- `/client/pending?v=2` returns `base_revision` (id, `new`, or absent) and a
  `stale` flag per entry (D2) (`create-server.ts:829-849`).

## 3. Decisions

### D1. Down-sync applies a cloud document only as a fast-forward

**Rule.** For each pending `working` row in a project scope, with `H` the local
head from `getProjectView` (not the last item of `list()`):

| Row | Local state | Action |
|---|---|---|
| current (not stale, base recorded) | content identical to `H.content` | ack against `H.id` as a dedupe (no vault write) |
| stale or legacy | content identical to `H.content` | discard the row by id (`/client/discard`), no vault write |
| `stale: true` | any | **conflict** |
| base absent (legacy) | any | **conflict**, always |
| base equal to `H.id`, not stale | one live head | apply with the guarded project write (below), ack |
| base `new`, not stale | no live working entry | create (today's path) |
| anything else | | **conflict**: not applied, not acked |
| any | `getProjectView` throws `project_conflict` (several live docs) | conflict |

Rows are matched top to bottom. Neither dedupe row writes to the vault. Only a
current row's dedupe acks: an ack renames the row to `H.id` with a new, higher
`write_seq`, which makes `H` the connector's `P` (D2). For a stale or legacy
row, `H` may be behind the connector's head, so an ack would move the head
backward through the ack path, the A4 regression by another route. Those rows
are discarded by id instead, which bumps `scope_seq` and leaves `P` alone.
Under `additiveOnly` (the phone) neither dedupe row runs; the row is held.

**Legacy rows are never applied automatically.** No client, desktop, CLI or
phone, applies a row with no recorded base. It is held for the user with the
three actions below, including when the scope has no local document at all
(which today would take the create path). The ADR 0050 fold for an empty
unshared scope (`connector-client.ts:346`) also requires base `new`; a legacy
row there is held. No path infers a base from a timestamp, an id, or the
order rows arrive in: the only bases are the ones a post-ADR connector wrote.

The apply is a revision-bound write: supersede `H` only if it is still the live
head, the same guard `updateProject` uses (`vault.ts:919`, `:936`), so a local
save that lands between the check and the write refuses rather than being
overwritten. The dedupe at `connector-client.ts:358` narrows to the head, so an
ack never lands on a superseded id.

Non-working rows (`memory_remember`, Log archives) stay additive and unchanged.
A Log archive that rode in with a conflicted document still applies; it only
adds older Log entries as an episodic memory (accepted residual).

**Held conflicts reuse the ADR 0050 hold.** A conflicted row is left pending on
the connector, exactly like a held unshared scope (`connector-client.ts:351-352`).
Nothing new is stored on the device: every down-sync re-derives the conflict set
from `/client/pending`, which makes the step idempotent across crashes and
devices. `DownSyncResult` gains
`conflicts: { scope, server_id, base_revision, local_revision, reason }[]`,
where `reason` is `moved`, `stale`, `legacy` or `several_heads`.

**Resolving.** The Mac app shows a conflict on the project page and on the Cloud
screen with three actions. The CLI gets `northkeep share conflicts [--show
<slug>]` and `northkeep share resolve <slug> --take-theirs|--keep-mine`.

- *View both*: the local head and the cloud text side by side (read only). When
  the cloud text equals a superseded local revision (the crash-after-save case,
  first review A6), it says "This cloud version is already in your history".
- *Take theirs*: a revision-bound write of the cloud text over the head the user
  was shown, then ack. Refuses `stale_project` if the head moved. The local
  document stays in history.
- *Keep mine* (founder decision, 2026-09-30): first save the cloud text as an
  `episodic` memory in the project scope, titled "Cloud version not kept,
  <date>", with `metadata.connector.discarded = <server_id>`. Then save the
  vault, then `POST /client/discard { server_ids }`, which deletes exactly
  those pending rows by id and bumps `scope_seq`, then push. It is a non-working
  memory on purpose: a second working entry would make `getProjectView` throw
  `project_conflict`. A retry after a crash finds the memory by its
  `discarded` metadata and does not write a second one. The memory reaches the
  cloud apps with the next push, because the scope is shared.

**Phone** (founder decision, 2026-09-30). The phone applies only additions
until it has its own preview screen. `apps/mobile/src/lib/vault-session.tsx:1374`
calls `downSyncConnector`; it passes a new `additiveOnly: true`. With it:
new memories and base-`new` projects with no local document apply; every
fast-forward, replace and conflict is held with "Review on your Mac"; and
connector forgets are neither applied nor acked. Today every forget is acked
regardless (`connector-client.ts:396-406`), which would drain the queue, so the
phone must skip the ack or the Mac never sees the forget. The phone has no
project tools (KNOWN-LIMITS, M14 section) and never re-pushes to the connector
after a down-sync (`vault-session.tsx:1381` pushes only to the sync server),
which this ADR keeps. This needs a phone build.

**Failure prevented.** The incident: a document written against an old base
replacing a newer local head, including rows written before this ADR (first
review A2).

### D2. The connector serves the newest document and refuses stale writes

**Ordering rule, per project scope.** Let `P` be the pushed head: the
non-pending `working` row with the highest `write_seq`. A push stamps every row
it upserts in a scope with that scope's new counter value, and an ack stamps
the renamed row with a new value, so after an ack the acked row outranks the
old pushed row on both stores. Two non-pending working rows with the same
`write_seq` came from one push of a vault with several live heads; hosted
`project_get` then refuses with `project_conflict`, the local wording, rather
than pick one.

A pending working row `c` is **current** when `c.base_revision === P.entryId`,
or when `P` does not exist and `c.base_revision === 'new'`. Then:

1. If a current pending row exists, it is the head.
2. Otherwise `P` is the head.
3. A pending row that is not current is **stale**, and so is every legacy row.
   It is never served by `project_get` or `project_list`, and never used as a
   merge base. It is still delivered on `/client/pending?v=2` with
   `stale: true`, so every device holds it, including a phone that is behind on
   vault sync and whose own head still equals the stale row's base (first
   review note).

No rule reads `created_at`. `selectProjectWorkingDoc` loses its `createdAt`
comparison.

**Revisions on the hosted tools.** Today hosted `project_get` returns bare
Markdown (`mcp.ts:657-660`) and hosted `project_update` takes no
`expected_revision` (schema at `mcp.ts:796-813`). Hosted `project_get` adds the
head's revision (in `structuredContent` and one trailing line of text).
`project_update` **requires** `expected_revision` (founder decision,
2026-09-30), as the local tools do (`vault.ts:907`). Missing, it refuses with
"Nothing was saved: call project_get first and pass its revision as
expected_revision." Not the head's id, it refuses with the local
`stale_project` wording ("Project changed after it was read.") and returns the
current document and revision.

**Every cloud write gets a new revision, atomically.** Today an update over a
pending head rewrites the same row id (`mcp.ts:915`, `:930`), so two sessions
that both read it would share one revision. Instead each update writes a new
`conn_<uuid>` row and deletes exactly the one pending row it replaced. The new
row's `base_revision` is `P.entryId` for an update over `P`, and the replaced
row's base for an update over a current pending row.

The refusal must hold under concurrency, and Neon's `sql.transaction` is
non-interactive, so the check lives in SQL, over plaintext columns only (the
`type` column is `''` for encrypted rows). The tool first ensures the scope's counter row
exists (`INSERT ... ON CONFLICT DO NOTHING`), reads it as `S` before it reads
the rows, checks `expected_revision` in code for the early
refusal, then runs one statement with data-modifying CTEs:

```sql
WITH cas AS (
  UPDATE scope_seq SET seq = seq + 1
  WHERE account_hash = $a AND scope = $s AND seq = $S
  RETURNING seq),
ins AS (
  INSERT INTO shared_entries (..., base_revision, write_seq)
  SELECT ..., $base, cas.seq FROM cas
  RETURNING entry_id),
del AS (
  DELETE FROM shared_entries
  WHERE account_hash = $a AND entry_id = $replaced_id AND pending
    AND EXISTS (SELECT 1 FROM ins))
SELECT entry_id FROM ins
```

An empty result is `stale_project`. The swap serializes on the counter row, so
two updates with the same `expected_revision` cannot both succeed: the second
finds `seq` moved and inserts nothing. The delete names one id, never a
predicate, so held stale rows are never removed by a write. An update over `P`
has no `$replaced_id` and the `del` step deletes nothing. The archive row of
ADR 0045 joins the same statement as a second guarded insert. The in-memory
store does the same compare-and-swap synchronously.

An ack for a row that was replaced in the meantime finds no row and does
nothing (`storage.ts:587`). The replacement then fails D1's base check on the
next sync and is held. That is the safe outcome for a race of seconds.

**Residual.** `memory_list`, `memory_retrieve`, `search` and `fetch` list rows,
not a head, so they still show a stale pending working row next to the pushed
one. Hiding it there too is cheap. Fold it into the build or state it in
KNOWN-LIMITS; the recheck decides.

**Failure prevented.** Cloud bots reading, and building on, a document the Mac
has already replaced (incident step 3), and two cloud sessions overwriting each
other.

### D3. Sync now previews destructive changes and applies only on confirm

**Rule.** The down-sync splits into `planDownSync` (fetch and classify, no vault
write) and `applyDownSync(plan, approved)`. The plan lists added memories
(counts by scope), project documents that would be replaced (fast-forwards
under D1, by project name), memories that would be forgotten (count, scope and
the first line of each), conflicts (by name and reason), held scopes (ADR
0050), and projects that would arrive from an app. A plan with any replace or
forget needs confirmation. A purely additive plan applies without a prompt, as
today.

`applyDownSync` fetches `/client/pending` again and applies only rows whose
`server_id` (and forgets whose `entry_id`) the user approved. Anything new since
the preview stays pending for the next sync.

**Surfaces.**
- GUI: `POST /api/share/sync` previews by default and applies with
  `{ dry_run: false, approve: {...} }`. This is the compaction pattern
  (`apps/web/src/projectsApi.ts:35-51`). The dialog needs a mock Jay approves
  (RULES Engineering #2).
- CLI: `northkeep share sync` prints the plan and asks `[y/N]` on a TTY. `--yes`
  or `NORTHKEEP_ASSUME_YES=1` skips the prompt, the same as `projects delete`
  (`packages/cli/src/index.ts:992-999`). With no TTY and no `--yes` it applies
  nothing and exits non-zero.
- Phone: additive-only (D1, founder decision).

`GET /client/pending` is not free of side effects. It deletes pending rows in
tombstoned scopes (`create-server.ts:810-813`), and it can create the account
(`:801`). Both are safe to repeat and touch no vault, so previewing is safe.

**Failure prevented.** One click silently replacing documents or forgetting
memories.

### D4. Restore this version

**Rule.** A new core call `vault.restoreProjectRevision({ project, revision,
expected_revision, writer })` writes a prior revision's exact text back as a
new head. It uses the same guard as `updateProject` and refuses
`stale_project` if the head is not `expected_revision`. It refuses if
`revision` is not a superseded working revision of this project. It refuses
with a plain message if ADR 0051 compaction has blanked that revision's text
(KNOWN-LIMITS: newest five kept). The new head records its source revision in
its metadata (key name set at build). The Log is not edited, so the restore is
exact.

**Surfaces.** `POST /api/projects/<slug>/restore` beside the existing routes
(`projectsApi.ts:70`), and a "Restore this version" button on the history list
the project page already loads with `history: true` (`projectsApi.ts:74`,
`project-handoff.ts:288`). This needs a mock. CLI: `northkeep projects history
<slug>` lists revisions, and `northkeep projects restore <slug> <revision>
--yes` restores one. It previews unless `--yes` is given, like
`projects compact`.

On a shared project the restored head reaches the connector on the next push
(D5). Any pending cloud row based on the old head becomes stale (D2) and is
held (D1).

**Failure prevented.** Recovering a rolled-back project took hand work from
history and the sync server. The superseded Mac head sits one revision back, so
one click would have recovered each of the five.

### D5. Push shared scopes automatically, only from a device that is in sync

**Rule.** A `ConnectorAutoPush` engine beside `AutoSync`
(`packages/sync/src/auto.ts:135`) pushes shared scopes to the connector. It
runs only when this device's vault is known to be current:

- **Trigger.** It runs when `AutoSync` reports that the local file equals
  the server's blob: after a vault push (`pushed`), after a pull (`pulled`),
  and when a wake or a write finds this device already in sync (`in-sync`).
  At each point this device holds the newest vault. With vault sync
  configured it does not run on a bare local save.
- **Precondition.** `syncState` must be exactly `in-sync`. `ahead` is not
  enough: two devices each `ahead` of the same version are diverged, and
  neither can tell. When the state is `behind`, `diverged`, a D6 refusal is
  waiting for the user, or `AutoSync` is off, paused or in error, the engine
  pauses and the Cloud screen says why ("This Mac is behind your other
  devices. Cloud Connect will update after it catches up." / "Automatic sync
  is off, so Cloud Connect updates only when you push.").
- **Change test.** It computes a fingerprint over the `(entry_id, entry_hash)`
  of every live entry in the shared scopes, plus the shared-scope list, and
  records it in `connector.json` at each accepted push. It pushes when the
  fingerprint differs from that record, or when the connector's content-free
  manifest (`GET /client/manifest`: entry id, entry hash and scope, less the
  undelivered cloud writes a push keeps) differs from this device's shared
  entries. The second test catches a change this device did not make: a
  memory another device accepted from the cloud and later deleted, or any
  vault version pulled from a device that does not push. A device with no
  vault sync skips the manifest read when its fingerprint is unchanged, since
  no other device changes its vault.
- It pushes only. It never down-syncs, never marks a scope, and runs only
  while the vault is unlocked. A 402, 409, 412 or 428 pauses it the way
  `AutoSync` pauses (`auto.ts:27-39`), and the Cloud screen says so.

A device with no vault sync configured (`no-config`) is the only copy of its
vault, so it pushes on the debounced save, as the first draft said, but sends
no vault version (below).

Hosts: the GUI server, the standalone MCP server, and the CLI (flushed on exit,
like `packages/cli/src/autoPush.ts`). The phone is out of this ADR.

**The connector refuses a push older than the last one it accepted.** A check
on the device alone leaves a window (a phone last-writer-wins re-push can land
between `syncState` and the push), and the first review showed the connector
accepting an older snapshot over a newer one (A4). So every push carries the
vault it was taken from:

- The body gains `vault: { server: <first 16 hex of sha256(sync server URL)>,
  version: <the sync-server version this device is in-sync at> }`. The
  sync-server version is the one sequence every device shares: the sync server
  serializes it with its compare-and-swap on `X-Base-Version`
  (`apps/sync-server/src/handler.ts:125-143`).
- `connector_accounts` gains `vault_server text` and `vault_version bigint`.
  Both push paths at `create-server.ts:709-722` (the accepting path and the
  fallback `replaceScopes`) start their transaction with one guarded statement
  that sets the pair only when the server matches and the version is not
  lower, and every later statement of the push is guarded on that row now
  holding this push's pair. Equal versions pass: an in-sync device re-pushing
  the same vault is idempotent. A lower version, or a missing `vault` once one
  is recorded, is refused with **HTTP 428** and `{ code: 'stale_push',
  vault_version }`. The client checks for 428 before anything else and says
  "Another device pushed a newer copy to Cloud Connect. Sync this Mac first."
  428 is new, so it cannot be mistaken for the 409 re-encrypt error or the 412
  tombstone.
- Reset path. A different `server` value replaces the stored pair: pointing
  vault sync at a new server is a deliberate configuration change. A version
  that restarts on the same server (a deleted and recreated sync account)
  needs `northkeep share push --reset-order`, which sends `reset: true` from a
  manual push only and replaces the pair. The 428 message names the command.
- Old clients (0.22.x, build 28) send no `vault`, so after the first new-client
  push their manual pushes get 428 until they upgrade. That is the point: an
  old client is exactly the device that cannot tell whether it is behind.

Manual pushes (Sync now, `share push|sync`) send the same body and need the
same state. When the device is `ahead`, they push the vault first and send the
version the sync server returns; when it is `behind` or `diverged`, they refuse
with "Sync this Mac first". Two `ahead` devices therefore never send the same
version for different vaults: the sync server's compare-and-swap lets only one
of them become `in-sync` at that version.

**Tombstone enforcement is required.** D5's 412 path exists only when the
connector runs with `CONNECTOR_TOMBSTONE_ENFORCE` on (`tombstones.ts:20-23`,
default off). With it off, a push racing an unshare re-uploads the unshared
scope (first review A5). So `GET /client/manifest` gains
`tombstone_enforce: boolean`, the unauthenticated health page
(`create-server.ts:919-932`) gains one line, "Tombstone enforcement: on" or
"off", computed by `isTombstoneEnforceOn()`, and the engine stays paused with "Cloud Connect
is not refusing pushes to unshared scopes, so automatic push is off" when it is
false. A self-hosted connector without the flag therefore gets manual pushes
only. A 412 from a deliberate unshare on this device clears the scope from the
fingerprint and does not pause the engine.

**Invariant #1 analysis.** What leaves the machine does not change. The
recipient and the scopes are the same, and so is the content: only content in
scopes the user individually marked Shared goes, under clause (b). **When** it
leaves changes. Today it leaves on a deliberate action. After D5 it leaves
within seconds of a vault push that included a write into a shared scope. The
share consent already describes a continuing copy: "Memories in '<scope>' will
be copied to NorthKeep's connector server", which "can always see ... when they
change" (`shareCmd.ts:96-100`). Under invariant #2 the connector learns the
edit cadence of shared scopes more finely, the vault sync version number, a
16-hex hash of the sync server URL, and when this device wakes or pulls (one
manifest read each, added in the fix round). None is content.

**Toggle** (founder decision, 2026-09-30). On by default, with a Cloud screen
switch "Keep Cloud Connect up to date automatically".

**Failure prevented.** The multi-day drift window in which every cloud write
lands on an old base, without letting a behind or diverged device replace the
connector's newer copy.

### D6. Every pull reports what would drop out; the manual one asks

**The drop set.** Computed from the pulled vault after it opens with the key.
An item is in the drop set when it is on this device and the pulled vault
would take it away or undo it:

- entries live here whose id does not exist in the pulled vault ("only on this
  device"), with counts by scope and the first line of each;
- **entries forgotten here that are live in the pulled vault** ("you deleted
  this here; the pull would bring it back"), by scope, with no content shown
  because this device no longer has it. `forget()` blanks the row under the
  same id (`vault.ts:493-520`), which is why an id comparison alone misses it
  (first review L2);
- entries superseded here whose replacement is absent there (the replacement
  is already in the first bullet; the report names the project or memory once);
- projects whose local head id is absent from the pulled vault, by name.

Scope marks that differ (shared here and not there, or the reverse) are listed
on the manual report as information and are **not** part of the drop set. The
automatic pull runs only in `behind`, where this device has not changed since
its last sync, so a mark difference there is another device's deliberate share
or unshare; refusing on it would wedge every normal share. A local mark change
the pull would undo can only exist when the device is diverged, which is the
manual path, where the report shows it. The other rules need no such
exception: an entry id is never removed from a vault and a forget is never
reversed, so in `behind` a non-empty drop set always means the server copy
lost something this device had.

**Automatic pull.** `pullVault` computes the drop set itself, on `tmpPath`,
after the open-verify and under the file lock (`client.ts:403-455`), so it
checks exactly the bytes it would install. A non-empty drop set refuses the
swap with `PullWouldDropError(report)`, and `AutoSync` surfaces it the way it
surfaces `diverged` (`auto.ts:461-480`). This check is **load-bearing**, not
defense in depth, because of the phone:

- The phone runs a last-writer-wins policy on vault sync
  (`apps/mobile/src/lib/sync-flow.ts:12-29`). On a 409 it downloads the
  server's vault, keeps it as the phone's `.bak`, and re-pushes its own vault
  over it with the new base version. The server then holds the phone's vault
  without the Mac's work.
- The Mac's next `wake()` sees its file unchanged since its last sync and the
  server ahead, so `syncState` says `behind` and today it pulls automatically.
  The first review drove the phone's real `runSyncAfterSave` and showed the
  Mac's pushed work leaving its live vault (L1), and a forgotten shared memory
  coming back live (L2).
- With D6 the Mac refuses that pull, shows the report, and D5 stays paused
  until the user resolves it. What remains is a choice between two devices'
  work, which this ADR accepts (merge is out of scope).

The build must not drop or weaken this check. The acceptance runs L1 and L2 as
regressions.

**Manual pull, pinned on both sides.** A dry pass downloads, verifies and
opens the blob, computes the drop set, and keeps three things: the downloaded
bytes (in `vault.nkv.pulled.hold`, mode 0600), the `x-version` and `x-sha256`
the server sent with them (`client.ts:95-111`, `handler.ts:110-123`), and the
local file's sha. On confirm:

1. It asks `/api/status` again. If the version or sha differs from the dry
   pass, the server moved: it refuses with `RemoteChangedError`, discards the
   held bytes, and runs the dry pass again to show a new report.
2. Otherwise it installs **the held bytes**, not a new download, through the
   same checks as today (transport sha, open-verify, generation replay,
   `expectLocalSha` under the lock, `client.ts:417-455`). A local write since
   the dry pass refuses with `LocalChangedError`.
3. `sync.json` records the dry-pass version as the synced version.

So the vault installed is byte for byte the one the report described. The
sync server has no conditional GET today, and none is needed: if the server
moves after step 1, this device holds exactly what the user confirmed and is
simply `behind`, and the next automatic pull runs the D6 check again (first
review L3).

No prompt runs while the sync or file lock is held (`client.ts:388`, `:403`).
An empty drop set pulls without a prompt, because nothing on this device is
lost or undone.

**Surfaces.** `northkeep sync pull` prompts, or takes `--yes`. `POST
/api/sync/pull` (`apps/web/src/api.ts:821-830`) returns the report with 409
unless `confirm: true` and the dry pass's `version` and `sha256` are sent back.
The Mac dialog needs a mock. It names `vault.nkv.bak` as where the dropped
items stay recoverable.

**Merge stays out of scope.** The vault is a hash chain checked by
`verifyChain`. Re-appending local-only memories onto the pulled vault is
feasible, because they would be new appends with new ids. But local-only
project heads are the same fast-forward-or-conflict problem as D1, across two
whole vaults. Report first; a "re-apply dropped memories" command can follow in
its own ADR once the report shows how often it happens (**unverified** how
often).

**Failure prevented.** A pull, manual or automatic, silently discarding this
device's newer work or undoing its deletes.

## 4. KNOWN-LIMITS changes (ship under the review gate)

- Replace "Stale-base last-writer-wins per section" (M14 section) with the D2
  rule: a hosted `project_update` without the current `expected_revision` is
  refused.
- Add: "A cloud project update is applied on a device only when that device's
  document is still the one the cloud update started from; otherwise it waits
  as a conflict you resolve. Cloud updates written before version <x> always
  wait for you."
- Add the phone line: "The phone applies only new memories and new projects
  from your cloud apps. Replacements and deletions wait for your Mac."
- Replace "Cloud Connect's copy updates only when you push" (added in
  `7a7780f`) with the D5 behavior, the switch, and "only while this Mac is in
  sync with your other devices".
- Add: "Automatic push to a self-hosted connector needs
  `CONNECTOR_TOMBSTONE_ENFORCE=1`."
- Replace "A manual Pull replaces the local vault" with the D6 report and
  confirmation, including restored deletes. Keep the `.bak` sentence.
- Add: restore works only for the newest five revisions (ADR 0051).
- Add: old clients (before this ADR) receive no cloud project updates and
  cannot push to Cloud Connect once a newer client has, until they upgrade.
- The D2 residual on the generic tools, if it is not fixed in the build.

## 5. Tests

Real Postgres for every storage change (RULES Engineering #3). Every storage
test runs twice, on `InMemoryConnectorStorage` and on `NeonConnectorStorage`
over PGlite, and asserts the same literals on both, because the section 9
acceptance uses the in-memory store.

- **Incident replay (regression).** Temp `NORTHKEEP_HOME`,
  `NORTHKEEP_NO_KEYCHAIN=1`, and an in-process connector
  (`createConnectorServer`, as in `packages/sync/test/connector-fold.test.ts`).
  Share `project:a` and push revision R1. A cloud `project_update` produces a
  pending row with base R1. Save locally to R2 without pushing. Run the
  down-sync. Assert: the head is still R2 with R2's text, one conflict names
  `project:a` with base R1, local R2, reason `moved`, and the row is still
  pending. Then take theirs: the head's text is the cloud text and R2 is in
  history. A second copy uses keep mine: the head is R2, one episodic memory in
  `project:a` holds the cloud text, and the server has no pending row. A keep
  mine retried after a simulated crash leaves exactly one such memory.
- **Fast-forward still works.** Same setup without the local save: applied,
  acked, and the row renamed to the new head id.
- **Legacy rows (first review A2 replay).** Seed rows with `base_revision`
  NULL directly in storage, in the A2 shape (first written against P0,
  overwritten after a push of P). Assert every client holds them with reason
  `legacy`: with the device at P, at P0, and with no local document. A v1
  client (no `?v=2`) receives no project working rows.
- **D2 ordering.** Push R2 after a pending row based on R1: `project_get`
  returns R2 with its revision, and the R1 row is delivered with
  `stale: true`. `project_update` with no `expected_revision` refuses.
  `expected_revision=R1` refuses `stale_project` and returns R2. Two successive
  updates get distinct revisions, and the second carries the first's base. An
  ack with no re-push leaves both stores naming the acked row as `P` (A3). A
  stale row whose text equals an older device head is discarded, not acked,
  and `P` is unchanged.
- **D2 concurrency.** Two `project_update` calls with the same
  `expected_revision`, fired together against PGlite: exactly one succeeds and
  one pending working row exists. A held stale row survives both.
- **D3.** A preview writes nothing: the vault file hash is unchanged (the
  `adr-0054-acceptance.sh` step 4 pattern). A row that arrives between preview
  and apply stays pending. Non-TTY without `--yes` exits non-zero and changes
  nothing.
- **D4.** Restore of the newest superseded revision gives head text equal to it.
  Stale `expected_revision` refuses. A blanked revision refuses with the plain
  message.
- **D5.** After a vault push, a write in a shared scope pushes once. A write in
  a private scope pushes nothing. `behind`, `diverged` and `ahead` push nothing
  and pause with the stated reason. Nothing runs while locked. A push of an
  older vault version gets 428 and the connector still serves the newer
  document (A4 replay). `tombstone_enforce: false` keeps the engine paused.
- **D6.** Diverge two temp vaults. The dry pull lists the local-only memory and
  project by name. A local forget of a memory live on the server appears in
  the drop set (L2 replay), and the automatic pull refuses it. The phone's
  real `runSyncAfterSave` re-push followed by the Mac's `wake()` leaves the
  Mac's work live (L1 replay). A server push between the dry pass and confirm
  refuses with `RemoteChangedError` (L3 replay). A local write in between
  refuses with `LocalChangedError`.

## 6. Rollout and migration

Pushing `main` deploys the connector (production). Each step needs Jay's yes.

1. **Connector first.** It adds the columns and table, records
   `base_revision` and `write_seq` on every new write, applies the D2 ordering
   and the atomic write, requires `expected_revision`, adds `/client/discard`,
   the `?v=2` fields, the 428 stale-push check and the manifest's
   `tombstone_enforce`. `/client/pending` withholds pending `working` rows in
   project scopes from clients that do not send `?v=2`. Today's clients
   (0.22.x desktop and CLI, every phone build in the field) apply those rows
   blind (`connector-client.ts:366-374`). This gate is the only protection they
   get, because phones update only through EAS builds Jay approves.
2. **No backfill.** Existing pending rows keep `base_revision` NULL and are
   held as legacy conflicts forever, until the user resolves each one. The
   first draft proposed guessing a base from `created_at`. The first review
   reproduced that guess turning a legacy row into a silent rollback on the
   real Neon SQL (A2): a row's `created_at` is its last in-place overwrite
   (`neon-storage.ts:381`, `mcp.ts:915-925`), and nothing records when it was
   first written. Before the deploy, a read-only count of pending working rows
   on the founder's account says how many conflicts to expect (**unverified**
   today).
3. **Verify tombstone enforcement, read-only.** After the deploy, one
   unauthenticated `curl -s` of the production connector's health page (`/`)
   must show "Tombstone enforcement: on". That page reads no storage and
   writes nothing, and it reports the parsed flag, so a variable set to `0`
   shows "off". `GET /client/manifest` is not used here: it upserts the
   account and stamps entitlement. `vercel env ls production` for the
   connector project is a presence check only (names, never values) and does
   not prove the flag is on. If the page says "off", D5 stays paused by design
   and setting the variable is its own Tier 2 yes.
4. **Desktop and CLI release** with D1, D3, D4, D5 and D6, sending `?v=2` and
   the push `vault` field.
5. **Phone build** with D1's additive-only down-sync and `?v=2`, batched with
   other mobile work.

## 7. Review scope

The whole ADR is under the review gate:
- **Who decides / what wins**: D1, D2, D3 and D6 change which document wins and
  when the human decides.
- **Egress timing**: D5.
- **Published claims**: the KNOWN-LIMITS edits.

The recheck should attack, against code:
- **D1**: legacy rows on every path, including the ADR 0050 fold and the phone.
- **D2**: the CTE under concurrency on PGlite, and `write_seq` agreement across
  stores after acks, discards and emptied-scope pushes.
- **D5**: the 428 guard on both push paths, the reset path, and a phone
  last-writer-wins landing between `syncState` and the push.
- **D6**: forgets, supersedes and scope marks in the drop set, and the pinned
  confirm against a moving server.

## 8. Founder decisions (2026-09-30)

1. Hosted `project_update` **requires** `expected_revision` (D2). Cloud bots
   that do not send it are refused until their instructions change.
2. **Keep mine** saves the cloud version as a memory in the project scope,
   visible to cloud apps, before removing it (D1).
3. **Automatic push** is on by default, with a switch (D5).
4. The **phone** applies only additions, never replacing a project or
   forgetting a memory, until it has a preview screen (D1, D3).
5. The three new screens (Sync now preview, conflict resolution with restore,
   pull report) each get a mock Jay approves before build (RULES Engineering
   #2).

## 9. Acceptance (Jay, from the CLI; built with the feature)

A script in the `scripts/adr-0054-acceptance.sh` pattern,
`scripts/adr-0063-acceptance.sh`, run from the repository root after
`pnpm -r build`. It uses `NORTHKEEP_HOME=/tmp/nk-0063-acceptance/home`,
`NORTHKEEP_NO_KEYCHAIN=1`, a local connector on a loopback port backed by
PGlite (so the storage rules are Neon's SQL, not the in-memory store), and a
local sync server. It refuses any other home. One step per call:

```
bash scripts/adr-0063-acceptance.sh setup     # temp vault, local connector, share project:demo, push
bash scripts/adr-0063-acceptance.sh 1         # a cloud update, then a local save: the incident
node packages/cli/dist/index.js share sync    # expect: "1 conflict: demo" and the plan; answer n
bash scripts/adr-0063-acceptance.sh 2         # prints the local head: still the local save
node packages/cli/dist/index.js share resolve demo --take-theirs
bash scripts/adr-0063-acceptance.sh 3         # head is the cloud text; history holds the local save
node packages/cli/dist/index.js projects restore demo <revision from step 3> --yes
bash scripts/adr-0063-acceptance.sh 4         # head is the local save again; stale restore refused
bash scripts/adr-0063-acceptance.sh 5         # a legacy row (no base) is held, never applied
bash scripts/adr-0063-acceptance.sh 6         # diverged pull: the report names a dropped memory and a restored delete
bash scripts/adr-0063-acceptance.sh cleanup
```

The `share` and `projects` commands above need the same environment the script
exports, so the script prints them with it. The exact wording is fixed when the
script is written.

## Review history

- 2026-09-30, first review, NOT CLEARED:
  `~/Claude/Projects/NorthKeep/Reviews/adr-0063/first-review.md` (attacks in
  `attacks/`). This revision closes:
  - KILL SHOT A2 (backfill): rollout step 2 removed; legacy rows always held
    (D1, section 6 step 2); `base_revision` gets a `new` sentinel so legacy
    stays distinct (section 2).
  - FLESH WOUND L2 (forgets): the drop set counts local forgets the pull would
    resurrect; scope-mark differences are shown on the manual report (D6).
  - FLESH WOUND L3 (confirm window): the manual pull installs the held
    dry-pass bytes after re-checking the server version and sha (D6).
  - FLESH WOUND A4 + D5 (regressed push): auto-push only when `in-sync`,
    chained after the vault push, and the connector refuses an older vault
    version with 428 (D5).
  - Notes: `created_at` removed from every rule, `write_seq` and `scope_seq`
    added (A3, section 2, D2); the `expected_revision` check is one SQL
    statement (D2); the delete names only the replaced row (D2); stale rows
    are flagged in `?v=2` (D2); the automatic-pull check is load-bearing for
    the phone's last-writer-wins (D6); D5 needs tombstone enforcement,
    verified read-only from the health page at rollout (D5, section 6 step
    3); crash-after-save wording (D1).
  - Found while revising: a dedupe ack of a stale or legacy row would move the
    connector's head backward through the ack path; such rows are discarded
    by id instead (D1).
  - Founder decisions recorded (section 8).
- 2026-09-30, recheck, CLEARED:
  `~/Claude/Projects/NorthKeep/Reviews/adr-0063/recheck.md` (attacks in
  `recheck-attacks/`). A2, L2, L3 and A4 closed on both stores; no kill
  shot or flesh wound in the fix diff.
  - SCAR TISSUE R-428c (different sync servers): recorded in KNOWN-LIMITS.
  - R-S1 (working rows through `memory_remember`) and R-W1 (`write_seq`
    NULL at deploy): fixed on the connector (connector notes).
  - R-S2 (a stale create revives after a delete): fixed on the client
    (client notes, "Recheck R-S2").
  - R-428b and R-428d behave as measured; R-428d's reset wording is in
    KNOWN-LIMITS and the integration notes. R-S3: the deterministic create
    id was retired.
  - The recheck asked Jay whether the fix round's new mechanisms call for a
    fresh first review instead of a recheck. Not answered on record.

## Build notes

### Connector (g63/connector)

Choices made where the text above was silent or ambiguous, and the exact
wire shapes, so the client build and the reviewers can check against them.

**Wire protocol.**
- `GET /client/pending?v=2`: each entry is `{ server_id, scope, type,
  content, stale, base_revision? }`. `base_revision` is omitted, never null,
  for a legacy row. `stale` is on every entry. It is true only for a pending
  `working` row in a slug-valid project scope that D2 would not serve,
  including every legacy one. It is computed from a fresh read after the
  tombstone read, so a row replaced between the reads comes back stale.
- Without `?v=2` the shape is unchanged and every pending `working` row in a
  project scope is withheld, base-`new` creates included. Memories and Log
  archives still flow to old clients.
- `base_revision` on rows that are not documents: a `memory_remember` row
  has none. A Log archive carries the base of the document it rode with; D1
  ignores it.
- `POST /client/discard`: body `{ server_ids: string[] }`, answer
  `{ ok: true, discarded: n }`. It deletes only rows that are still pending;
  other ids are ignored. Each touched scope's counter moves once. Gate: the
  connector token's account plus the entitlement, the same as `/client/ack`
  (RULES Engineering #4). Refusals: 401 no token, 400 not an array of
  strings or an id with U+0000, 402 lapsed, 413 over 5000 ids. A forget
  queued against a discarded id is left in place and drains on the next ack.
- `PUT /client/entries` accepts `vault: { server, version }` and `reset`.
  `server` must be 16 lowercase hex characters and `version` a whole number
  of 0 or more; `reset` must be a boolean when present. Anything else is 400
  and changes nothing.
- HTTP 428 body: `{ error, code: 'stale_push', vault_version }`, where
  `vault_version` is the stored version (a number, or null when none).
- Check order on a push: the tombstone pre-check first (412 when
  enforcement is on), then the vault guard (428), then the writes. With
  enforcement off, the plain-replace fallback applies the guard again, so a
  push that is both older and tombstoned gets 412 with the flag on and 428
  with it off. Nothing is written in either case.
- Guard rules. A push with no `vault` is accepted only while no pair is
  recorded. A push with `vault` is accepted when no pair is recorded, when
  the server differs (the pair is replaced), or when the version is equal or
  higher. `reset: true` is always accepted and stores exactly what was sent.
  With no `vault`, that clears the pair (open point R-428d): old clients then
  pass again until a device sends a `vault`.
- `GET /client/manifest` adds `tombstone_enforce: boolean`. The health page
  adds `Tombstone enforcement: on` or `off` from the parsed flag.

**Hosted tools.**
- `project_get` text ends with `Revision: <id> (pass it as expected_revision
  to project_update)`. `structuredContent` is `{ project, revision }`.
- `project_update` keeps `expected_revision` optional in the schema, so a
  missing one gets the design's sentence and not the SDK's generic error. It
  is checked after the slug, empty-update, text-rule and tombstone checks.
  `stale_project` is an error whose text starts "Project changed after it was
  read. Nothing was saved. The current document follows; its revision is
  <id>." followed by the document. Its `structuredContent` is
  `{ code: 'stale_project', project, revision, document }`. A lost
  compare-and-swap answers the same way. Success keeps `(id: X)` in the
  text, adds `Revision: X.`, and returns `{ project, revision }`.
- `project_create` ids are now `conn_<uuid>`. The deterministic
  `conn_create_<sha>` id is retired because the compare-and-swap closes the
  concurrent-create race (recheck R-S3). The loser gets "Project already
  exists; use project_update." or "Nothing was saved: project "<slug>"
  changed while it was being created. Call project_get, then retry."
- Several pushed heads at the top `write_seq`: `project_get` and
  `project_update` refuse with "Project has multiple current documents.
  Nothing was saved. Ask the user to open NorthKeep and push again (Sync
  now)." `project_list` shows the project with `revision: null` and a
  `conflict` field.
- Only stale or legacy rows left in a scope (recheck note on contradictory
  refusals): `project_update` and `project_create` both answer "Nothing was
  saved: a cloud version of project "<slug>" is waiting for the user to
  review it in NorthKeep. Ask them to resolve it there, then call
  project_get." `project_get` and `project_list` say the same in their own
  words.
- The D2 residual is fixed in the build, not left to KNOWN-LIMITS.
  `memory_list`, `memory_retrieve`, `search` and `fetch` hide stale pending
  project documents.
- `memory_remember` refuses `type: 'working'` in a slug-valid project scope
  (recheck R-S1). Other types in a project scope, and `working` in other
  scopes, are unchanged.

**Storage.**
- `write_seq` is `bigint NOT NULL DEFAULT 0` (recheck R-W1). Rows from
  before the deploy read 0 on both stores. A constant default is a
  catalog-only change on Postgres 11 and later, with no table rewrite.
  `base_revision` has no default, so legacy rows stay NULL. There is no
  backfill.
- Consequence: at deploy, a scope that holds an acked row next to its old
  pushed row has both at 0. It reads as several heads until the next push.
  The desktop and CLI re-push after every down-sync they apply (checked at
  integration: `share sync` and `POST /api/share/sync` push after
  `applyDownSync`); when they refuse because the device is behind or
  diverged they apply and ack nothing, so no new tie forms. A phone ack made before
  the deploy leaves the tie in place until the Mac next pushes. The connector
  ships before any client with D5, so until the desktop release that push is
  a manual Sync now from 0.22.x. The guard accepts it while no pair is
  recorded.
- The counter starts at 0 when `readScopeSeq` first creates it.
- Counter moves: an accepted push (once per pushed scope; a refused push
  moves nothing), every cloud write (a compare-and-swap for project writes,
  an unconditional move for `memory_remember`), an ack, a discard, a forget
  drain, an unshare, and the tombstone purge inside `GET /client/pending`,
  which now goes through `discardPending`. An unshare moves an existing
  counter only and never creates one, so a lapsed account cannot use unshare
  to grow the table past the ADR 0061 caps. `purgeLegacyPlaintext` is
  exempt: it is flag-gated maintenance over the whole table, and its rows
  were never served.
- Every decision that needs a row's type is made per request, after
  decryption, and never stored. That covers P, `stale`, the v1 withhold and
  R-S1, because the stored `type` column is `''` for every encrypted row.
- Driver shape, read from `@neondatabase/serverless` 0.10.4 (types and
  source): with the default options `transaction()` resolves to one row
  array per statement, which `runPush` and `discardPending` read. int8
  comes back as a string, so every counter goes through `Number()`. The
  driver sends no isolation header unless asked, so the transactions that
  move the counter pin `isolationLevel: 'ReadCommitted'`, the level the
  real-Postgres proof ran under. The single-statement compare-and-swap runs
  at the database default, Postgres's READ COMMITTED (not checked against
  the live Neon project).
- A push over an existing id now sets `origin 'vault'`, `pending false` and
  `base_revision NULL` on Neon, matching the in-memory store.
- Store divergence fixed: the Neon ack deleted the row under the local id
  even when the server row was already gone, so an ack of a replaced row
  could delete the pushed head. It is now a no-op on both stores, as D2
  requires.
- `GET /` skips the once-per-process ADR 0061 maintenance. The rollout step
  3 curl therefore touches no storage even if that flag is on. ADR 0061
  Decision 3 still says the step runs "at the first request of each server
  process"; it now runs at the first request other than the health page.

**Evidence.**
- `apps/connector-server/test/adr0063-*.test.ts` run every storage and route
  rule on both stores. The PGlite driver returns int8 as strings, as Neon's
  HTTP driver does, and one scope is driven past counter value 9.
- `node apps/connector-server/scripts/adr0063-real-pg.mjs <empty dir>` races
  the exact captured statements on a throwaway local Postgres. It checks two
  updates at one counter value, and pushes at vault versions 5 and 6 in both
  orders on both push paths (the accepting path the route tries first, and
  the plain replace it falls back to).
- The incident replay, connector half:
  - The 0.22.x `downSyncConnector` receives nothing, the head stays R2, and
    the row stays pending.
  - `?v=2` delivers the row with base R1 and `stale: false`, because R2 was
    never pushed and the connector cannot see it. Holding it is D1's job on
    the client.
  - After R2 is pushed, `project_get` serves R2 and the row is `stale: true`.

- The whole replay, both halves: on a throwaway local merge with
  `g63/client` at `29f5a16` (not committed, not pushed), the client's real
  `fetchPending`, `planDownSync`, `applyDownSync` and `resolveConflict` ran
  against `createConnectorServer` on both stores. The row was held as
  `moved` with base R1 and local R2, and nothing was applied. Take theirs
  put the cloud text on the head, kept R2 in history and acked. Keep mine
  kept R2, left one memory with the cloud text and no pending row, and a
  retry added nothing. A fast-forward applied on approval and the connector
  then served the new head id. A legacy row was held as `legacy`.

**Not done on the connector, for Jay.**
- Recheck R-S2 (a stale base-`new` create revives after the user deletes
  the project). A connector-side fix would have to store a flag derived from
  the pushed rows' encrypted type. That is new content-derived metadata,
  outside the list in the ADR's "What leaves the machine" section, so it was
  not built. Suggested client-side fix: when the user deletes a shared
  project, discard that scope's pending working rows by id through
  `/client/discard`, after saving each as a "Cloud version not kept" memory.
- R-428b (equal versions across an ack) and R-428c (devices on different
  sync servers) behave as the recheck measured them. R-428c's KNOWN-LIMITS
  line shipped with the client half.
- R-S2 was fixed on the client instead (see the client notes, "Recheck R-S2").
- The read-only count of the founder's pending working rows before deploy
  (section 6 step 2) was not run: no production access here.

### Client (g63/client)

Branch `g63/client` (from `g63/base`, 2026-09-30). Everything here was a
choice the design left open, or a place where the code differed from the
design's reading of it. The connector half is on `g63/connector`; the client
was tested against a protocol fake written from this document
(`packages/sync/test/fake-connector.ts`), so the merged branches must run the
same scenarios against the real connector.

**Wire.**
- `GET /client/pending?v=2`. A `base_revision` that is absent, empty or not a
  string is legacy (null). `stale` counts only when it is literally `true`.
- `POST /client/discard { server_ids: string[] }`; the client reads only the
  status. `POST /client/ack` is unchanged.
- `PUT /client/entries` adds `vault: { server, version }` (omitted with no
  vault sync) and `reset: true` (only from `share push --reset-order` or
  `POST /api/share/push { reset_order: true }`). 428 is read before every
  other status; `vault_version` in its body is optional.
- `vault.server` is the first 16 hex of sha256 over the UTF-8 sync server URL
  exactly as `sync.json` stores it (`setSyncServer` normalizes it with
  `URL.toString()` and drops a trailing slash), for example
  `http://127.0.0.1:4321`.
- `tombstone_enforce` missing from the manifest reads as off, and a failed
  manifest call is an error: automatic push never assumes the protection.

**D1.**
- Classification order: identical text first (a current row is acked as a
  dedupe; a stale or legacy row is discarded), then legacy, stale, several
  heads, fast-forward, base-`new` create, else `moved`. A legacy row is also
  stale on the connector; it is labelled `legacy`.
- Any `getProjectView` error other than `not_found` (several heads, or a head
  the reader cannot parse) is held as `several_heads`.
- Fast-forwards, creates and take theirs write through a new core call,
  `vault.replaceProjectContent` (whole text, bound to the head read, same
  supersede guard as `updateProject`). A create refuses when a head exists and
  refuses text the project reader cannot parse; the row is then held as
  `moved`. The new head carries `metadata.connector.server_id`.
- Keep mine writes `# Cloud version not kept, YYYY-MM-DD` then a blank line
  then the cloud text, `metadata.connector.discarded = <server_id>`. With
  several rows waiting for one project it keeps each; take theirs needs one
  id (`--id`). Take theirs refuses on `several_heads`. The CLI's take theirs
  binds to the head the user saw with `--expected-revision` (printed by
  `share conflicts --show`) and otherwise to the head read under the lock;
  the API takes `expected_revision`.
- A forget for an entry not live here changes nothing and is acked on the
  desktop without asking. The phone never acks a forget.
- The phone (`additiveOnly`) still runs the ADR 0050 fold for a base-`new`
  document and acks non-working duplicates; the two identical-text D1 rows
  are deferred to the Mac.

**D3.**
- The CLI prompts only for replacements and forgets. A plan with conflicts
  only applies its additions without a prompt; conflicts never apply. Answering
  no, or no terminal without `--yes`, applies nothing and exits non-zero.
- `share sync`, `share add` and `share resolve` refuse before writing when
  this device is behind or diverged, because the push that must follow would
  be refused and the write would only diverge the device.
- The apply still holds the vault lock across its fetch and ack, as the 0.22
  down-sync did. Manual pushes run in phases: stamp (maybe a vault push) with
  no vault lock, snapshot under the lock, upload with none.
- New CLI: `share conflicts [--show <slug>]`, `share resolve <slug>
  --take-theirs|--keep-mine [--id]`, `share auto [on|off]`.

**D4.** Metadata key `northkeep_restore_v1: { from_revision }`, source
`northkeep:project-restore`. `replaceProjectContent` drops the inherited
handoff, provenance, restore and connector blocks and keeps the ADR 0062
operations ledger. `projects restore` previews unless `--yes`;
`--expected-revision` pins the head, and defaults to the head read in the same
lock.

**D5.**
- Triggers: AutoSync's `pushed`, `pulled` and `in-sync` events, debounced 5 s,
  and a device with no vault sync on its own save. The engine checks, in
  order: the switch; a local snapshot (nothing shared, or the fingerprint
  unchanged, ends the run with no network call, so an unpaired device never
  creates an account on the connector); the AutoSync status (off, paused,
  error, diverged, a pending pull review); `syncState` (exactly `in-sync`);
  the manifest flag; then a second snapshot for the upload, because the first
  may predate a pull that `syncState` then reports.
- Every automatic push forwards the sync server's entitlement attestation,
  as the manual paths do; the hosted billing gate refuses `/client` calls
  without it.
- Pauses that wait for the user: 402 (lifts after 10 minutes, like AutoSync),
  409, 412 (unless a local unshare raced the push) and 428. A manual push,
  the switch or a server change lifts them. The others are re-checked on
  every run.
- Fingerprint: sha256 over the JSON of the sorted shared-scope list, then
  `\n<id> <entry_hash>` per live entry. Stored as `auto_push_fingerprint` in
  `connector.json` beside `auto_push` (the switch), cleared on a server
  change, written only by an accepted push (manual pushes included). A
  down-sync apply or ack never writes it (recheck R-428b).
- Hosts: the GUI server and the standalone MCP server fan AutoSync events out
  to the engine; the CLI runs it once after a command's vault push.
- A manual push with vault sync configured refuses a non-default `--vault`
  (recheck Note on the non-default vault). Share-add pushes follow the manual
  rules.
- The 428 text names `--reset-order` for a device that is already in sync
  (recheck R-428d); the app's reset is `POST /api/share/push`.

**D6.**
- "Live in the pulled vault" means its default list (not forgotten, not
  superseded), so a revision compaction blanked here is not reported as a
  delete the pull would undo. Projects are named when their local head is
  only here.
- The hold is `<vault>.pulled.hold` plus `<vault>.pulled.hold.json`
  `{ version, sha256, local_sha }`, both 0600; the sha is of the held bytes.
  Confirm compares the server's status sha only when the server reports one,
  else the version alone.
- An empty drop set installs without asking, through the same confirm path.
  API 409 codes: `pull_would_drop`, `remote_changed` (with a fresh report),
  `local_changed`.
- The automatic refusal is surfaced like `diverged`: AutoSync phase `error`,
  event `pull-refused`, `status().pullRefusal`, no timed retry.

**Recheck R-S2 (closed).** `projects delete` and `DELETE /api/projects/<slug>`
delete a shared project's scope on the connector first (which also removes a
pending cloud write) and unmark it in the same save as the local delete. If
the server delete fails, nothing is deleted. A scope marked shared with no
connector configured here is deleted and unmarked locally.

**GUI until the three screens ship.** Sync now sends `{ dry_run: false,
approve: {} }`: additions only, and the rest is named with the CLI command.
Pull shows the 409 report's sentence. The Cloud screen's fixed "does not
update on its own" sentence now reads the engine status. No new screens.

**Open for the merge and the phone build (all closed at integration).**
- The `apps/connector-server` suites that imported `downSyncConnector`
  (`c3-connector`, `c3-property`, `m14-projects`) now run `applyDownSync`.
- The phone's Sync now re-push is removed and its share push is stamped
  (see "Integration" below).
- The section 9 acceptance script is `scripts/adr-0063-acceptance.sh`.

### Integration (g63/integrate)

Branch `g63/integrate` from `main` at `86d96af` (the iPhone Projects tab,
Expo 57 and the sqlite fix), then `g63/connector` and `g63/client` merged
with `--no-ff`. The only textual conflict was these build notes. KNOWN-LIMITS
and `apps/mobile` (Expo 57 on `main`, additions-only down-sync on
`g63/client`) merged without conflicts, and mobile tsc, the mobile tests and
`npx expo export --platform ios` passed on the merged tree before any fix.

**Wire, checked against both build-notes sections and the code.** No
mismatch needed a code change.
- `vault.server`: the client hashes `sync.json`'s URL (already normalized by
  `setSyncServer`) to 16 lowercase hex; the connector accepts exactly 16
  lowercase hex. The phone normalizes the same way before hashing
  (`vaultServerHashForPhone`), and a test pins it equal to the desktop's
  `vaultServerHash`, because a mismatch would read every phone push as a
  different sync server and replace the recorded order (R-428c on every
  push).
- `base_revision`: the connector omits it for a legacy row; the client reads
  absent, empty or non-string as legacy.
- `stale`: always present from the connector; the client honors only a
  literal `true`.
- `/client/discard { server_ids }`: the client reads only the status. It
  sends every stale or legacy duplicate of one sync in one call; a plan over
  5000 such rows would get 413 (not reachable in practice, not handled).
- 428: the client reads it before every other status and does not use the
  connector's `error` text, so the two wordings may differ.
- `reset`: sent only from a manual push. With vault sync configured it
  carries the stamp and replaces the pair. From a device with no vault sync
  it carries no `vault` and clears the pair, so pushes with no `vault` (old
  clients, devices with no vault sync) pass again until a stamped push.
  This answers the recheck's R-428d question about what `--reset-order`
  records with no sync config; KNOWN-LIMITS says it.
- `tombstone_enforce` missing reads as off on the client; the connector
  always sends it.

**Phone (D1, D5).** The design (D1, "Phone") said the phone never re-pushes
to the connector after a down-sync; the code did, and its share add pushed
with no stamp. Both would have been refused with 428 once a D5 desktop
pushed.
- Sync now no longer pushes to the connector. `runConnectorSyncNow` has no
  push port, so its outcome is `synced`, `nothing-shared` or a failure. The
  vault change still goes to the sync server, and the Mac updates Cloud
  Connect once it is in sync.
- Share add stamps the push with `{ server, version }` only when the phone's
  vault file sha equals the sha a live `/api/status` reports, read with the
  entries under one vault-gate hold. Otherwise it refuses before any request
  ("This phone is not in sync with your other devices yet, ..."). It never
  pushes the vault first as the desktop does when ahead: the phone's
  last-writer-wins push could displace a newer Mac vault and then stamp it as
  the newest. With no sync server configured it sends no stamp, like a
  desktop with no vault sync. A 428 on the phone reads "Another device pushed
  a newer copy to Cloud Connect. Let this phone finish syncing, then share
  again.", not the Mac's command.
- This needs the next phone build; build 28 and earlier keep the old
  behavior and get 428 once a D5 client pushes.

**Tests ported.** `c3-connector` (3), `c3-property` (1) and `m14-projects`
(1) call `applyDownSync`: a forget applies only when approved (an unapproved
one is shown waiting), and a document whose base is not the local head is
held as `moved`. The adr0063 connector suite reads the old-client gate on
the v1 wire instead of the retired `downSyncConnector`, asserts the client's
428 message, and gains one case running the client's approve and keep-mine
paths against the real connector on both stores.

**Acceptance.** `scripts/adr-0063-acceptance.sh` follows section 9 with
these differences, forced by the built code:
- The conflict in step 1 reads "Cloud Connect already has a newer copy than
  the one this cloud version started from" rather than `moved`: the CLI's
  automatic push after the local save sends R2 to the connector (D5), so the
  row is stale by the time `share sync` runs. Step 1 shows it: the save
  prints "Cloud Connect updated" and the cloud app then reads R2.
- `share sync` asks nothing there, because a conflict alone is never applied
  (client D3 note); there is no "answer n".
- Step 5 makes its row legacy through a loopback-only side door in
  `scripts/adr-0063-servers.mjs` that nulls one pending row's base in the
  throwaway PGlite database. No connector route writes a base-less row any
  more (R-S1 is refused).
- The sync server is this repo's `apps/sync-server` on its in-memory store;
  the connector is this repo's on PGlite. `all` runs the sequence unattended.

### Fix round (build review, 2026-09-30)

The build review (`NorthKeep/Reviews/adr-0063/build-review.md`, CLEARED WITH
WOUNDS) found one flesh wound and several notes. Each fix is below.

**P1: automatic push compares with what the connector holds.**
- The fault: the engine pushed only when its shared-entry fingerprint
  differed from its own last accepted push. The phone no longer pushes to
  Cloud Connect, so a memory the phone accepted from the cloud (an ack, which
  changes the connector without a push) and later deleted stayed served after
  the Mac pulled that vault and was exactly in sync.
- The fix: once the in-sync checks and the tombstone flag pass, the engine
  also compares its snapshot with the manifest it already reads, and pushes
  when they differ. The comparison is a set of `scope, entry_id, entry_hash`
  over the local shared scopes; the connector's rows outside those scopes
  are not compared (an unshare deletes them).
- Connector, read-only: `GET /client/manifest` entries gain `pending:
  boolean`, true for an undelivered cloud write. A push never removes such a
  row, so the client leaves it out of the comparison; without the flag every
  wake with a waiting cloud write would push again. It is row state, not
  content-derived, and `/client/pending` already exposes the same rows. No
  other field or route changed.
- Every pause condition is unchanged and checked before the manifest read:
  exactly in sync, the AutoSync status, a pull waiting for review, the switch,
  the tombstone flag, and 402, 409, 412 and 428.
- Cost: an in-sync device now reads the manifest on every trigger whose
  fingerprint is unchanged (a wake, a pull, a push of private changes). A
  device with no vault sync still makes no call when its fingerprint is
  unchanged, and a device with nothing shared still makes none at all.
- A row acked on the connector carries `entry_hash ''`, so the first run
  after an ack pushes once and stores the vault hash; later runs match.
  Tests pin that it settles.
- One edge this makes more reachable: if the Mac runs between another
  device's ack and that device's vault push, its push removes the acked row
  from Cloud Connect until the Mac pulls the vault that holds it, when the
  next run pushes it back. No content is lost (the other device holds it).
  The fingerprint-only engine had the same window whenever the Mac wrote to
  that scope.
- Evidence: `packages/sync/test/adr0063-autopush.test.ts` (P1 on the fake
  connector, the acked-row settle, a pending row is no difference, one
  manifest read and no push when nothing changed, no call with no vault
  sync) and `apps/connector-server/test/adr0063-autopush.test.ts` (the build
  review's P1 attack, inverted, on both stores, plus the settle after the
  Mac's own ack). Without the engine change the P1 cases fail.
