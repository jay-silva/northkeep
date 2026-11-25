# Design record: milestone 6, "Tidies itself" (ADR 0093)

Draft of 2026-11-24, revised 2026-11-25 after review 1 (NOT CLEARED). Design only. No product code was written. Every name here for a new tool, command, table or field is a proposal.

Code references are to main at 32b30bd (the merge of ADR 0085, PR 96) unless a line says otherwise. I read them with `git show 32b30bd:<file>` from the main checkout, which is itself on branch `claude/m3-identical-symbols` (e64d935, PR 97).

## 1. The short version

Milestone 6 in the plan is "Automatic merging, the cold tier, and a list of changes Jay can undo." This revision is smaller than the first draft. Review 1 showed that several parts could not be made true cheaply, so they are cut, not patched.

What milestone 6 now does, with no model:

- Merges exact repeats: two memories in one private scope and type whose texts are equal after lower-casing, collapsing spaces and line breaks, and dropping one final full stop. Nothing else merges.
- Shelves unused private memories ("cold"): a memory in a scope that is not Shared, unused by any AI app on this device for 90 days, stops crowding search. The best cold match is still added to every search that finds one, labelled.
- Leaves every Shared scope alone. Nothing this milestone does changes what the Cloud connector holds.
- Keeps a list of every change, with three device tools: `memory_changes` (show it), `memory_undo` (undo one), and `memory_tidy` (run the daily pass now, or shelve memories the owner named).

What it no longer does: hold instruction-like memories (section 10), anything on the Cloud connector (section 11), label look-alikes or series (ADR 0092 owns them), or list declared replacements (milestone 3 and ADR 0092 own their undo).

## 2. The rules this rests on

From the plan rules agreed in the grill:

- Row 19, "What NorthKeep may change alone": merge near-identical memories keeping the originals, mark a memory replaced when the saving agent names it, move a memory unretrieved for 90 days to cold, hold a memory that reads like an instruction. "Every such change is listed and reversible."
- Row 19, "may never change alone": forget or delete anything, choose between memories that state different facts, or change the confirmed core.
- Row 12: cleanup goes through the agent already in use, "at most once a day ... three questions at most".
- Rows 16 and 17: "Nothing is deleted."

From the lead's shared decisions for ADRs 0092 to 0094 (2026-11-25): decision 3 (the merge rule), 4 (undo is built by ADR 0092), 5 (look-alikes and series belong to ADR 0092), 6 (schema 0.5 to 0.6 is this ADR's), 10 (connector rows reach the vault only when a device pulls), 12 (limits per day across every trigger), 13 (acceptance tests), and C (the hold is cut pending Jay).

## 3. What ADR 0043 decided, and exactly what changes

ADR 0043 (accepted 2026-08-27) is the model-driven memory review. D1: "Zero vault writes during the run." D4: "Apply is a user action. ... No accept-all, auto-apply or scheduled write." Rejected: "Accept-all, auto-apply, scheduled writes: writes without user action."

Milestone 6 changes:

1. D4's last sentence stops being true of NorthKeep as a whole. Proposed wording: "The review pass has no accept-all, auto-apply or scheduled write. Separately, ADR 0093's words-only pass may, without the user, merge exact repeats and move unused private memories to cold, each listed and reversible."
2. The Rejected line narrows the same way: writes without user action stay rejected for anything a model proposed.
3. Links gain "Amended by: ADR 0093".

Nothing else in 0043 changes. Its exact-duplicate finder will find fewer pairs, because this pass merges some first. That goes in the 0043 addendum as a behaviour note.

## 4. What exists today, checked against the code

Each line below I read in the code. "main" means 32b30bd.

| Fact | Where |
|---|---|
| ADR 0085 is built: `checkSave`, `replaces`, `distinct`, `replaceMemory`, `markReplaced` exist. | search-rules.ts:79-108; vault.ts:693-725; server.ts:1011-1116 |
| `markReplaced(oldId, newId)` sets `superseded_at = now`, `superseded_by = newId`. It checks scope, project paperwork and self-replace. It does not check type, confirmed marks, or consolidation lineage. | vault.ts:715-725 |
| Clearing a replaced mark does not exist anywhere. ADR 0092 (milestone 5) builds it (decision 4). | vault.ts, no such method |
| A normal edit (`supersedeEntry`) uses one `now` for the new row's `created_at` and the old row's `superseded_at`. `markReplaced` does not: its `now` is later than the new row's `created_at`. | vault.ts:1680-1745 (1742); vault.ts:722-723 |
| `consolidationHistory` re-checks every restored copy that was later replaced, and throws unless `successor.created_at === entry.superseded_at`. | vault.ts:1340-1366; 1626 |
| Consolidation lineage lives in metadata key `northkeep:consolidation`, on both the consolidated result and each restored copy. | consolidation.ts:33; vault.ts:1218 (result), 1298-1309 (restored copies) |
| Each consolidation stores a hash of every source row as a whole object (`snapshotHash` = hash of `exactCanonicalJson(entry)`), and history re-checks it. `exactCanonicalJson` sorts keys and keeps every key, null values included. | vault.ts:1416-1418; 1584; consolidation.ts:38-70 |
| A memory row is built by spreading every column of the `memories` table into the object. A new column would therefore enter every whole-object hash. | vault.ts:2227-2234 (`...row`) |
| The entry hash covers only fixed fields; bookkeeping such as `superseded_at` is outside it. | vault.ts:2171-2197 |
| Search ranks, then cuts to the limit, in both keyword and by-meaning search. | vault.ts:1779-1780; 1880-1881 |
| Search candidates are live rows inside the grant, minus project paperwork. | vault.ts:1752-1758 |
| `list` and `resolveEditable` both take the grant (`allowedScopes`) and filter by scope. | vault.ts:1906-1935; 1650-1671 |
| A connection's grant is `NORTHKEEP_SCOPES`; unset means full owner access, empty means nothing. | server.ts:114-119 |
| Every device tool call writes a content-free line to `mcp-calls.log` in the NorthKeep folder, with `tool`, `phase`, `ok`, `params.id`, and `result_ids`. The log is only ever appended. | log.ts:11-61, 108-112; platform.ts:19-21 |
| A line with no `phase` (older builds, chat) is a finished call; a `pending` line is not. | log.ts:28-33, 129-150 |
| `memory_retrieve` logs the ids it returned. | server.ts:1003 |
| `memory_list` logs every id it returned; `params.id` is set only for a read of one exact id. | server.ts:1133-1143 |
| A held save logs the ids of the memories it listed, though nothing was read on purpose. | server.ts:1097 |
| The identical-save check runs only in device `memory_remember` (new saves, not `replaces`) and in the connector. Not in `memory_edit`, CLI `remember`, import, or down-sync. | server.ts:1085; connector mcp.ts:585, 590 |
| On main the identical-save test drops every non-letter at word edges after NFKC. PR 97 (e64d935, not on main) narrows it to sentence punctuation and quotation marks after NFC. Both are looser than this ADR's merge rule. | search-rules.ts:68-72 (main); e64d935 search-rules.ts:66-76 |
| The connector push fingerprint and the connector manifest compare only entry id and entry hash. Automatic push is skipped when both match. A flag that changes without a new row is never pushed. | connector-push.ts:91-101, 116-121; connector-auto.ts:303 |
| The connector's `connector_audit` table has the returned ids, but no code reads it, it has no index on account, and nothing prunes it. | neon-storage.ts:123-133, 936-942 |
| The cloud replace path calls `markReplaced` when the owner confirms on a device. A queued cloud replace whose old or new memory is no longer live is acknowledged and dropped. | connector-client.ts:1044-1053 |
| A device `replaces` save compares the new text only with the memory it replaces, not with the rest of the scope. | vault.ts:693-711 |
| `isConfirmed` is true only for `by: "user"`, so it misses decision 1's `by: "chat"` mark. | search-rules.ts:154-157 |
| Every device tool call opens the vault under a file lock and closes it before returning; other apps wait. | server.ts:95-105, 333-345 |
| `memory_remember` and `memory_edit` write the vault file with `vault.save()` inside the tool call. | server.ts:1062, 1108, 1214 |
| Schema is 0.4; each step is a block in `migrate()`; an older build refuses a newer vault. | types.ts:151; vault.ts:378-431 |
| Export lists every memory plus the Shared marks. | vault.ts:2096-2135 (Shared marks at 2133) |
| The Mac app's hand consolidation (ADR 0047) runs through `apps/web/src/curationApi.ts`, which calls `consolidationHistory`, `consolidateMemories` and `restoreConsolidation`. | curationApi.ts:117, 133, 152 |

