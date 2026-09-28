# ADR 0062: Remember operation ids past compaction (an operation ledger on the live project document)

- **Date:** 2026-09-28
- **Status:** Proposed. Design only. First review CLEARED WITH WOUNDS;
  this revision is the author's fix round, awaiting recheck. No product
  code has been written for it.
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
The first review measured the rest: from six updates on, the copy is
blanked too (six, seven, eight, eleven and twelve were run).

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
`readProjectOperations(entry, id)`, returns the well-formed records in
order and reports whether any malformed record carries `id` (Decision 6).

A malformed record **carries the id** exactly when it is an element of the
ledger array, is not well formed, and either:

- is a string equal to the request's `operation_id`, or
- is a non-array object with an own `operation_id` property (checked with
  `Object.hasOwn`) whose value is a string equal to the request's
  `operation_id`.

Equality is exact, code unit for code unit. The request id has already
passed the lowercase vault.ts:836 regex, so an uppercase copy of it never
carries it. A ledger value that is not an array has no elements and so
carries no id; `null`, numbers, booleans and nested arrays inside the
array carry none either. Every other malformed element is ignored.

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
That is detection after the fact, not a check at the point of decision:
`checkpointProject` does not call `verifyChain`, so a tampered ledger is
acted on first and reported by the next `list`, export or compaction.
Receipts behave the same way today.

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

In general a compacted vault refuses where an uncompacted vault would
refuse, and writes nothing where it would write nothing. It does not
always give the same code. The first review measured every difference
against an uncompacted baseline:

- **Verbatim retry after blanking.** Compacted: `stale_project` with the
  current document. Uncompacted: `replayed`. Residual 5.
- **Resend after a rename (`rescope`).** Sending X for the old slug gets
  `operation_conflict` where an uncompacted vault answers `not_found`,
  because the ledger rode to the renamed head. Both refuse and neither
  writes.
