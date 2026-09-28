# ADR 0062: Remember operation ids past compaction (an operation ledger on the live project document)

- **Date:** 2026-09-28
- **Status:** Proposed. Design only; awaiting adversarial review. No
  product code has been written for it.
- **Deciders:** Jay (product owner), Claude Code
- **Branch:** `p2/opid-ledger` (base `3202785`)
- **Rules:** `~/Claude/Claude Context/RULES.md`, Version 2026-09-26.2
- **Extends:** ADR 0048 (handoff receipts and operation ids), ADR 0051 and
  its "Correction, 2026-09-24" (compaction, accepted scar tissue F1),
  ADR 0052 (the writer block, the only key a blanked row keeps)
- **Source:** `Reviews/release-0.22.2/opid-design-exploration.md`
  (Candidate A recommended), `Reviews/release-0.22.2/PLAN.md` unit P2
- **Why the review gate applies:** this ADR changes a claim KNOWN-LIMITS
  publishes about what the vault refuses. Under CLAUDE.md a published
  claim ships under the same gate as code. It does not change what leaves
  the machine, who decides, crypto or key handling, or add a dependency.
- **Does not touch:** `verifyChain`, `blankRevisions` and
  `keptProvenanceMetadata`, the schema version, the sync protocol, the
  connector, redaction, the MCP tool text, the phone app.

Line numbers below are at `3202785` and name their function. The build
will shift them.

## Context

### The defect (F1)

ADR 0048 binds an operation id to one exact checkpoint or wrap request.
The binding lives in the handoff receipt (`northkeep_project_handoff_v1`)
on the revision the save produced. ADR 0051 compaction blanks old
revisions, and a blanked row keeps only its writer block
(`keptProvenanceMetadata`, vault.ts:1982). The receipt goes with the text,
so the vault forgets the id.

The damaging sequence: an app checkpoints with id X, later saves blank
X's revision, and the app resends X with `expected_revision` set to the
current head. Nothing in the vault still names X, so the resend is
written as a new save. The Log line appears twice and the old Status and
Next Actions replace the newer ones. Before compaction the same resend
was refused as `operation_conflict`. Jay accepted this for 0.22.0 as scar
tissue (ADR 0051 Correction) with a fix to follow.

### What the code does today (at 3202785)

- `checkpointProject` (vault.ts:831-879) scans every visible entry for a
  receipt carrying the id (vault.ts:852-860). The scan is vault-wide and
  honours `allowedScopes`. An original receipt (its `result_id` is its own
  row) goes to `matches`. A receipt copied forward by a generic edit goes
  to `copied`.
- With copies but no original, it throws `operation_conflict` "Operation
  receipt metadata exists without its original result." (vault.ts:861).
  That throw sits before the matches branch (vault.ts:862).
- With no receipt at all, it calls `writeProject` (vault.ts:878).
- `writeProject` builds the new head's metadata as a deep copy of the old
  head's (vault.ts:903), deletes only the receipt and the writer block
  (vault.ts:904), and writes a fresh receipt (vault.ts:905). Any other key
  rides forward.
- `supersedeEntry` (vault.ts:1416) deep-copies metadata and strips only
  the writer block. `editMemory`, the connector fold
  (packages/sync/src/connector-client.ts:370) and the phone's edit use it.
  This copy is how a receipt ends up on a row that is not its original.
- `verifyChain` (vault.ts:1819) hash-checks live rows, metadata included.
  A forgotten row may carry only null or a lone writer block
  (vault.ts:1841).

### Measured today (at 3202785)

A scratch vitest file in this worktree, run once and not committed:

| Case | Trunk answer |
|---|---|
| Verbatim retry of the newest save | `replayed: true` |
| Checkpoint X, twelve updates, resend X at the head | written; "Did X." twice |
| Same, verbatim retry of X | `stale_project` "Project changed after it was read." with the current document |
| X used on project B while X is still live on A | `operation_conflict` "Operation id was already used for a different project request." |
| X used on project B after X was blanked on A | written |
| Carry-forward route (below), verbatim retry | `operation_conflict` "Operation receipt metadata exists without its original result.", no document |
| Carry-forward route, resend at the head | the same `operation_conflict` |