Stale text removed from the first draft: "ADR 0085's save check is not built", "marking one row replaced by another does not exist", and the branch name `claude/adr-0085-revised`.

## 5. Evidence, read honestly

The brief's evidence is that a one-time tidy on the fictional 130-memory bench vault raised an agent's score from 91 to 95 of 100. That tidy was a set of cleaned-up facts an agent wrote as new memories (`tidyMemories` in the bench, source `mcp:curator`). It was not merging or cold. It supports the owner's request for an agent-run cleanup tool. It does not measure this pass. Under the merge rule here, zero pairs merge on that vault.

Time, measured 2026-11-25 in a scratch copy of the two linear steps (not product code, fictional data, Node 24, Apple M5 Pro; script in the session scratchpad `m6-bench/bench.mjs`):

| Step | Size | Time |
|---|---|---|
| Group rows by scope, type and merge form | 500 rows | 1.2 ms |
| Same | 2,000 rows | 3.1 ms |
| Same | 10,000 rows | 14.9 ms |
| Parse and fold call-log lines | 1 MB (1,985 lines) | 2.6 ms |

Not measured: `vault.list()` over the whole vault (a full table read plus parsing each row's metadata). The build must measure it before the budget in section 12 is accepted.

Review 1's figure (checkSave per row: 1.5 s at 500 rows, 6.3 s at 1,000, 26.5 s at 2,000) is the cost of comparing every row with every other row. This design never does that inside a save. Look-alike search, the only step that needs it, is ADR 0092's.

## 6. Merging exact repeats

### The rule (decision 3)

Two live memories A and B merge only when all hold:

1. Same scope and same type, and the scope is not Shared (section 9).
2. Neither is project paperwork (`isProjectPaperwork`, search-rules.ts:169-181), forgotten, or replaced.
3. Neither carries consolidation lineage (metadata key `northkeep:consolidation`).
4. Their merge forms are equal. The merge form of a text: lower-case it (JavaScript `toLowerCase`, the same in every locale), replace every run of spaces, tabs and line breaks with one space, trim both ends, then drop one final "." if there is one.

That is the whole rule. No Unicode folding, no punctuation removal inside the text, no dropped words. It does not reuse `saveNormalForm`: on main that drops every symbol at a word edge after NFKC, and even PR 97's narrower version drops commas, colons and quotation marks. NFKC also folds "m²" into "m2" and full-width digits into plain ones. I did not add NFC: decision 3 does not include it, and without it a pair that differs only in how an accent is stored stays unmerged, which is harmless.

Fresh examples (all fictional). These must merge:

| A | B | Why equal |
|---|---|---|
| Morgan's dentist is Dr. Lena Park at Harbor Dental. | morgan's dentist is dr. lena park at harbor dental | capitals, one final full stop |
| Heron Cabin check-in is 4 pm. | the same words with two spaces after "Cabin" and a line break before "is" | spacing and line breaks |
| Dana Reyes leads the Quarry Road project. | dana reyes leads the quarry road project. | capitals |

These must not merge:

| A | B | What differs |
|---|---|---|
| Morgan's blood type is O+. | Morgan's blood type is O-. | sign |
| The Heron Cabin account balance is -500. | The Heron Cabin account balance is 500. | sign |
| The snow plow fee is $40. | The snow plow fee is €40. | currency |
| Keep the Heron Cabin thermostat > 60. | Keep the Heron Cabin thermostat < 60. | symbol |
| Order a vitamin A refill. | Order a vitamin refill. | a one-letter word |
| Rent at Quarry Road unit 2 is $1,450. | Rent at Quarry Road unit 2 is $1450. | a comma inside a number (same fact; left alone, harmlessly) |
| Pack snacks, maps, etc.. | Pack snacks, maps, etc. | only one final full stop is dropped |
| Dana pays Morgan. | Morgan pays Dana. | order |
| "Trash pickup is Thursday." in `personal` | the same text in `work` | scope |
| "Call the plumber before noon." as semantic | the same text as procedural | type |
| "Riley's school pickup is at 3:15." in a Shared scope | the same text in the same Shared scope | Shared scopes are left alone |

A known residual of lower-casing: "Pay Bill $40." and "pay bill $40." would merge, though one may mean a person. The merge keeps both rows, lists the change, and is undone in one call. KNOWN-LIMITS says so.

### Which one survives

- A row with any `confirmed` mark, user or chat (decision 1's `{by: "chat"}` included), is never merged away. The new code tests for any object under the `confirmed` key, not `isConfirmed`, which is true only for `by: "user"` (search-rules.ts:154-157).
- If a group has exactly one marked row, it survives.
- If a group has two or more marked rows, the group is left alone.
- Otherwise the newest row survives (latest `created_at`, then latest insertion). Newest keeps the id an agent most likely just received.

### Where the duplicates come from

The identical-save check already stops a new exact repeat at `memory_remember` and on the connector, and its test is looser than this rule, so it catches every pair this rule would merge. Exact repeats therefore arrive only by routes that skip it: `memory_edit` (an edit that turns one memory into a copy of another), `memory_remember` with `replaces` (it compares only with the memory it replaces, vault.ts:693-711), CLI `remember`, imports, down-sync of connector rows, two devices saving before they sync, and rows saved before ADR 0085. The pass handles those that land in private scopes. Rows born on the connector live in Shared scopes, so they never merge in this milestone (decision 10: no background pull is added). The acceptance seed writes through the core library directly for this reason.

## 7. What a merge writes, and how it is undone

A new core step, proposed `mergeExactRepeats(survivorId, memberIds)`. It is not `markReplaced`, because `markReplaced` lacks the type, confirmed and consolidation checks. Inside one transaction it re-checks every rule in section 6 for every row (so the checks live in the core, not only in the pass), then sets `superseded_at = now` and `superseded_by = survivor` on each member, and writes one change row (section 11). Nothing is copied; no text changes; the hash chain is untouched because those two fields are outside the hash (vault.ts:2171-2197).

Why the consolidation check sits in the core step: a restored consolidation copy that is later marked replaced with a `superseded_at` later than its successor's `created_at` makes `consolidationHistory` throw (vault.ts:1626). Excluding lineage rows on both sides of a merge means that can never happen through this step.

After a merge the members behave like any replaced memory: out of search and lists, present in history and in export. Merges never happen in a Shared scope, so the connector's copy never changes because of this pass. Had they been allowed, a cloud replace queued against a merged-away row would have been acknowledged and silently dropped at the next pull (connector-client.ts:1046-1050).

Undo uses ADR 0092's step that clears a replaced mark (decision 4). For each member it clears the mark only if the member is not forgotten and still points at the survivor named in the change row. The change row records the undo, and the pass never merges a row that an undone merge restored. If ADR 0092's step is not built, milestone 6 does not ship.

## 8. Cold: unused private memories step aside

### What counts as use

The pass folds new lines of this device's call log into a vault table, `memory_use` (memory id, last-used time, taken from the line's `ts`). Times, not days: a day would make a search and a shelve on the same day look simultaneous. A line counts only if `ok` is true and `phase` is `done` or missing (a line with no phase is a finished call from an older build or from chat, log.ts:28-33, 129-150); a `pending` line never counts. And:

- `tool` is `memory_retrieve`: every id in `result_ids`, except the appended cold row described below;
- `tool` is `memory_list` with `params.id` set: that id.

Nothing else counts: a plain `memory_list` (it returns up to 100 rows and would keep everything warm), a held save's list of near matches (server.ts:1097), writes, and project tools. The owner's own searches in the Mac app and the terminal do not write the call log, so they do not count either.

A per-device marker file in the NorthKeep folder, proposed `tidy-log-offset.json`, records how far the log has been folded. The marker stops at the last complete line (the last newline), so a line another process is still appending is read next time, not skipped. If the log is now shorter than the marker (deleted or replaced), folding restarts at the beginning. The vault records the timestamp of the first line ever folded (`tidy_use_since`). A dry run reads the log but moves no marker and writes nothing.

### When a memory goes cold

All of these must hold:

1. Its scope is not Shared. A Shared memory never goes cold: cloud apps use it through the connector, and the device cannot see that use cheaply (section 9). This is a read rule: search treats a cold mark in a Shared scope as warm, so sharing a scope later needs no write, and the next pass removes those marks and lists them as "came back".
2. No `confirmed` mark of either kind (rule 19).
3. Not project paperwork, and no consolidation lineage.
4. Type is not identity or procedural (standing rules and who the person is; proposed, Jay's question 4).
5. 90 days have passed since the latest of: its `created_at`, its last-used time, and the time a cold move of it was undone.
6. The use record covers 90 days: `tidy_use_since` is at least 90 days ago.
7. This pass's fold reached the end of the log. If it stopped early (section 12), use since the stopping point is unknown, so this pass moves nothing to cold.

### Where cold is stored

In its own vault table, `memory_cold` (memory id, time it went cold, change id). Not a column on `memories`. A memory row is built by spreading every column (vault.ts:2227-2234), and each saved consolidation holds a whole-object hash of its sources that history re-checks (vault.ts:1416-1418, 1584). That hash keeps every key, null values included (consolidation.ts:38-80), so even an empty new column would change the object for every row and make every saved consolidation fail its check (vault.ts:1584), which would break the Mac app's consolidation screen (curationApi.ts:117).

### What cold does in search

On the device only (`memory_retrieve`, keyword and by-meaning). Ranking is unchanged: the same candidates, the same word weights. After sorting (vault.ts:1779-1780, 1880-1881), warm rows fill the result up to the limit, and then the best-ranked cold row that matched, if any, is added as one extra row. It carries a separate field, proposed `cold: {since, last_used}`, never text in its content (decision 8).

The guarantee, stated exactly: a search that matches any cold memory always returns the best-ranked one of them, labelled. A second cold match is not returned. The first draft's claim that "a question whose only answer is a cold memory still gets it" was false and is withdrawn.

`memory_list` still shows cold memories with the same field. Nothing is hidden from a browse.

### Coming back

- A cold memory comes back only when a counted log line naming it has a `ts` later than the time it went cold. A search that found the ids an agent then shelved is earlier than the shelve, so it does not undo the shelve.
- The appended cold row is recorded in a new call-log field, proposed `cold_appended_id`. The fold skips that id, unless it was the only row the search returned. So a cold memory comes back when it is the sole answer to a search, when it is read by id, when it is edited or confirmed (both write a new row, which starts warm), or when its change is undone. It does not come back just because it was appended beside warm answers; on a large vault nearly every search would do that, and cold would undo itself.
- The disclosure ledger stays whole: the appended id is still in `result_ids`.
- Coming back is a change row (kind "came back"). It is not capped.

### Limits of cold

- Use is counted only from AI apps on the device that runs the pass. On a second Mac, use is folded only when that Mac runs a pass, which needs a save there. A memory used only on that Mac can go cold until then; it is still appended to searches there, and comes back as above.
- If no save happens on a device for weeks, nothing is folded or tidied on it. The 90-day clock is not hurt by waiting.

## 9. Cut: anything in Shared scopes

The first draft sent a `cold` flag to the connector, added a route returning connector use, and merged in Shared scopes. All three are cut:

- A cold mark changes no entry id or hash. The push fingerprint and the connector manifest compare only id and hash, and automatic push is skipped when both match (connector-push.ts:91-101, 116-121; connector-auto.ts:303). The flag would never be sent unless something else changed.
- A use route needs new code reading `connector_audit`, which has no reader, no index on account and no pruning (neon-storage.ts:123-133), plus a new hosted route (a production deploy) and a fold that runs only when a device pulls (decision 10).
- A merge in a Shared scope would remove a row a cloud app may hold by id, and a cloud replace queued against it would be dropped without a word (connector-client.ts:1046-1050).

Leaving Shared scopes alone closes review wound W5 by construction and leaves the connector untouched. Decision 10, stated: no background pull is added, and nothing in this milestone waits on one.

## 10. Cut pending Jay's word: holding instruction-like memories

Rule 19 allows NorthKeep to hold a memory that reads like an instruction. The first draft did it with a fixed list of word patterns. Review 1 built that list and tested it: it held 10 of 12 honest standing rules, and missed 4 of 4 reworded attacks. It also did not protect cloud apps: a memory saved through the connector stays readable there until a device pulls it, and only the Mac app's sync route and the command line's share command pull. Hiding a held memory from every read path (near-match replies, replaces, type-only edits, list by id, connector push, conversation retrieval) would add guards across the code for a check that catches little.

So milestone 6 has no hold. Rule 19's hold stays a plan item for Jay to keep, drop, or move to a later milestone (question 2 under "Decisions waiting for Jay"). Agents treat stored text as data, which today's instructions already say.

## 11. The list of changes, and the tools

### Where it is stored

A new vault table, `tidy_changes`. One row per change: a short change id, the time, the kind (merge, cold, shelve, came back), the scope, the memory ids, who did it ("NorthKeep", or the app's tamed handshake name for a shelve), the reason (the rule and its numbers), and, once undone, when and by which app. No memory text. It is exported with the vault (a new `tidy` section beside `shared_scopes`, vault.ts:2133, holding the changes, the cold rows and the use days) and travels inside the encrypted vault file. No pruning.

### Grants on every tool

Every tool below runs through the existing `run()` wrapper with the connection's grant (server.ts:114-119):

- `memory_changes` returns only change rows whose scope is in the grant. Others are neither shown nor counted.
- `memory_undo` on a change outside the grant answers exactly as for a change id that does not exist.
- `memory_tidy` resolves each id to shelve with `resolveEditable(id, granted)` (vault.ts:1650-1671), so an out-of-grant id answers exactly as a missing one. Under a grant it never starts a pass.
- A save from a connection with a grant never starts a pass (section 12), so a scoped app never causes changes outside its scopes, and no pass result ever appears in any save reply, `result_ids` or `disclosed_scopes`.
- A connection with an empty grant gets an empty list and can start nothing.

### Device tools

- `memory_changes`: newest first, up to 25 per call, with a `before` change id for the next page. Each entry: change id, kind, time, who, scope, memory ids, `saved_text` (a one-line excerpt of each memory, flattened to one line, at most 120 characters, through return masking), and whether it can be undone. NorthKeep's own words go in a separate `note` field, never mixed with saved text (decision 8).
- `memory_undo`: takes one change id. Undoes a merge (section 7), a cold move or a shelve (deletes the cold row and records the undo time, so its 90 days restart). Records which app asked. A second undo of the same change does nothing and says so. "Came back" rows cannot be undone; they are already the warm state.
- `memory_tidy`: the tool the owner asked for on 2026-11-24. It takes no free text. With no arguments, it runs the pass now if none has run in the last 24 hours (section 12), and returns what changed. With `shelve: [ids]` (at most 25), it moves those memories to cold on the owner's word, each listed with the app's name. Each id is checked on its own: one in a Shared scope, a confirmed memory, project paperwork, a consolidation row, an identity or procedural memory, or a memory already cold is refused with a one-line reason, and the rest are shelved. Either way it acts at most once a day per account (section 12, limit 3).

An agent is told in the tool description to shelve only memories the person named. That is advisory, like `memory_forget` today; the shelve is listed and undone in one call.

### In the terminal

`northkeep tidy` (run a pass now, with no time budget), `northkeep tidy --dry-run` (say what a pass would do, write nothing), `northkeep tidy changes`, and `northkeep tidy undo <change>`. No Mac app screen in this milestone.

### Cut: connector tools

The first draft offered `memory_changes` and a queued `memory_undo` to cloud apps. Both are cut. They needed change records inside the push envelope, a new undo queue on the connector, a new protocol version and a hosted deploy, for a list that would have nothing in it: this milestone changes nothing in Shared scopes. Jay's question 8 below.

### How the four real-vault cases now come out

| Seen in the real vault | What happens |
|---|---|
| Old imported note with a wrong year, corrected later | Not merged (different text). Replaced if the newer save named it (ADR 0085). Otherwise ADR 0092's question. |
| A job title one agent doubted | Not touched. ADR 0092's conflict question. |
| Long AI session notes crowding results | They are retrieved, so they stay warm. Already ranked last after 30 days (ADR 0084 D8). The owner can tell an agent to shelve them with `memory_tidy`. |
| Nine near-identical build notes | Never merged (they differ by a number). ADR 0092 owns series. Cold when unused in a private scope; shelved on the owner's word. |

## 12. When it runs, the limits, and the time budget

### Triggers

- A device save that writes a new row: `memory_remember` (a new memory or a replace) and `memory_edit`, from a connection with no grant. Not an identical save (`already_saved`), not a held save, not an edit that changed nothing. The pass runs after the tool's own write and before its `vault.save()` (server.ts:1062, 1108, 1214), so it adds no file write and no extra sync push.
- An agent's `memory_tidy`.
- The owner's `northkeep tidy`.
- Never on a read, never on a timer, never on a pull.

### Limits, per rolling 24 hours, across every trigger (decision 12)

A "day" is the 24 hours before now. No time zones.

1. At most 50 memories taken out of service, counted from `tidy_changes` rows in the window: each memory merged away counts one (a group of three counts two), each cold move one, each shelved memory one. Undo and "came back" rows are not counted. Merges go first, oldest group first, then cold moves, oldest first.
2. At most one pass started by a save or by `memory_tidy`, counted from the vault's `tidy_last_attempt_at`, which records every attempt, including one that failed or ran out of time. A time in the future counts as within the window. The owner's `northkeep tidy` may start a pass at any time; its changes still count toward the 50.
3. An agent's `memory_tidy` that acts (runs a pass, or shelves at least one memory) takes ADR 0092's daily cleanup sitting (0092 design record, section 8): the same "set if not already set" claim, in the same place (the connector's ration route when the connector is on, the vault otherwise) and for the same calendar day. If the sitting is already taken that day, by any app or by an earlier `memory_tidy`, or the claim cannot be made, `memory_tidy` does nothing and says so. A call that would change nothing takes nothing. So an acting `memory_tidy` happens at most once a day, and on that day ADR 0092 offers no cleanup questions. Shared decision 12 says the call "counts against the day's three questions"; ADR 0092 counts a sitting, not single questions, so this is the closest true reading.

### The time budget inside a save

A save holds the vault file lock, so other apps wait. What runs inside it is linear only:

1. Read the live rows (`vault.list()`).
2. Group them by scope, type and merge form (section 6).
3. Fold at most 1 MB of new call-log lines.
4. Choose cold moves and comebacks.

The budget is 250 ms for steps 1 to 4, checked before anything is written. If it runs out, the pass writes nothing, records the attempt, and does not retry until the window has passed. The writes themselves are bounded: at most 50 change rows plus the use rows from 1 MB of log.

What runs only on request: the owner's `northkeep tidy` has no budget and folds the whole log, however large. An agent's `memory_tidy` has the same 250 ms budget as a save; when it runs out, the reply says the vault is too large to tidy inside an app call and names `northkeep tidy`. Anything that compares every row with every other row is not part of this design.

### A failing pass never fails the save

The pass runs in its own transaction inside a try block, after the save's own write. Any error rolls back the pass's writes only. The attempt is still recorded (a separate statement; if even that fails, it is ignored), and the save's call-log line gains a field, proposed `tidy: "ran" | "skipped" | "over_time" | "failed"`. The save then completes and replies exactly as it does today.

## 13. Schema step and ownership

- Schema 0.5 to 0.6 (decision 6; ADR 0092 takes 0.4 to 0.5). The step adds three tables, `tidy_changes`, `memory_use`, `memory_cold`, and two vault meta keys, `tidy_use_since` and `tidy_last_attempt_at`. It changes nothing on `memories`.
- An older build refuses the newer vault (vault.ts:424-428). The Mac app, CLI, MCP server and phone app all need the new build before any device migrates. The connector needs no change.
- Milestone 6 depends on ADR 0092 for the clear-replaced step (decision 4), the daily sitting, and the 0.5 schema. It is built after milestone 5.
- Look-alikes and series belong to ADR 0092 (decision 5). This design labels and hands over nothing.

## 14. Where this meets the other milestones

- Milestone 3 (ADR 0085): its identical-save check stops new exact repeats at the door; this pass handles the ones that arrived by other routes. Declared replacements are not listed here.
- Milestone 4: "quiet" for the import, and "cold" here, are both ways a live memory stops being served. Recommend milestone 4 store its state in its own table too, for the reason in section 8.
- Milestone 5 (ADR 0092): owns look-alikes, series, conflict questions, the daily ration, and the clear-replaced step. This design uses the last two.

## 15. Costs, risks, and docs to change

- Review gate: this changes who decides (NorthKeep writes without the user) and adds a surface that shows memory text to agents (the change list). What leaves the machine: the device app receives change rows and one-line excerpts of memories it can already read, which it may pass to its model provider as it does any tool reply; an acting `memory_tidy` makes ADR 0092's sitting claim, which goes to the connector when it is on and carries no content. The connector's stored copy does not change.
- Docs in the same work: SPEC/memory-schema.md (three tables, the export's `tidy` section), KNOWN-LIMITS.md (below), the ADR 0043 addendum, ADR 0084 D3 (device search appends one cold row).
- KNOWN-LIMITS lines to add: merging catches only exact repeats, and lower-casing can merge two texts that differ only in capitals; nothing in a Shared scope is merged or goes cold; only AI-app use on the device that runs the pass counts, and the owner's own searches do not; a cold memory shown beside warm answers stays cold; nothing is tidied on a device that saves nothing; `memory_tidy`'s shelve is advisory to the agent, like `memory_forget`.

## 16. Acceptance test (decision 13)

Runnable by an agent with no AI app in the loop, on a throwaway vault, with today's shell hook (each command that names the CLI carries `NORTHKEEP_HOME` pointing at a temp folder). No switch in shipped code: "tomorrow" is made by the test helper replacing `Date` inside its own process only. Built with the milestone, after the pattern of `scripts/milestones-k1-acceptance.sh` and `scripts/adr-0054-mcp.mjs`:

- `scripts/m6-acceptance.sh <step>`: fixed home `/tmp/nk-m6-acceptance/home`; runs the CLI as `node packages/cli/dist/index.js`, never a `northkeep` on PATH.
- `scripts/m6-mcp.mjs [--day N] [--scopes a,b] <tool> '<json>'`: one in-process MCP call as app `m6-acceptance-app`. It refuses any other home. `--scopes` sets `NORTHKEEP_SCOPES`; without it the variable is deleted. `--day N` moves the clock N days ahead before the server loads. It sets `NORTHKEEP_OLLAMA_URL` to a closed local port (librarian ollama.ts:21), so search is keyword-only and the same on every machine; each `memory_retrieve` reply then says `search_mode: "keyword"`. It replaces `@KEY` in its input with seeded ids, and `@merge:KEY` and `@cold:KEY` with the change id naming that memory, found by an unscoped read of the change list before the call itself, so a scoped call can name a change it cannot see. It prints seeded ids as `@KEY`. Mode `history` prints `vault.consolidationHistory().length` or the error.
- `scripts/m6-at.mjs N <cli args>`: runs the CLI in-process with the clock N days ahead.
- `scripts/m6-seed.mjs`: writes through the core library, so no save check runs, with the clock moved back per row, and writes a fictional call log whose lines have `phase: "done"` and `ok: true` unless the seed table says otherwise.

Every step is run as `NORTHKEEP_HOME=/tmp/nk-m6-acceptance/home bash scripts/m6-acceptance.sh <step>`.

### The seed (fictional)

All `personal`, semantic, written by `mcp:claude-code`, unless said. "Age" is days before day 0.

| Key | Age | Notes | Text |
|---|---|---|---|
| M1a / M1b | 40 / 5 | M1b by `mcp:cursor` | Morgan's dentist is Dr. Lena Park at Harbor Dental. / morgan's dentist is dr. lena park at harbor dental |
| M2a / M2b | 30 / 3 | | Heron Cabin check-in is 4 pm. / the same with two spaces after "Cabin" and a line break before "is" |
| M3a / M3b | 60 / 2 | `work`; M3a user-confirmed by the owner | Dana Reyes leads the Quarry Road project. / dana reyes leads the quarry road project. |
| N1 to N7 (a, b) | 20 | | the seven "must not merge" pairs of section 6, rows 1 to 7 |
| N8 a / b | 20 | `personal` / `work` | Trash pickup is Thursday. |
| N9 a / b | 20 | both user-confirmed | The gate code changes every May. |
| N10 a / b | 20 | semantic / procedural | Call the plumber before noon. |
| K1 | 50 | consolidated from "Riley likes kayaking." and "Riley likes kayaking on weekends.", then restored | restored copies of both |
| K1x | 1 | | riley likes kayaking. |
| E1 | 130 | never used | The Heron Cabin snow plow contractor is Birch Hill Plowing. |
| E6 | 130 | never used | The Heron Cabin wifi router is in the hall closet. |
| E2 | 130 | retrieved 10 days ago | Heron Cabin trash pickup is Thursday morning. |
| E3 | 130 | user-confirmed | Morgan is allergic to shellfish. |
| E4 | 130 | identity | Morgan prefers to be called Mo. |
| E5 | 130 | scope `family`, marked Shared | Riley's school pickup is at 3:15. |
| S1a / S1b | 20 / 2 | scope `family`, marked Shared | Riley's soccer practice is on Tuesday. (both, word for word) |
| E7 | 130 | used 30 days ago, by a log line with no `phase` | The spare shed key is under the blue pot. |
| F1 to F60 | 120 | never used | Garden note N: the north bed got compost. |

Call log, fictional: a `memory_retrieve` line 125 days ago returning nothing (so use is recorded for over 90 days); a `memory_retrieve` line 10 days ago returning E2; a `memory_retrieve` line 30 days ago with no `phase` field, returning E7; a plain `memory_list` line 20 days ago returning F1 to F60; a held `memory_remember` line 15 days ago listing E1.

Cold candidates on day 0: E1, E6, F1 to F60 (62). Merge groups: 3.

### Steps

Step `setup`. Removes `/tmp/nk-m6-acceptance`, runs `init`, runs the seed. Pass: prints the seeded count and `history` prints 1.

Step 1, dry run writes nothing. `at 0 tidy --dry-run`, then `nk tidy changes`, then `ls /tmp/nk-m6-acceptance/home`. Pass: the dry run names 3 merges (M1a into M1b, M2a into M2b, M3b into M3a) and 47 cold moves; the list says no changes; there is no `tidy-log-offset.json`. On main: no `tidy` command.

Step 2, the pass rides a save, and the cap. `app memory_remember '{"content":"Sam'"'"'s library card renews in March.","type":"semantic"}'`, then `app memory_changes '{}'` (two pages), then `nk list --scope personal` and `nk list --scope family`. Pass, all of:
- The save reply has `stored` and no other new field.
- The last `memory_remember` line in `mcp-calls.log` has `"tidy":"ran"`.
- Exactly 50 change rows: the 3 merges above and 47 cold moves, E1 and E6 among them.
- M1a, M2a and M3b are gone from the list; every N, K1 and K1x row in `personal` is listed; S1a and S1b are both listed; E2, E3, E4, E5, E7, S1a and S1b have no change row; F46 to F60 are not cold.
On main: `memory_changes` is an unknown tool.

Step 3, the daily limit. `app memory_remember '{"content":"Sam'"'"'s bike lock is in the shed.","type":"semantic"}'`, then `app memory_changes '{}'`, then `app memory_tidy '{}'`. Pass: still exactly 50 change rows; the save's log line has `"tidy":"skipped"`; `memory_tidy` says a pass ran within 24 hours, names when the next may run, changes nothing, and takes no sitting.

Step 4, cold in search. `app memory_retrieve '{"query":"where is the Heron Cabin wifi router"}'`, then `app memory_retrieve '{"query":"Birch Hill Plowing"}'`. Pass: the first returns warm rows and, last, E6 with a `cold` field; its log line has `cold_appended_id` set to E6. The second returns only E1, with a `cold` field, and its log line has no `cold_appended_id`. On main: E6 comes first with no `cold` field.

Step 5, the next day; an identical save starts nothing; came back. `app --day 1 memory_remember '{"content":"Sam'"'"'s library card renews in March.","type":"semantic"}'`, then `app --day 1 memory_changes '{}'`, then `app --day 1 memory_remember '{"content":"Sam'"'"'s piano lesson moved to Friday.","type":"semantic"}'`, then `app --day 1 memory_changes '{}'`. Pass: the first reply has `already_saved: true` and the list is unchanged; after the second save the list has a "came back" row for E1, 15 cold rows (F46 to F60), and nothing for E6.

Step 6, undo. `app --day 1 memory_undo '{"change":"@merge:M1a"}'` twice, `app --day 1 memory_undo '{"change":"@cold:E6"}'`, `app --day 1 memory_retrieve '{"query":"where is the Heron Cabin wifi router"}'`, then `app --day 2 memory_remember '{"content":"Sam'"'"'s soccer cleats are size 5.","type":"semantic"}'` and `app --day 2 memory_changes '{}'`. Pass: M1a is live with its original id and date; the second undo says it was already undone and adds no row; E6 comes first with no `cold` field; the day-2 pass merges nothing and moves E6 nowhere.

Step 7, grants. `app --day 3 --scopes work memory_changes '{}'`; `app --day 3 --scopes work memory_undo '{"change":"@cold:F1"}'` and the same with a well-formed id that does not exist; `app --day 3 --scopes work memory_tidy '{"shelve":["@N1a"]}'`; `app --day 3 --scopes work memory_remember '{"content":"Quarry Road kickoff is on the 14th.","type":"semantic","scope":"work"}'`, then `app --day 3 memory_changes '{}'`. Pass: the scoped list shows only the M3 merge; the two undo replies are the same text; the shelve answers as for a missing id and takes no sitting; the scoped save's log line has no `tidy` field and no new change rows appear.

Step 8, shelving on the owner's word, once a day. `app --day 4 memory_retrieve '{"query":"Morgan blood type"}'` (the agent finds the ids), then `app --day 4 memory_tidy '{"shelve":["@N1a","@E5","@E3","@E4"]}'`, then `app --day 4 memory_tidy '{"shelve":["@N1b"]}'`. Pass: the search results include N1a and N1b; in the first `memory_tidy` reply N1a is shelved with `m6-acceptance-app` as who, E5 is refused (Shared scope), E3 is refused (confirmed), E4 is refused (identity); the second reply says today's cleanup sitting is taken, and N1b stays warm.

Step 9, a failing pass does not fail the save. Replace `/tmp/nk-m6-acceptance/home/tidy-log-offset.json` with a directory, then `app --day 5 memory_remember '{"content":"Sam'"'"'s rain jacket is in the car.","type":"semantic"}'`, `nk list --scope personal`, `app --day 5 memory_changes '{}'`. Pass: the reply has `stored` with an id; the memory is listed; no change row is newer than day 4; the save's log line has `"tidy":"failed"`.

Step 10, a search before a shelve does not undo it. Put the marker file back, then `app --day 6 memory_remember '{"content":"Sam'"'"'s hiking boots need new laces.","type":"semantic"}'` and `app --day 6 memory_changes '{}'`. Pass: the save's log line has `"tidy":"ran"`; there is no "came back" row for N1a, though step 8's search returned it the same day, before the shelve.

Step 11, nothing broken, nothing lost. `app history`; `nk export > /tmp/nk-m6-acceptance/export.json`, then a plain `node -e` that prints the number of memories, of tidy changes, and of undone changes. Pass: history prints 1 with no error; the export holds every row the test ever wrote, including replaced ones, and the change list with its 2 undone entries.

Steps 1 to 10 each fail on today's main. Step 11 guards consolidation history and export against this milestone.

## 17. What I did not verify

- Nothing here was run against product code; the tools do not exist.
- The time figures in section 5 come from my own copy of two steps. `vault.list()` cost is unmeasured.
- How whole-file vault sync resolves two devices that each ran a pass before syncing. KNOWN-LIMITS says sync replaces the whole file (line 91); I did not test a divergence.
- The phone app and Mac app code beyond `curationApi.ts`.
- That ADR 0092's revised clear-replaced step and its daily sitting keep the shapes this design assumes. I read the 0092 draft in the same clone on 2026-11-25: one sitting per account per calendar day, claimed by "set if not already set", on the connector when it is on (section 8 of its record). ADR 0092 is being revised at the same time.
- The real vault. I opened none.

## 18. Found in shipped code while revising

These are reports, not designs.

1. A cloud replace can break consolidation history. If a scope holding a restored consolidation copy is later Shared, a cloud app can ask to replace that copy; when the owner confirms on a device, `markReplaced` runs (connector-client.ts:1053), sets `superseded_at` later than the new row's `created_at` (vault.ts:722-723), and `consolidationHistory` then throws (vault.ts:1626), which breaks the Mac app's consolidation screen. Found by reading, not executed.
2. The lead's decisions describe PR 97's narrower `saveNormalForm` as a fact. On main 32b30bd it is not merged: main still drops every non-letter at word edges after NFKC (search-rules.ts:68-72).

## Review 1 (2026-11-25): NOT CLEARED

| Finding | What the revision changed |
|---|---|
| K1: the merge rule (runs of letters and digits, a/an/the dropped) merged O+/O-, -500/500, $/EUR, < and >, "vitamin A"/"vitamin". | Rule replaced by decision 3: equal after lower-casing, collapsing whitespace and one final full stop; no Unicode folding; not `saveNormalForm`. Fresh must and must-not pairs in section 6, all in the test seed. The old A1/A2 seed pair no longer merges and was replaced. |
| W1: a held memory saved through the connector stays readable by cloud apps until a device pulls. | The hold is cut (section 10). |
| W2: "held, no agent sees it" named no layer; many read paths would leak it. | The hold is cut. |
| W3: the patterns held 10 of 12 honest rules and missed 4 of 4 reworded attacks; no phone release path. | The hold is cut, with these numbers in section 10 and Jay's question 2. |
| W4: "a question whose only answer is cold still gets it" was false. | The best cold match is always appended, labelled in a separate field; the claim is restated exactly; an appended row does not count as use unless it was the only result, so cold does not undo itself. |
| W5: a memory used only by cloud apps could go cold. | Nothing in a Shared scope is merged or goes cold; for cold this is a read rule. Connector use and the cold flag are cut; the push fingerprint would not have carried the flag (section 9). |
| W6: merging a restored consolidation copy makes `consolidationHistory` throw (vault.ts:1626). | Rows with consolidation lineage are skipped for merge and cold, checked in the new core step itself, not only in the pass. Test step 10 checks history. |
| W7: new tools stated no grant rule. | Section 11: every tool filters by grant; out-of-grant ids answer as missing; scoped saves start no pass; pass results never reach a save reply. Test step 7. |
| W8: ration and cap were per pass, bypassable by `memory_tidy`. | Rolling 24 hours across every trigger: 50 memories out of service, one automatic pass; an agent's acting `memory_tidy` takes ADR 0092's daily sitting, so it acts at most once a day. Test steps 2, 3, 8. |
| W9: look-alikes and series fell between 0092 and 0093; both claimed schema 0.4 to 0.5. | ADR 0092 owns look-alikes and series; this design labels nothing. Schema here is 0.5 to 0.6, adding tables only. |
| W10: the test did not exercise the pass riding a save, the daily limit, the cap, grants, undo or the connector fold. | Rewritten (section 16): each step names the exact call and result and fails on main. The connector fold is cut, so it is not tested. |
| W11: no time budget inside the save lock. | Section 12: linear steps only, a 250 ms budget checked before writing, at most 1 MB of log per pass; over budget writes nothing and does not retry that day; `northkeep tidy` has no budget. |
| Note: 0085 called unbuilt; `markReplaced` exists; clearing the mark does not. | Stale text removed; section 4 states each with its line; undo waits for ADR 0092's step. |
| New, found in revision | A `cold_at` column would break saved consolidations, so cold has its own table (section 8). `markReplaced` lacks type, confirmed and lineage checks, so merging uses a new guarded step (section 7). A merge in a Shared scope would silently drop a queued cloud replace, so Shared scopes are left alone (section 9). Use is kept as times, not days, so a same-day search cannot undo a shelve; log lines with no phase count (section 8). A shipped hole in the cloud replace path (section 18). |

Review 1's owner questions map to "Decisions waiting for Jay": (1) to 1, (2) and (3) and (4) to 2, (5) to 3, (6) to 7, (7) to 6, (8) to 9. (9), fixing the shipped identical-save check, is PR 97.

## Decisions waiting for Jay

1. Should NorthKeep merge two memories on its own only when they are word-for-word the same, apart from capital letters, spacing and one final full stop? Recommend yes. Yes: as designed. No: nothing merges on its own in milestone 6; any looser rule needs its own design and review.
2. Should the hold on memories that read like instructions to an AI stay out of milestone 6? Recommend yes: in testing it held 10 of 12 honest rules, missed 4 of 4 reworded attacks, and does nothing for cloud apps. Yes: as designed. No: milestone 6 grows by the hold, with a check on cloud saves, a guard on every read path and a release step, and goes back for review.
3. Should NorthKeep leave memories in Shared collections completely alone in milestone 6 (no merging, no shelving)? Recommend yes. Yes: as designed. No: merging there means a replace a cloud app asked for can be dropped without a word, and shelving there needs a connector change, a new hosted route and a push change; that is a separate design.
4. Should standing rules (how you like things done) and facts about who you are never be shelved as cold? Recommend yes. Yes: as designed. No: they go cold like other memories after 90 unused days.
5. Is 50 memories a day the right limit for what NorthKeep merges away or shelves? Recommend yes. Yes: as designed. No: only the number changes.
6. May an AI app on your Mac shelve memories you named, listed with its name and undone in one step? Recommend yes. Yes: as designed. No: `memory_tidy` has no shelve; it only runs the daily pass.
7. When an AI app asks NorthKeep to tidy, should that use up the day's cleanup sitting, so no cleanup questions are asked that day? Recommend yes. Yes: as designed. No: `memory_tidy` is limited only by one pass a day and the 50 changes.
8. Should cloud apps get the change list and undo in this milestone? Recommend no. No: as designed; you or an AI app on your Mac undo. Yes: it needs a connector deploy, a new protocol version and an undo queue that waits for you; a separate design.
9. Should NorthKeep leave hand-consolidated memories alone? Recommend yes. Yes: as designed. No: not possible in milestone 6 without first changing how consolidation history checks its links.

## Agreed across ADRs 0092, 0093 and 0094 (lead, 2026-11-25)
The three records were revised side by side. Where they touched the same thing, this is the one answer, and it is the same paragraph in all three.
- Build order: milestone 5 (0092), then 6 (0093), then 8 (0094). Schema steps: 0092 takes 0.4 to 0.5, 0093 takes 0.5 to 0.6, 0094 takes none.
- The chat mark on a memory is `confirmed: {by: "chat", app, at}`. ADR 0092 adds an optional `question` id to it; ADR 0094 does not set one. `isConfirmed` keeps meaning `by: "user"` only.
- On the connector path the mark travels as one envelope field, `chat: {app, at}`, present only on a chat-confirmed row. Milestone 5 introduces it together with `writer` and `questions` in pending protocol version 4. Milestone 8 adds nothing to the protocol: it reuses version 4, so it cannot ship before milestone 5.
- The undo for a chat answer is built in milestone 5. No chat mark is written anywhere before it exists.
- The daily ration is one sitting a day of at most three questions, counted across every trigger. An AI app's own tidy request that changes anything uses that day's sitting.
- "Same text" for an automatic merge (0093) is stricter than "identical save" (0085, as narrowed by pull request 97): lower case, collapsed spaces, at most one final full stop.
- Confirming a memory as the user is possible today only from the command line (`confirmMemory` is called only there; KNOWN-LIMITS says the Mac app has no confirm button). Every sentence in these records that says "in NorthKeep itself" or "in the Mac app" about confirming means the command line until a button is built. That gap is question B for Jay.

## Settled by the lead on 2026-11-25 (not Jay's words)
These were listed for Jay and are calls the lead may make: each takes the more careful option and can be changed later without rework.
- Questions 1, 3, 4, 5, 7, 8 and 9: as recommended above. Merge only word-for-word repeats; leave Shared collections alone; never shelve standing rules or facts about who the person is; 50 memories a day; an AI app's tidy request uses the day's sitting; no change list or undo for cloud apps in this milestone; hand-consolidated memories are left alone.
- Question 6: an AI app on the Mac may shelve memories the person named. It is listed and undone in one step, and it is weaker than forgetting, which such an app can already do.
Still Jay's: question 2, cutting the hold on instruction-like memories. The record is written without it.
