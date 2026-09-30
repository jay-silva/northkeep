# Sync guardrails (design for ADR 0063)

Status: proposed, not built. Review: pending (see "Adversarial review" below).
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
from a rollback. D1 and D2 add that fact. D3, D4 and D6 make the remaining
replace paths visible and reversible. D5 shrinks the window in which the two
copies drift.

## 2. The data shape

One new field, `base_revision`, on a pending connector row.

- A **revision** is the entry id of a live project head. Locally that is
  `getProjectView(...).revision`, the id of the single live working entry
  (`packages/core/src/project-handoff.ts:280-293`). A pushed connector row's
  `entryId` is that same vault id (`connector-client.ts:159-165`), so the
  pushed working row of a project carries the local revision it was pushed at.
- A pending row born on the connector gets a fresh `conn_<uuid>` id
  (`mcp.ts:930`). After the desktop applies it, `ackEntry` renames the row to
  the new local head id and clears `pending` (`storage.ts:576-591`). So the two
  id spaces meet exactly at ack, and `base_revision` always names a vault id.
- `base_revision` is the pushed head the chain of cloud edits started from.
  `null` means "created on the connector" (ADR 0050 `project_create`,
  `mcp.ts:753-765`). Absent means "written by a connector that predates this
  ADR".
- Storage: a plaintext `base_revision text` column on `shared_entries`, added
  with one idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` array entry
  (`neon-storage.ts:30-90`, ADR 0010 single-statement rule), and the same
  optional field on `SharedEntry` (`storage.ts:65-86`). Entry ids are already
  visible to the connector under invariant #2, so this discloses nothing new.
- `/client/pending` returns it per entry (`create-server.ts:829-849`).

## 3. Decisions

### D1. Down-sync applies a cloud document only as a fast-forward

**Rule.** For each pending `working` row in a project scope, with `H` the local
head from `getProjectView` (not the last item of `list()`):

| Row's base | Local state | Action |
|---|---|---|
| string equal to `H.id` | one live head | apply with the guarded project write (below), ack |
| `null` | no live working entry | create (today's path, and the ADR 0050 fold for an empty unshared scope) |
| any | content identical to `H.content` | ack against `H.id` as a dedupe |
| anything else, including absent | | **conflict**: not applied, not acked |
| any | `getProjectView` throws `project_conflict` (several live docs, the old-client shadow case) | conflict |

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
`conflicts: { scope, server_id, base_revision, local_revision }[]`.

**Resolving.** The Mac app shows a conflict on the project page and on the Cloud
screen with three actions. The CLI gets `northkeep share conflicts [--show
<slug>]` and `northkeep share resolve <slug> --take-theirs|--keep-mine`.

- *View both*: the local head and the cloud text side by side (read only).
- *Take theirs*: a revision-bound write of the cloud text over the head the user
  was shown, then ack. Refuses `stale_project` if the head moved. The local
  document stays in history.
- *Keep mine*: a new `POST /client/discard { server_ids }` deletes the pending
  row (`storage.deleteEntry` already exists, `storage.ts:246`), then a push.
  Whether the cloud text is dropped or saved first is a question for Jay
  (section 8).

**Phone.** `apps/mobile/src/lib/vault-session.tsx:1374` calls the same
`downSyncConnector`, so D1 applies there with no phone code. The phone has no
project tools (KNOWN-LIMITS, M14 section), so it holds conflicts and says
"Resolve on your Mac". It never re-pushes to the connector after a down-sync
(`vault-session.tsx:1381` pushes only to the sync server), which this ADR keeps.

**Failure prevented.** The incident: a document written against an old base
replacing a newer local head.

### D2. The connector serves the newest document and refuses stale writes

**Ordering rule, per project scope.** Let `P` be the pushed head: the
non-pending `working` row (after a push there is one; if several, today's
tie-break). A pending working row `c` is **current** when
`c.base_revision === P.entryId`, or when `P` does not exist and
`c.base_revision === null`. Then:

1. If a current pending row exists, it is the head.
2. Otherwise `P` is the head.
3. A pending row that is not current is **stale**. It is never served by
   `project_get` or `project_list`, and never used as a merge base. It is still
   delivered on `/client/pending`, where D1 holds it as a conflict.

Time plays no part. `createdAt` cannot order these rows: the in-memory store
re-stamps it on every push (`create-server.ts:679`, `storage.ts:469`), while
Neon keeps the first-insert time because the upsert omits `created_at`
(`neon-storage.ts:400-406`). A time rule would pass tests and differ in
production.

**Revisions on the hosted tools.** Today hosted `project_get` returns bare
Markdown (`mcp.ts:657-660`) and hosted `project_update` takes no
`expected_revision` (schema at `mcp.ts:796-813`). Hosted `project_get` adds the head's
revision (in `structuredContent` and one trailing line of text).
`project_update` accepts `expected_revision`. When it is present and not the
head's id, the call refuses with `stale_project` wording that matches the local
tool ("Project changed after it was read.") and returns the current document.
Whether it is required is a question for Jay (section 8).

**Every cloud write gets a new revision.** Today an update over a pending head
rewrites the same row id (`mcp.ts:915`, `:930`), so two sessions that both read
it would share one revision and `expected_revision` could not tell them apart.
Instead each update writes a new `conn_<uuid>` row that carries the prior
row's `base_revision` forward, and deletes the prior pending working row. On
Neon both statements go in one `sql.transaction` (the pattern at
`neon-storage.ts:432`). An update over `P` writes `base_revision = P.entryId`.
An ack for a row that was replaced in the meantime finds no row and does
nothing (`storage.ts:587`). The replacement then fails D1's base check on the
next sync and is held. That is the safe outcome for a race of seconds.

**Residual.** `memory_list`, `memory_retrieve`, `search` and `fetch` list rows,
not a head, so they still show a stale pending working row next to the pushed
one. Hiding it there too is cheap. Fold it into the build or state it in
KNOWN-LIMITS; the review decides.

**Failure prevented.** Cloud bots reading, and building on, a document the Mac
has already replaced (incident step 3).

### D3. Sync now previews destructive changes and applies only on confirm

**Rule.** The down-sync splits into `planDownSync` (fetch and classify, no vault
write) and `applyDownSync(plan, approved)`. The plan lists added memories
(counts by scope), project documents that would be replaced (fast-forwards
under D1, by project name), memories that would be forgotten (count, scope and
the first line of each), conflicts (by name), held scopes (ADR 0050), and
projects that would arrive from an app. A plan with any replace or forget needs
confirmation. A purely additive plan applies without a prompt, as today.

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
- Phone: until a preview screen exists, the phone applies only the additive part
  and leaves replaces and forgets pending with "Review on your Mac" (section 8).

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

### D5. Push shared scopes automatically after a local write

**Rule.** A `ConnectorAutoPush` engine beside `AutoSync`
(`packages/sync/src/auto.ts:135`) hooks the same `onVaultSave` signal
(`packages/core/src/vault.ts:161`; the host wiring in
`packages/mcp-server/src/auto-sync.ts:36-45` and the GUI and CLI engines). It
debounces, with the ADR 0044 5 s trailing edge and its max-wait cap
(`auto.ts:123`, `:333-337`). On save it computes a fingerprint over the
`(entry_id, entry_hash)` of every live entry in the shared scopes. It calls
`pushSharedScopes` only when the fingerprint differs from the one recorded at
the last accepted push. That fingerprint goes into `connector.json` next to
`last_pushed_at` (`packages/sync/src/connector-config.ts:86-90`). It pushes
only. It never down-syncs, never marks a scope, and runs only while the vault is
unlocked. A 402, 409 or 412 pauses it the way `AutoSync` pauses
(`auto.ts:27-39`), and the Cloud screen says so.

Hosts: the GUI server, the standalone MCP server, and the CLI (flushed on exit,
like `packages/cli/src/autoPush.ts`). The phone is out of this ADR.

**Invariant #1 analysis.** What leaves the machine does not change. The
recipient and the scopes are the same, and so is the content: only content in
scopes the user individually marked Shared goes, under clause (b). **When** it
leaves changes. Today it leaves on a deliberate action. After D5 it leaves
within seconds of any write into a shared scope. The share consent already
describes a continuing copy: "Memories in '<scope>' will be copied to
NorthKeep's connector server", which "can always see ... when they change"
(`shareCmd.ts:96-100`). So D5 brings the behavior into line with what the user
consented to. Under invariant #2 the connector learns the edit cadence of
shared scopes more finely (timestamps are already visible to it).

**Toggle.** Recommend **on by default**, with a Cloud screen switch "Keep Cloud
Connect up to date automatically". Why: the consent text already promises it; a
stale connector is what made the incident possible; and the switch covers the
user who wants to review before each push. This is a default only Jay can set
(section 8).

**Failure prevented.** The multi-day drift window in which every cloud write
lands on an old base.

### D6. A manual pull reports what would drop out, and asks

**Rule.** `pullVault` already opens the downloaded vault with the key before the
swap (`client.ts:431`). A dry pass (`pullVault({ dryRun: true })`) downloads,
verifies and opens it, then compares:
- entries live on this device whose id does not exist at all in the pulled vault
  ("only on this device"), with counts by scope and the first line of each;
- projects whose local head id is absent from the pulled vault (a local version
  that would drop out of the live vault), by name.

No prompt runs while the sync or file lock is held (`client.ts:388`, `:403`).
After confirmation the real pull runs with the `expectLocalSha` measured in the
dry pass (`client.ts:417-419`), so a write in between refuses with
`LocalChangedError` rather than being lost. An empty drop set pulls without a
prompt. The automatic fast-forward pull asserts an empty drop set and refuses
otherwise (defense in depth, `auto.ts:24-27`).

**Surfaces.** `northkeep sync pull` prompts, or takes `--yes`. `POST
/api/sync/pull` (`apps/web/src/api.ts:821-830`) returns the report with 409
unless `confirm: true`. The Mac dialog needs a mock. It names
`vault.nkv.bak` as where the dropped items stay recoverable.

**Merge stays out of scope.** The vault is a hash chain checked by
`verifyChain`. Re-appending local-only memories onto the pulled vault is
feasible, because they would be new appends with new ids. But local-only
project heads are the same fast-forward-or-conflict problem as D1, across two
whole vaults. Report first; a "re-apply dropped memories" command can follow in
its own ADR once the report shows how often it happens (**unverified** how
often).

**Failure prevented.** A diverged pull silently discarding this device's newer
work.

## 4. KNOWN-LIMITS changes (ship under the review gate)

- Replace "Stale-base last-writer-wins per section" (M14 section) with the D2
  rule. A hosted update with a stale `expected_revision` is refused. Without
  one, the write merges into the connector's head, and the device holds it as a
  conflict if the device moved.
- Add: "A cloud project update is applied on a device only when that device's
  document is still the one the cloud update started from; otherwise it waits
  as a conflict you resolve." Add the phone line: "The phone holds conflicts;
  resolve them on the Mac."
- Replace "Cloud Connect's copy updates only when you push" (added in
  `7a7780f`) with the D5 behavior and the switch.
- Replace "A manual Pull replaces the local vault" with the D6 report and
  confirmation. Keep the `.bak` sentence.
- Add: restore works only for the newest five revisions (ADR 0051).
- Add: old clients (before this ADR) receive no cloud project updates until they
  upgrade (rollout gate, section 6).
- The D2 residual on the generic tools, if it is not fixed in the build.

## 5. Tests

Real Postgres for every storage change (RULES Engineering #3). The in-memory
store and Neon already disagree on `created_at`.

- **Incident replay (regression).** Temp `NORTHKEEP_HOME`,
  `NORTHKEEP_NO_KEYCHAIN=1`, and an in-process connector
  (`createConnectorServer` with `InMemoryConnectorStorage`, as in
  `packages/sync/test/connector-fold.test.ts`), then the same against Postgres.
  Share `project:a` and push revision R1. A cloud `project_update` produces a
  pending row with base R1. Save locally to R2 without pushing. Run the
  down-sync. Assert these literals: the head is still R2 with R2's text, one
  conflict names `project:a` with base R1 and local R2, and the row is still
  pending. Then take theirs: the head's text is the cloud text and R2 is in
  history. A second copy uses keep mine: the head is R2 and the server has no
  pending row.
- **Fast-forward still works.** Same setup without the local save: applied,
  acked, and the row renamed to the new head id.
- **Legacy row.** A pending row with no `base_revision` is held. A v1 client
  (no base support declared) receives no project working rows.
- **D2 ordering.** Push R2 after a pending row based on R1: `project_get` returns
  R2 with its revision. `project_update` with `expected_revision=R1` refuses
  `stale_project` and returns R2. Two successive updates get distinct revisions,
  and the second carries the first's base.
- **D3.** A preview writes nothing: the vault file hash is unchanged (the
  `adr-0054-acceptance.sh` step 4 pattern). A row that arrives between preview
  and apply stays pending. Non-TTY without `--yes` exits non-zero and changes
  nothing.
- **D4.** Restore of the newest superseded revision gives head text equal to it.
  Stale `expected_revision` refuses. A blanked revision refuses with the plain
  message.
- **D5.** A write in a shared scope pushes once after the debounce. A write in a
  private scope pushes nothing (fingerprint unchanged). Nothing runs while
  locked, and a 412 pauses the engine.
- **D6.** Diverge two temp vaults. The dry pull lists the local-only memory and
  project by name. A write between the dry pass and confirm refuses with
  `LocalChangedError`. The automatic pull refuses a non-empty drop set.

## 6. Rollout and migration

Pushing `main` deploys the connector (production). Each step needs Jay's yes.

1. **Connector first.** It adds the column, records `base_revision` on every
   new cloud write, applies the D2 ordering, and adds `expected_revision` and
   `/client/discard`. `/client/pending` withholds pending `working` rows in
   project scopes from clients that do not send `?v=2`. Today's clients
   (0.22.x desktop and CLI, every phone build in the field) apply those rows
   blind (`connector-client.ts:366-374`). This gate is the only protection they
   get, because phones update only through EAS builds Jay approves.
2. **Backfill existing pending rows once.** For a legacy pending working row in
   a scope with exactly one pushed working row `P`, set `base_revision =
   P.entryId` only if `P` existed before the row (Neon `created_at` is the first
   push, so it can be compared). Otherwise leave it absent, which D1 holds as a
   conflict. The backfill is safe even when the guess is wrong. D1 still
   compares against the device's own head, so a guessed base only fast-forwards
   when the device has not moved since `P`, which means the cloud write really
   is newer. Whether any pending rows remain on the founder's account after the
   2026-09-30 Sync now (which acked what it applied) is **unverified**. A
   read-only count before the deploy settles it.
3. **Desktop and CLI release** with D1, D3, D4, D5 and D6, sending `?v=2`.
4. **Phone build** with D1 and the additive-only down-sync, batched with other
   mobile work.

## 7. Review scope

The whole ADR is under the review gate:
- **Who decides / what wins**: D1, D2 and D3 change which document wins and
  when the human decides.
- **Egress timing**: D5.
- **Published claims**: the KNOWN-LIMITS edits.

The adversarial review should attack, against code:
- **D1**: the id-space seam at ack (rename, replaced rows, a crash between save
  and ack), the dedupe narrowing, and the multiple-live-head case.
- **D2**: the atomic replace-and-delete on Neon, and concurrent updates from two
  apps.
- **D3**: the approve-by-server-id rule against rows that change between
  preview and apply.
- **D5**: the fingerprint against scope marks arriving through vault sync, an
  unshare racing a debounced push (the 412 tombstone path,
  `connector-client.ts:186-192`), and the lock.
- **D6**: the window between the dry pass and the swap.

Run the incident replay as an executed attack, not a reading.

## 8. Open questions for Jay

1. Should hosted `project_update` **require** `expected_revision`, as the local
   tools do (`vault.ts:907`)? Required stops two cloud sessions overwriting each
   other, but every cloud bot that does not send it gets refused until its
   instructions change. Optional still gets D1's protection on the device.
2. **Keep mine**: delete the cloud version, or save it first as a memory in the
   project scope (visible to your cloud apps)?
3. **Auto-push default**: on, with a switch (recommended), or off?
4. **Phone** until its preview screen exists: additive-only (recommended), or
   hold every down-sync on the phone?

## 9. Acceptance (Jay, from the CLI; built with the feature)

A script in the `scripts/adr-0054-acceptance.sh` pattern,
`scripts/adr-0063-acceptance.sh`, run from the repository root after
`pnpm -r build`. It uses `NORTHKEEP_HOME=/tmp/nk-0063-acceptance/home`,
`NORTHKEEP_NO_KEYCHAIN=1` and a local in-memory connector on a loopback port,
and it refuses any other home. One step per call:

```
bash scripts/adr-0063-acceptance.sh setup     # temp vault, local connector, share project:demo, push
bash scripts/adr-0063-acceptance.sh 1         # a cloud update, then a local save: the incident
node packages/cli/dist/index.js share sync    # expect: "1 conflict: demo" and the plan; answer n
bash scripts/adr-0063-acceptance.sh 2         # prints the local head: still the local save
node packages/cli/dist/index.js share resolve demo --take-theirs
bash scripts/adr-0063-acceptance.sh 3         # head is the cloud text; history holds the local save
node packages/cli/dist/index.js projects restore demo <revision from step 3> --yes
bash scripts/adr-0063-acceptance.sh 4         # head is the local save again; stale restore refused
bash scripts/adr-0063-acceptance.sh 5         # diverged pull: the report names what drops out
bash scripts/adr-0063-acceptance.sh cleanup
```

The `share` and `projects` commands above need the same environment the script
exports, so the script prints them with it. The exact wording is fixed when the
script is written.

## Adversarial review

Not yet run. Findings go here, dated, with the binding amendments applied to the
body above.