The carry-forward route reproduces with exactly this recipe: checkpoint
X; `editMemory` the head (copies X's receipt); checkpoint Z against the
edited revision; then exactly five `project_update` saves. Four leaves X's
original unblanked (the copy is inside the newest five and protects it).
Twelve blanks the copy too. Counts between six and eleven were not
probed.

### The premise the fix must respect

The exploration measured, on the v0.22.0 core (the core in iPhone build
28):

- The phone never calls `verifyChain` (`git grep verifyChain v0.22.0 --
  apps/mobile packages/platform-mobile/src` has no matches).
- Un-updated desktops do. A forgotten row carrying a new key makes
  `northkeep list` print CHAIN BROKEN (packages/cli/src/index.ts:286-287),
  refuses export (cli index.ts:326, apps/web/src/api.ts:744) and refuses
  manual compaction (vault.ts:718).
- A new key on a live head passes the old `verifyChain`, is carried
  forward by the old `updateProject`, `checkpointProject` and
  `editMemory`, is stripped cleanly when that row is later blanked,
  appears in `export()`, and survives save and reopen.
- A schema bump would lock out every un-updated device, the phone
  included (vault.ts:396-398).

So the ids cannot live on forgotten rows without breaking old desktops.
They can live on the live head.

## Decisions

### 1. Reserve `northkeep_operations_v1` on live project heads

A new reserved metadata key, exported from `project-handoff.ts` next to
`PROJECT_HANDOFF_METADATA_KEY`:

```ts
export const PROJECT_OPERATIONS_METADATA_KEY = 'northkeep_operations_v1';
export const PROJECT_OPERATIONS_LIMIT = 16;
type ProjectOperationRecord = {
  operation_id: string;        // lowercase RFC 4122 UUID, the vault.ts:836 regex
  request_fingerprint: string; // 64 lowercase hex, the receipt's own fingerprint
  saved_at: string;            // ISO time, equal to the head's created_at
};
// metadata[PROJECT_OPERATIONS_METADATA_KEY]: ProjectOperationRecord[], oldest first
```

A record is well formed only when it is a plain object with exactly those
three keys, the id matches the vault.ts:836 regex, the fingerprint
matches `/^[0-9a-f]{64}$/` (the receipt reader's rule,
project-handoff.ts:201), and `Date.parse(saved_at)` is finite. One reader,
`readProjectOperations(entry)`, returns the well-formed records in order
and reports whether any malformed record carries a given id (Decision 6).

The fingerprint is stored in full, not truncated. A truncated copy would
save about 20 percent of the ledger's bytes but needs its own comparison
rule and test. The full value compares byte for byte with the receipt's.

The ledger records no project, mode or base revision. The fingerprint is
the BLAKE2b hash of the canonical request, and that request includes
`vault_id`, `project`, `mode` and `expected_revision` (vault.ts:841-849).
Equal fingerprints therefore mean the same project, mode and base.

### 2. Written only by checkpoint and wrap saves, capped at 16 by count

`writeProject` is the only place a project head's metadata is built, so
the append goes there, in the `handoff !== null` branch, immediately after
the receipt is written (vault.ts:905). `checkpointProject` is its only
caller with a handoff.

- **On a checkpoint or wrap save:** the new ledger is the old head's
  well-formed records, plus `{operation_id, request_fingerprint:
  fingerprint, saved_at: now}`, keeping the last 16. Malformed records and
  a non-array value are dropped at this point, never carried.
- **On a `project_update` save (no handoff):** the deep copy at
  vault.ts:903 carries the ledger forward unchanged. Nothing deletes it at
  vault.ts:904.
- **On a generic edit** (`editMemory`, the connector fold, the phone):
  `supersedeEntry` deep-copies it forward unchanged. No code change.
- **On blanking:** `keptProvenanceMetadata` keeps only the writer block,
  so the ledger is stripped from every blanked row. No code change.
  `verifyChain` needs no change because the key never reaches a forgotten
  row.

Pruning is by count only. There is no clock dependence, so a device with
a wrong clock prunes the same records as any other. 16 is more than twice
the most revisions a project can keep (the newest five plus at most two
receipt-protected, per the ADR 0051 Correction), so an id stays known long
after its revision is blanked.

Because the ledger rides on a live row, it is under the chain hash while
that row is live. Tampering with it breaks `verifyChain` on every desktop.

### 3. Lookup order in `checkpointProject`

The new flow, replacing vault.ts:861-878:

1. **Scan (one pass).** The existing loop at vault.ts:853 also reads the
   ledger of every entry that is `type = 'working'`, has
   `superseded_at` and `forgotten_at` null, and sits in a slug-valid
   `project:*` scope. It collects each record whose `operation_id` equals
   the request's, with that head's scope. The loop already iterates every
   visible entry and honours `allowedScopes`, so no second `list()` runs.
   The 20 percent perf budget in the PLAN depends on this.
2. **Original receipt found.** If `matches` is non-empty, the existing
   branch (vault.ts:862-877) runs unchanged. It replays, refuses as
   `stale_project` when the base was blanked, or refuses as
   `operation_conflict`.
3. **Ledger hit.** Otherwise, if any ledger record carries the id:
   - every hit is on the request's own project head and every hit's
     fingerprint equals the request's: `stale_project` with the current
     document (Decision 4);
   - any other combination: `operation_conflict`.
4. **Copied receipt.** Otherwise, if `copied` is non-empty, apply
   Decision 5.
5. **Fresh id.** Otherwise, call `writeProject`, which records the id.

The ledger must come after the matches branch. The new save records its
own id, so a ledger-first lookup would refuse every legitimate verbatim
replay of the newest save.

### 4. Refusal codes and messages

A compacted vault answers with the code an uncompacted vault would.

| Situation | Code | Message | Current document |
|---|---|---|---|
| Ledger hit, same project, same fingerprint | `stale_project` | "This save was already applied and has since been compacted, so it cannot be replayed. Read the project again; send any new save with a new operation id." | yes |
| Ledger hit, different fingerprint (the F1 resend: its fingerprint includes the new `expected_revision`) | `operation_conflict` | "Operation id was already used for a different project request." (the vault.ts:866 wording) | no |
| Ledger hit on another project's head | `operation_conflict` | the same | no |
| Malformed ledger record carrying this id | `operation_conflict` | "Malformed project operation record." | no |

`stale_project` carries the current document, fetched the way vault.ts:871
does. An F1 resend writes nothing and adds no Log line.

### 5. The storage-free carry-forward fix

Saves made by old code have no ledger record, so the copied-receipt route
still needs its own answer. When `matches` is empty, no ledger record
carries the id, and `copied` is non-empty:

- A copy counts as proof the save landed only when the copy's row is in
  the request's own scope, and `getEntry(copy.raw.result_id)` exists, is
  in that same scope, and has `forgotten_at` set.
- For such a copy, compare `copy.raw.request_fingerprint` with the
  request's fingerprint. Equal: `stale_project` with the current document,
  the Decision 4 message. Different: `operation_conflict` "Operation id
  was already used for a different project request."
- Any other copy (in another scope, or whose original is missing or not
  forgotten): keep today's `operation_conflict` "Operation receipt
  metadata exists without its original result."

This refines the PLAN's line, which answers `stale_project` for any
same-scope copy. The fingerprint check is deliberate. Without it the F1
resend through this route would get `stale_project`, while an uncompacted
vault answers `operation_conflict`. The copy already holds the
fingerprint, so the check costs nothing.

With code from this ADR, the ledger answers first in practice: X's record
rides onto the edited revision through the `supersedeEntry` deep copy.
Decision 5 therefore only runs for saves written by old code.

### 6. Malformed ledgers

Only vault code writes this key. No MCP tool, CLI command or connector
path accepts caller metadata. `remember()` accepts a metadata object, and
its non-test callers that pass one are the two import paths
(packages/cli/src/importCmd.ts:120, apps/web/src/api.ts:1867) and
converse distillation (packages/converse/src/turn.ts:627), which write
fixed conversation keys, the connector fold
(connector-client.ts:376), which writes `{connector: {server_id}}`, and
the memory review restore (packages/librarian/src/reviewSession.ts:226),
which re-creates a forgotten memory with the metadata snapshot the review
report took before the forget. That last one can copy a ledger this vault
wrote onto a new row. Its records keep their ids and fingerprints, so a
lookup against them still answers correctly. A forged or malformed
ledger therefore means someone edited the vault with the key in hand, or
a future writer has a bug. The phone's new-memory screen
(apps/mobile/app/memory/new.tsx:32) passes no metadata. Project import
(`importProject`, vault.ts:619) only creates projects whose scope has no
entries and writes null metadata, so it never replaces a head that holds
a ledger.

- A malformed record that carries the request's id refuses as
  `operation_conflict`. This follows ADR 0048: never silently recreate an
  operation after an identifiable invalid record.
- Other malformed records, and a ledger value that is not an array, are
  ignored on read and dropped on the next checkpoint or wrap save. Failing
  closed on them would block every checkpoint on that project, because a
  `project_update` carries the ledger forward unchanged.
- A forged well-formed record can at worst refuse a save whose id it
  names. Ids are random UUIDs the app generates per save, so a forger
  cannot aim at a future save.

### 7. Compatibility

- **Un-updated desktops (0.22.0, 0.22.1).** The key sits only on live
  rows and blanked rows never carry it, so `verifyChain`, `list`, export
  and manual compaction behave as today (measured on the v0.22.0 core by
  the exploration). Their `writeProject` deep-copies the ledger forward
  without appending, and their `supersedeEntry` does the same. No rollout
  gate is needed.
- **Phones (build 28 and later).** The phone never runs `verifyChain`.
  Its edit path carries the key forward (the same `supersedeEntry`). Its
  memory detail screen prints an entry's metadata as JSON
  (apps/mobile/app/memory/[id].tsx:104-107), so a project head there will
  show the ledger. That is display on the user's own device.
- **Sync.** Whole-vault sync moves the encrypted file, so the ledger
  travels with the rows it sits on. The schema version is unchanged.
- **Connector.** `pushSharedScopes` sends id, hash, scope, type and
  content only (packages/sync/src/connector-client.ts:158-165). The ledger
  never leaves the machine.
- **Models.** `ProjectView` (project-handoff.ts:222) exposes no metadata,
  so no MCP tool returns the ledger.

### 8. Export

`export()` writes every row's metadata as stored (vault.ts `export()`,
`metadata: entry.metadata`). The ledger therefore appears, as readable
JSON, on the live head and on any superseded revision not yet blanked.
Blanked rows export with the writer block only, as today. The Markdown
project export and the mirror (project-export.ts) write document text
only and are unchanged. No JSON re-import path exists in core or the CLI,
so the rebuild half of invariant #4 cannot be exercised for this key or
any other. The ledger is not needed to rebuild anything. It is a retry
guard.