- **Forgetting only the head.** After `memory_forget` of a project's live
  head (or the phone's forget) and a recreate, a resend of a blanked id is
  written where an uncompacted vault refuses. Residual 3.

Everything else the review ran (plain updates, generic edits and folds,
manual compaction keeping one to five, log roll-over, cross-project,
import) matched the uncompacted answer.

| Situation | Code | Message | Current document |
|---|---|---|---|
| Ledger hit, same project, same fingerprint | `stale_project` | "This save was already applied and has since been compacted, so it cannot be replayed. Read the project again; send any new save with a new operation id." | yes |
| Ledger hit, different fingerprint (the F1 resend: its fingerprint includes the new `expected_revision`) | `operation_conflict` | "Operation id was already used for a different project request." (the vault.ts:866 wording) | no |
| Ledger hit on another project's head | `operation_conflict` | the same | no |
| Malformed ledger record carrying this id | `operation_conflict` | "Malformed project operation record." | no |

`stale_project` carries the current document, fetched the way vault.ts:871
does. An F1 resend writes nothing and adds no Log line.

A blanked save can get one of two `stale_project` messages for the same
fact. When its own revision was blanked, it gets the message above. When
its revision is still live and only its base was blanked, the unchanged
matches branch answers with the existing vault.ts:871 message ("This save
was already applied, and the version it started from has since been
compacted, so it cannot be replayed. ..."). Both are correct; the build
does not merge them, and T2 pins both.

### 5. The storage-free carry-forward fix

Saves made by old code have no ledger record, so the copied-receipt route
still needs its own answer. When `matches` is empty, no ledger record
carries the id, and `copied` is non-empty:

- A copy counts as proof the save landed only when the copy's row is in
  the request's own scope, and `getEntry(copy.raw.result_id)` exists, is
  in that same scope, and has `forgotten_at` set.
- If every copy qualifies, compare each copy's `request_fingerprint` with
  the request's fingerprint. All equal: `stale_project` with the current
  document, the Decision 4 message. Any different: `operation_conflict`
  "Operation id was already used for a different project request."
- If any copy does not qualify (in another scope, or its original is
  missing or not forgotten): keep today's `operation_conflict` "Operation
  receipt metadata exists without its original result."

This refines the PLAN's line, which answers `stale_project` for any
same-scope copy. The fingerprint check is deliberate. Without it the F1
resend through this route would get `stale_project`, while an uncompacted
vault answers `operation_conflict`. The copy already holds the
fingerprint, so the check costs nothing.

With code from this ADR, the ledger answers first in practice: X's record
rides onto the edited revision through the `supersedeEntry` deep copy.
Decision 5 therefore only runs for saves written by old code.

Its window is narrow. In the recipe above the copy itself is blanked from
six updates on, so Decision 5 answers at exactly one count, five (measured
by the first review on both the new code and a v0.22.0-written vault).
From six on, the save falls into Residual 1.

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
  the exploration, and re-executed by the first review). Their
  `writeProject` deep-copies the ledger forward without appending, and
  their `supersedeEntry` does the same. No rollout gate is needed. They do
  not read the ledger, so a resend they handle is not checked against it
  (Residual 1).
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
355 KB against the sync server's 4 MB cap. Blanked rows hold none. The
first review measured the bound over 400 seeded mixed operations: at most
eight live rows in one scope, and a largest ledger of 2,957 bytes.

The eight-row bound assumes 0.22 compaction. A pre-0.22 device (0.21 has
no compaction but carries metadata in `supersedeEntry`) leaves the ledger
on every revision it writes until a 0.22 device compacts. An edit that
changes a head's type away from `working` leaves a row that is never a
project head again and keeps its ledger until blanked. The lookup ignores
both (it reads only live `working` heads), so this affects size only. Not
executed; recorded from the first review's reading.

## Residuals (documented, not closed)

1. **Saves made by, or resends handled by, old code are not checked.**
   - *Made by.* A checkpoint or wrap written by 0.22.1 or earlier has no
     ledger record. Once its revision is blanked, resending its id against
     the new head is written again, as today. A verbatim retry is still
     refused (`stale_project`, because its `expected_revision` is no
     longer the head), and a copied receipt still answers through
     Decision 5 at the one count where the copy survives.
   - *Handled by.* A 0.22.0 or 0.22.1 core never reads the ledger. A
     resend that reaches one is checked only against receipts, even for a
     save the new code recorded. Measured by the first review: the new
     code records X, compaction blanks X's revision, the new code refuses
     the resend at the head, and the same vault opened by the v0.22.0 core
     writes the resend ("Did X." twice, older Status and Next Actions back
     on top). This covers a second, un-updated Mac on the same synced
     vault, and an MCP server or CLI older than the desktop.

   Both halves close as old devices update. The first cannot be
   backfilled, because the ids of already-blanked saves are gone.
2. **Ids older than the newest 16 are forgotten.** A resend of the 17th
   newest checkpoint or wrap id of a project, after its revision was
   blanked, is written again.
3. **A deleted or head-forgotten project forgets its ids.** Deleting a
   project, or forgetting only its live head (`memory_forget`, or the
   phone's forget), removes its ledger from the lookup. Superseded
   revisions not yet blanked still carry the ledger, but the lookup reads
   only live heads, so it is not consulted.
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
> `operation_conflict` and writes nothing, when the resend reaches
> NorthKeep 0.22.2 or later and the app's connection can see that
> project. Three gaps remain. A save made by NorthKeep 0.22.1 or earlier
> is not recorded, and a resend handled by NorthKeep 0.22.1 or earlier
> (for example on a second Mac that has not updated) is never checked
> against the recorded ids; in either case, once the save's revision is
> blanked, resending its id against the new head is saved again
> (duplicate Log line, older Status and Next Actions back on top). An id
> older than its project's newest 16 checkpoint or wrap saves is
> forgotten the same way, and so are the ids of a project that was
> deleted or whose live document was forgotten. Use a new operation id
> for every new save.

**ADR 0051, "Correction, 2026-09-24"**:

- In the first retries bullet, "Fixed together with F1 in 0.22.1."
  becomes "Fixed together with F1 in 0.22.2 (ADR 0062): a verbatim retry
  through this route now answers `stale_project` with the current
  document, and a changed request `operation_conflict`."
- The "Accepted scar tissue (F1)" bullet gains a closing paragraph:
  "Fixed in 0.22.2 by ADR 0062 for saves made by 0.22.2 or later and
  resends handled by 0.22.2 or later. The note
  above that the fix changes what a forgotten row may carry was wrong: ADR
  0062 keeps the ids of each project's newest 16 checkpoint or wrap saves
  on the live project document instead, so forgotten rows and
  `verifyChain` are unchanged and un-updated devices keep working. Saves
  made by older versions are not recorded, and resends handled by older
  versions are not checked (ADR 0062, Residuals)."

## Claims and the tests that prove them

| # | Claim | Enforced by (at 3202785, function) | Test |
|---|---|---|---|
| C1 | Resending a blanked checkpoint's id against the current head is refused as `operation_conflict` and writes nothing | new ledger lookup in `checkpointProject`, replacing vault.ts:861-878 | T1 |
| C2 | A verbatim retry of a blanked save answers `stale_project` with the current document: the Decision 4 message when its own revision was blanked, the vault.ts:871 message when only its base was | same; matches branch vault.ts:871 (unchanged) | T2 |
| C3 | A verbatim retry of the newest save still replays | lookup after the matches branch, vault.ts:862 | T3 |
| C4 | The carry-forward route answers `stale_project` for a verbatim retry and `operation_conflict` for a changed request, with and without a ledger record | ledger lookup; Decision 5 replacing vault.ts:861 | T4a, T4b |
| C5 | An id used on project A and sent to project B is refused as `operation_conflict`, blanked or not | ledger lookup across visible heads; matches branch vault.ts:866 | T5 |
| C6 | The ledger holds exactly the newest 16 checkpoint or wrap ids of its project, in order, and `verifyChain` passes after every write | append in `writeProject` after vault.ts:905 | T6 |
| C7 | `project_update` and generic edits carry the ledger forward unchanged | deep copy in `writeProject` vault.ts:903, `supersedeEntry` vault.ts:1416 | T6 |
| C8 | Blanked rows never carry the ledger | `keptProvenanceMetadata` vault.ts:1982 (unchanged) | T6, T7 |
| C9 | A vault written by this code opens, verifies, exports and compacts on the v0.22.0 core, which carries the ledger forward | nothing on forgotten rows; `verifyChain` vault.ts:1841 unchanged | T7 |
| C10 | A malformed record carrying the request's id (a bare string equal to it, or an object whose own `operation_id` equals it, per Decision 1) refuses as `operation_conflict` | `readProjectOperations` in project-handoff.ts | T8 |
| C14 | A checkpoint on a 30-project vault is at most 20 percent slower than trunk | one-pass scan, Decision 3 step 1 | perf gate (Acceptance) |
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
  changed after it was read.", so only the message separates them. A
  second case (guard) keeps X's revision live and blanks only its base:
  checkpoint X on base B, checkpoint Z on X's result, one
  `project_update`, then `compactProjectHistory({ keep: 1 })`. Z's kept
  revision's receipt protects X's result, and nothing protects B, so B
  alone is blanked (assert both). Retry X verbatim: expect `stale_project`
  with the vault.ts:871 message, as at trunk, so the two messages stay
  distinct on purpose. (Derived from `planScopeCompaction`, vault.ts:743,
  not yet run.)
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
  only runs for saves old code wrote: the new code records the id of
  every checkpoint or wrap it writes, so no new-code save can reach
  Decision 5 without a ledger record naming it. The test therefore opens a
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
- **T8, malformed record (fail-first).** Both shapes of Decision 1's
  definition, each on its own fresh project head planted with
  `remember()`, then a checkpoint with X:
  - an object record with X and a 10-character fingerprint;
  - a bare string element equal to X.

  Each expects `operation_conflict` "Malformed project operation record."
  and an unchanged head. Guards in the same test: an uppercase copy of X,
  and a non-array object ledger value whose `operation_id` is X, both
  accept the checkpoint (they do not carry the id); a head with a
  malformed record for another id accepts a checkpoint with X. After each
  accepted checkpoint the new ledger holds only X.
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

### Perf gate

The PLAN's P2 perf box is the gate for C14: median `checkpointProject`
time over two hundred interleaved checkpoints per side, trunk measured
first, fail above 20 percent. It uses a vault with many projects, the
PLAN's 30, not a small one. The headroom is thin: the first review's
prototype measured +17 to 18 percent (trunk 6.87 and 6.75 ms, prototype
8.13 and 7.88 ms, two runs) on only 15 projects of 21 revisions plus 3,000
memories. The extra cost is parsing up to eight ledgers per project on
every checkpoint's scan, so it grows with the project count. The fixture
therefore gives every project a full ledger of 16 on all eight rows that
can carry one. If the gate fails, the build stops and returns to Jay; this
ADR does not pre-approve a caching change to pass it.

## Open questions for Jay

1. **Accept residual 1 without a rollout gate?** Saves made by an
   un-updated desktop (0.22.1 or earlier) stay unrecorded, and resends
   handled by an un-updated core (a second Mac, or an older MCP server or
   CLI on the same synced vault) are not checked against the ledger, even
   for saves 0.22.2 recorded. After compaction, such a resend at the new
   head can still double-log, exactly as today. The alternative is a gate that holds the
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
- 2026-09-28, first review
  (`Reviews/release-0.22.2/adr-0062-r1.md`, prototype patch and attack
  scripts in `Reviews/release-0.22.2/adr-0062-r1/`): **CLEARED WITH
  WOUNDS.** Executed against a literal prototype of Decisions 1 to 6 at
  `a672df1`, an uncompacted baseline, and the v0.22.0 core (byte-identical
  core and CLI source). Held: F1 closed for saves the new code handles on
  every path run; v0.22.0 chain, export, compaction and carry-forward in
  both directions; growth bound (8 rows, 2,957 bytes, 0 forgotten rows
  with the key over 400 ops); malformed input, 200,000 junk records, the
  two-process lock; cost +17 to 18 percent. Residuals 1 to 5 re-confirmed.
  - Flesh wound W1: Residual 1, the KNOWN-LIMITS text, the ADR 0051
    addendum and Open Question 1 covered saves *made by* old code but not
    resends *handled by* it. New code recorded X, compaction blanked it,
    and a v0.22.0 core wrote the resend ("Did X." twice).
  - Notes: (1) Decision 4's parity sentence not exact (verbatim retry,
    rename, head-only forget); (2) two `stale_project` messages for one
    fact; (3) KNOWN-LIMITS' "deleted project" narrower than Residual 3;
    (4) the carry-forward copy is blanked at six updates, so Decision 5
    covers one count; (5) "carries the id" undefined for a malformed
    record; (6) tampering detected after the decision, not at it; (7) perf
    headroom thin, gate needs many projects; (8) the eight-row bound
    assumes 0.22 compaction; (9) T4b wording false as written; (10) the
    CLI acceptance steps not run.
- 2026-09-28, author fix round (this revision; design only, no code):
  - W1: "or handled by" added to Residual 1 (now two halves, with the
    measured case), the KNOWN-LIMITS text (the refusal is now claimed only
    when the resend reaches 0.22.2 or later), the ADR 0051 addendum, Open
    Question 1, and the Decision 7 compatibility bullet.
  - Note 1: Decision 4's opening restated. It claims refusal parity, not
    code parity, and lists the three measured exceptions.
  - Note 2: both messages described in Decision 4; C2 and T2 pin both,
    with a recipe for the base-only case (derived, not yet run). The
    review cites the existing message at vault.ts:372; at `3202785` it is
    vault.ts:871, in `checkpointProject`.
  - Note 3: Residual 3 and the KNOWN-LIMITS text now name forgetting the
    live head, not only deleting the project.
  - Note 4: the unprobed six-to-eleven gap in Context replaced with the
    measurement; Decision 5 states its one-count window.
  - Note 5: Decision 1 defines "carries the id" (a bare string element, or
    an object element with an own `operation_id`, exactly equal to the
    request id; a non-array ledger value carries none). This refuses the
    bare-string shape, which the prototype wrote past. C10 and T8 pin both
    shapes and the non-carrying guards.
  - Note 6: Decision 2 says tampering is detected after the decision, as
    with receipts.
  - Note 7: new Perf gate section and claim C14. The gate uses the PLAN's
    30-project vault with full ledgers, and cites the prototype's +17 to
    18 percent on 15 projects.
  - Note 8: recorded in Size (size only, not executed).
  - Note 9: T4b reworded to the intended claim.
  - Note 10: noted. The acceptance script is built with the code; the
    recheck reruns the review's scripts against the product build.
  - Also from the review's method: Decision 5's multi-copy rule made
    explicit (every copy must qualify), matching the charitable reading
    the review tested.