### 9. Tool text is unchanged

server.ts:1067 ("Reuse it only to retry this exact request") and
server.ts:1089-1092 ("use a new operation id" after a stale refusal)
already give the rule. This ADR makes the vault enforce it for the last
16 saves of each project instead of depending on it.

## Size

Measured with `node -e` over a record with a 36-character id, a 64-hex
fingerprint and an ISO time: 182 bytes per record, 2,957 bytes for a full
ledger of 16 including the key. Every revision carries the ledger it was
written with. At most eight rows per project hold one while live (the
head, the newest five superseded, at most two receipt-protected), so at
most about 24 KB per project. Fifteen active projects cost at most about
355 KB against the sync server's 4 MB cap. Blanked rows hold none.

## Residuals (documented, not closed)

1. **Saves made by old code are not recorded.** A checkpoint or wrap
   written by 0.22.1 or earlier has no ledger record. Once its revision is
   blanked, resending its id against the new head is written again, as
   today. A verbatim retry is still refused (`stale_project`, because its
   `expected_revision` is no longer the head), and a copied receipt still
   answers through Decision 5. This closes as old devices update. It
   cannot be backfilled, because the ids of already-blanked saves are gone.
2. **Ids older than the newest 16 are forgotten.** A resend of the 17th
   newest checkpoint or wrap id of a project, after its revision was
   blanked, is written again.
3. **A deleted project forgets its ids.** Forgetting a project's live head
   removes its ledger from the lookup.
4. **Scopes outside a connection's grant stay invisible.** An id used in
   a project the calling connection cannot see is not found, exactly as
   before compaction. This is the ADR 0048 rule ("Callers enforce grants
   before lookup"), not a new gap.
5. **A compacted verbatim retry still gets a refusal, not the original
   receipt.** ADR 0048 says exact retries return the original receipt even
   after later updates. The ADR 0051 Correction already accepted
   `stale_project` for blanked saves. Storing full receipts would roughly
   double the ledger for a case the app handles by reading the project.

## What this ADR does not build

- No change to what a forgotten row may carry, and so no change to
  `verifyChain` on any device.
- No separate table (Candidate B), no ids kept on blanked rows
  (Candidate C), no time window (Candidate D). The exploration's table
  compares them.
- No schema bump and no rollout gate.
- No tool description change and no change to the phone app.
- No backfill of ids already lost.
- No full-receipt replay after compaction.

## Documents after this ships

**KNOWN-LIMITS.md**, in the "A project keeps its newest five revisions"
entry, the text from "A checkpoint or wrap retried unchanged" through
"(ADR 0051 correction)." becomes:

> A checkpoint or wrap retried unchanged after its revision (or its base)
> was blanked is refused as `stale_project` with the current document,
> never applied twice. The vault remembers the operation ids of each
> project's newest 16 checkpoint or wrap saves on the live project
> document (ADR 0062), so resending one of those ids with a different
> request, including against the new head, is refused as
> `operation_conflict` and writes nothing, for any app whose connection
> can see that project. Three gaps remain. A save made
> by NorthKeep 0.22.1 or earlier is not recorded; once its revision is
> blanked, resending its id against the new head is saved again
> (duplicate Log line, older Status and Next Actions back on top). An id
> older than its project's newest 16 checkpoint or wrap saves is
> forgotten the same way, and so are the ids of a deleted project. Use a
> new operation id for every new save.

**ADR 0051, "Correction, 2026-09-24"**:

- In the first retries bullet, "Fixed together with F1 in 0.22.1."
  becomes "Fixed together with F1 in 0.22.2 (ADR 0062): a verbatim retry
  through this route now answers `stale_project` with the current
  document, and a changed request `operation_conflict`."
- The "Accepted scar tissue (F1)" bullet gains a closing paragraph:
  "Fixed in 0.22.2 by ADR 0062 for saves made by 0.22.2 or later. The note
  above that the fix changes what a forgotten row may carry was wrong: ADR
  0062 keeps the ids of each project's newest 16 checkpoint or wrap saves
  on the live project document instead, so forgotten rows and
  `verifyChain` are unchanged and un-updated devices keep working. Saves
  made by older versions are not recorded (ADR 0062, Residuals)."

## Claims and the tests that prove them

| # | Claim | Enforced by (at 3202785, function) | Test |
|---|---|---|---|
| C1 | Resending a blanked checkpoint's id against the current head is refused as `operation_conflict` and writes nothing | new ledger lookup in `checkpointProject`, replacing vault.ts:861-878 | T1 |
| C2 | A verbatim retry of a blanked save answers `stale_project` with the current document and the Decision 4 message | same | T2 |
| C3 | A verbatim retry of the newest save still replays | lookup after the matches branch, vault.ts:862 | T3 |
| C4 | The carry-forward route answers `stale_project` for a verbatim retry and `operation_conflict` for a changed request, with and without a ledger record | ledger lookup; Decision 5 replacing vault.ts:861 | T4a, T4b |
| C5 | An id used on project A and sent to project B is refused as `operation_conflict`, blanked or not | ledger lookup across visible heads; matches branch vault.ts:866 | T5 |
| C6 | The ledger holds exactly the newest 16 checkpoint or wrap ids of its project, in order, and `verifyChain` passes after every write | append in `writeProject` after vault.ts:905 | T6 |
| C7 | `project_update` and generic edits carry the ledger forward unchanged | deep copy in `writeProject` vault.ts:903, `supersedeEntry` vault.ts:1416 | T6 |
| C8 | Blanked rows never carry the ledger | `keptProvenanceMetadata` vault.ts:1982 (unchanged) | T6, T7 |
| C9 | A vault written by this code opens, verifies, exports and compacts on the v0.22.0 core, which carries the ledger forward | nothing on forgotten rows; `verifyChain` vault.ts:1841 unchanged | T7 |
| C10 | A malformed record carrying the request's id refuses as `operation_conflict` | `readProjectOperations` in project-handoff.ts | T8 |
| C11 | An id in a scope outside the grant is not found, as before compaction | scan honours `allowedScopes`, vault.ts:853 | T9 |
| C12 | The ledger never leaves the machine and is never returned to a model | `pushSharedScopes` connector-client.ts:158-165; `ProjectView` project-handoff.ts:222 | code reading; no new path |
| C13 | A full ledger is 2,957 bytes; at most about 24 KB per project | Decision 2 cap | measured with `node -e`; T6 asserts the count |

## Tests

T1 to T6 and T8, T9 go in `packages/core/test/project-compact.test.ts`.
Every helper script below (`make-v0220-fixture.sh`, `old-core-check.sh`,
`acceptance.mjs` when run outside the block below) starts with
`export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1` and
refuses to run if `NORTHKEEP_HOME` is unset or is the user's real home,
so no harness can touch `~/.northkeep`.
Each asserts a literal code and, where the message separates trunk from
head, the literal message. "Fail-first" means the assertion fails at
3202785 (the trunk answer is the measured one above). "Guard" means it
passes at trunk and protects a property this change could break.

- **T1, F1 resend (fail-first).** Checkpoint X, twelve updates, resend X
  with `expected_revision` set to the head. Expect `operation_conflict`,
  the message "Operation id was already used for a different project
  request.", an unchanged head id, and exactly one "Did X." in the
  document. Trunk writes it and shows "Did X." twice.
- **T2, verbatim retry after blanking (fail-first by message).** Same
  setup, resend X unchanged. Expect `stale_project`, a defined `current`,
  and the Decision 4 message. Trunk answers `stale_project` "Project
  changed after it was read.", so only the message separates them.
- **T3, verbatim retry of the newest save (guard).** Expect `replayed:
  true` and the original receipt. Protects the lookup order.
- **T4a, carry-forward with the ledger (fail-first).** The recipe above:
  checkpoint X, `editMemory`, checkpoint Z on the edited revision, exactly
  five updates. Assert X's original is blanked and the copy survives.
  Verbatim X expects `stale_project` with `current`; X at the head expects
  `operation_conflict` "Operation id was already used for a different
  project request.". Trunk answers both with "Operation receipt metadata
  exists without its original result.".
- **T4b, carry-forward without a ledger record (fail-first).** Decision 5
  only runs for saves old code wrote, and no public API of the new code
  writes a project head without the key. The test therefore opens a
  committed fixture vault written by the v0.22.0 core
  (`packages/core/test/fixtures/v0220-carry-forward.nkv`, a synthetic
  passphrase and device secret stored beside it, regenerated by
  `packages/core/test/adr-0062/make-v0220-fixture.sh`). The fixture holds
  checkpoint X, the edit and checkpoint Z. The test makes five updates
  with the new code, then expects the same two answers as T4a. It also
  asserts that no visible ledger names X, so the answer provably came from
  Decision 5.
- **T5, cross-project (fail-first).** Fresh vault, projects A and B.
  Checkpoint X on A, twelve updates on A, then send X to B. Expect
  `operation_conflict` and an unchanged B head. Trunk writes it. A second
  assertion sends X to B before blanking and expects `operation_conflict`
  (guard; trunk agrees).
- **T6, bound (fail-first).** Two hundred saves from a seeded random mix
  of checkpoint, wrap, `project_update` and `editMemory`. After every
  write, assert the head's ledger ids equal the last
  `min(n, 16)` checkpoint or wrap ids in order, as a literal list built by
  the test, that no blanked row carries the key, and that `verifyChain()`
  is ok. Trunk has no ledger, so the first assertion fails.
- **T7, cross-version (guard; cannot fail at trunk, which writes no
  ledger).** Not a vitest case: it needs the v0.22.0 core built from the
  tag. `packages/core/test/adr-0062/old-core-check.sh` adds a
  `git worktree` of v0.22.0 (99523d4) in a temp dir, builds it, and runs
  a script that opens a head-written vault with the old core and asserts
  `verifyChain().ok`, that `export()` contains the key, that
  `compactProjectHistory({ keep: 1 })` succeeds, and that the old
  `updateProject`, `checkpointProject` and `editMemory` carry the ledger
  forward unchanged. It then reopens the file with the head core and
  asserts `verifyChain().ok`. The PLAN's unit box for this runs the
  script; lanes 7 and 8 repeat it through the old CLI.
- **T8, malformed record (fail-first).** `remember()` a project head
  whose ledger holds a record with X and a 10-character fingerprint, then
  checkpoint with X. Expect `operation_conflict` "Malformed project
  operation record.". A second head with a malformed record for another
  id accepts a checkpoint with X, and the new ledger holds only X.
- **T9, grant (guard).** X used and blanked on A; send X to B through
  `checkpointProject(request, ['project:b'])`. Expect a normal write, as
  at trunk. Pins residual 4 so a later change is deliberate.

## Acceptance (Jay, from the CLI)

The CLI has no checkpoint command, so the build adds
`packages/core/test/adr-0062/acceptance.mjs`. It opens the vault in
`$NORTHKEEP_HOME` with the same passphrase and device secret the CLI
uses, runs T1, T2, T3, T4a and T5 against it, and prints one line per
case. Run from the worktree after `pnpm install && pnpm -r build`, in zsh
or bash, in a throwaway home.

```sh
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
export NORTHKEEP_PASSPHRASE='synthetic acceptance passphrase'
nk() { node packages/cli/dist/index.js "$@"; }
nk init
node packages/core/test/adr-0062/acceptance.mjs
```

1. **The new answers.** The script prints:
   ```
   F1 resend: operation_conflict, "Did X." lines: 1
   verbatim retry after compaction: stale_project, current document returned
   verbatim retry of newest: replayed
   carry-forward: stale_project / operation_conflict
   cross-project: operation_conflict
   ```
2. **The chain is clean.** `nk list | tail -1` prints
   `✓ Provenance chain verified.`
3. **The ledger is in the export.** `nk export --out "$NORTHKEEP_HOME/e.json"
   && grep -c northkeep_operations_v1 "$NORTHKEEP_HOME/e.json"` prints a
   number of at least 1.
4. **The released 0.22.0 CLI still reads it.**
   ```sh
   OLD="$(mktemp -d)/nk-0220"
   git worktree add "$OLD" v0.22.0
   (cd "$OLD" && pnpm install --frozen-lockfile && pnpm -r build)
   old() { node "$OLD/packages/cli/dist/index.js" "$@"; }
   old list | tail -1
   old export --out "$NORTHKEEP_HOME/old.json" && grep -c northkeep_operations_v1 "$NORTHKEEP_HOME/old.json"
   old projects compact --keep 1 --yes
   nk list | tail -1
   ```
   Both `list` lines print `✓ Provenance chain verified.`, the old export
   succeeds and contains the key, and the old compaction completes.
5. **Clean up.** `git worktree remove --force "$OLD"` and
   `rm -rf "$NORTHKEEP_HOME"`.

## Open questions for Jay

1. **Accept residual 1 without a rollout gate?** Saves made by an
   un-updated desktop (0.22.1 or earlier) stay unrecorded. After
   compaction, a resend of such a save's id at the new head can still
   double-log, exactly as today. The alternative is a gate that holds the
   fix until every device updates, and the vault cannot know when that
   is. Recommended: accept. KNOWN-LIMITS will publish it (text above).
2. **Sixteen records.** The recommendation is 16 (about 24 KB per project
   at most). Every extra 8 records add about 1.5 KB per row, and up to
   eight rows per project carry the ledger, so up to about 12 KB more per
   project.

## Review history

- 2026-09-28: Proposed from the exploration's Candidate A. The trunk
  behaviour table was measured in this worktree at 3202785 with a scratch
  test that was run once and deleted. The size figures were measured with
  `node -e`. Two corrections to the exploration: the fingerprint is 64 hex,
  not 32, so the ledger is about 24 KB per project at most, not 19 KB; and
  a verbatim retry after blanking is already refused at trunk, so T2
  separates trunk from head only by its message.
