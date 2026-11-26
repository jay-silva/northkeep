# Design record: ADR 0095, Needs your yes

Status: Proposed 2026-11-25 (prerequisite for milestones 5 and 8) · Draft: one review logged, revised 2026-11-25; not yet re-reviewed. Nothing here is built.

Code references are to main at 1089445, read on 2026-11-25 with `git show origin/main:<path>`. PR 98 has since merged (main 66ad784): a pull recognises a row the vault already took in, and the vault keeps the Cloud Connect row ids of forgotten memories (`forgottenConnectorIds`). It changed only vault.ts, connector-client.ts (17 lines added), the MCP server and KNOWN-LIMITS (one line added at 35), so citations in those files may sit a few lines low; client.ts, connector-push.ts, create-server.ts and neon-storage.ts are unchanged. Nothing in this design leans on PR 98. Line numbers can drift; the names are the anchor. Examples are fictional.

## In one screen

- One new phone screen with two sections. "Needs your yes" lists what waits for the person: a cloud app's replace or forget, and, from milestones 5 and 8, a waiting answer or a waiting interview answer. "Accepted lately" lists every chat answer NorthKeep accepted and every Yes given on this phone, each with an Undo where one exists.
- Every line of saved text is read from the phone's own vault, or from the row this sync is about to add, flattened to one line and shown only inside a labelled box. The connector supplies only which ids. What an app reported reads "<app> reported you said".
- Yes and Undo use one path: re-read, refuse if anything changed or the phone lags its sync server, apply exactly one change, save, push the vault. The bulk phone sync stays additions only (ADR 0063).
- No drops the request from the connector's queue: a replace with today's ack, a forget with one new ack field, `keep_forgets`. Not now hides the item on this phone until local midnight.
- Undo of a replace is `clearReplaced(id, expectedBy)`, a new core step built here. A forget has no undo, and the card says so before the tap.
- The fix for the review's main wound: a Mac or the command line acknowledges a cloud replace only after the vault push that carries it has landed. If the push loses, the request stays queued and asks again. What remains: after that push has landed, a phone that saves while behind still wins the vault, and a retired memory can come back without a question.
- Notice: a Review tab in the bottom bar with a red count, and a number on the app icon, both set only while NorthKeep runs. No push service.
- One open question for Jay, with two halves: may the phone tell Cloud Connect itself after a Yes or an Undo and read it when the app opens (so the connector can tell when the phone app is open), and may the phone accept an everyday answer an app reported without a tap (which changes ADR 0063's rule that the phone only adds memories)? Section 6 gives what each person gets under each answer.
- No schema step. No new pending protocol version: the phone moves from version 2 to the existing version 3.

## The problem, and what the owner chose

Things that wait for the user today:
- A cloud app's replacement of a memory (ADR 0085 D4). Approved only in the Mac app's sync review or `northkeep share sync` (KNOWN-LIMITS.md:34).
- A cloud app's forget of a memory. Same review (connector-client.ts:1019-1031 applies only approved forgets).
- Confirming a memory as the user's own. Only `northkeep confirm` (packages/cli/src/index.ts:278-288) calls `confirmMemory`.
- Next: milestone 5's waiting answers and milestone 8's waiting interview answers.

Jay rarely opens the Mac app and never a terminal. The first outside customer works only in cloud AI apps. On 2026-11-24 Jay chose the phone for what waits ("Phone yes"). On 2026-11-25 his hand test passed with Grok Bot and with Muse ("muse asked which one it was as well."), and he wrote: "The easiest thing for Ryan (or me for that matter) is to just answer the agent and then accept that." Everyday chat answers are accepted with no tap; money, ownership, accounts, legal matters, any digit, and work, organizations, advisers, dealings and disputes still wait for him. He looked for this list on his phone that morning; it is not there yet. So the list has two jobs: show what was accepted, with an Undo, and take his Yes on what waits.

The background pull of ADR 0096 is dropped ("Fix the bugs"). Nothing here depends on it. What a cloud app writes reaches a vault only when a device pulls: the Mac app's Sync now, the command line, or the phone.

## What the code does today (checked)

The phone and its vault:
- The phone opens the same vault format with the same core code (`Vault.openWithKey`, apps/mobile/src/lib/vault-session.tsx:346). An older build refuses a newer schema (packages/core/src/vault.ts:438-441). Schema today is 0.4 (packages/core/src/types.ts:151).
- The phone writes the vault as the owner: add, edit and forget (vault-session.tsx:1155-1227). Each saves, then pushes to the sync server (`pushAfterSave`).
- Phone vault sync is last-writer-wins: on a 409 it keeps the server copy as `.conflict.bak` and pushes its own over it (apps/mobile/src/lib/sync-flow.ts:11-31). The phone then says "Another device had also changed this vault. Your edit was kept and pushed; the other device's version was backed up on this phone" (sync-flow.ts:114-115).
- The phone syncs only when open: a wake runs when the app returns to the foreground (vault-session.tsx:1140-1153). KNOWN-LIMITS.md:388: "A phone left in your pocket does not sync until you open it."
- The phone reads Cloud Connect only when the person taps Sync now on the sharing screen (apps/mobile/app/sharing/scopes.tsx:134-136), with `additiveOnly: true` (vault-session.tsx:1424), and pushes only to the sync server afterwards, never to Cloud Connect (vault-session.tsx:1430-1433; KNOWN-LIMITS.md:1483-1491). Sharing a collection on the phone does push to Cloud Connect, and only while the phone's vault file equals the sync server's copy (`phoneVaultStamp`, apps/mobile/src/lib/connect-flow.ts:92-103).
- The vault key needs Face ID or the passphrase (`requireAuthentication: true`, apps/mobile/src/lib/secure-store.ts:60, 72).

What the Mac's automatic pull refuses:
- `computeDropReport` (packages/sync/src/client.ts:581-600) refuses a server copy only when a live row here is missing there, a row forgotten here is live there, or a project head here is missing there. It never looks at `superseded_at` or `superseded_by`. So a server copy in which a memory this Mac marked replaced is live again is pulled without a word. Forgets are different: a forgotten-here, live-there row is a `restored_deletes` entry and the pull refuses.
- A Mac that is behind or diverged does not pull or push on its own (`assertDeviceCanPush`, packages/sync/src/connector-push.ts:48-54; the reasons in connector-auto.ts).

What `additiveOnly` does (ADR 0063's reason):
- ADR 0063 Decision, founder bullet: "the phone applies only additions until it has a preview screen". The phone asks `/client/pending?v=2`, so it never receives the replace queue (connector-client.ts:562-568). Forgets are neither applied nor acked (814-822), queued replaces are deferred (847-852), every approval is ignored (949-951). A test pins this (packages/sync/test/adr0085-cloud-replace.test.ts:175-184).

How a Mac approval is acknowledged today:
- `applyDownSync` saves, then acks additions, settled and approved forgets, and settled and approved replaces in one `POST /client/ack` (connector-client.ts:1066-1075). Its doc comment: "The caller pushes afterwards."
- The callers push afterwards: the Mac app's Sync now (apps/web/src/api.ts:1207 then `manualPush`), and `northkeep share sync` (packages/cli/src/shareCmd.ts:321 then `pushNow`). A manual push sends the vault to the sync server first when the Mac is ahead and refuses the Cloud Connect push if that vault push fails (`manualVaultStamp`, connector-push.ts:63-81, `ConnectorPushBlockedError('moved')` at line 78).
- So today the queue entry is gone before the vault push that carries the mark is known to have landed.

The two queues on the connector:
- `pending_replaces` holds ids and scope (apps/connector-server/src/neon-storage.ts:158-166). The v3 response sends `replace_id, scope, old_id, new_id` (apps/connector-server/src/create-server.ts:1076-1096).
- On every v3 read the connector drops a queued replace whose old or new row is no longer among the shared rows (create-server.ts:1082-1088). So a push of Shared collections that leaves out the replaced memory clears the entry at the next v3 read by any device, with no ack.
- `pending_forgets` holds the entry id and `created_at` only, no scope and no app (neon-storage.ts:101-106). There is no dead-drop for forgets; an entry clears only through an ack, which runs `applyForget` and also deletes the shared row (neon-storage.ts:895-906). There is no way to drop a forget request and keep the memory.
- A queued forget hides the memory from cloud apps at once (apps/connector-server/src/mcp.ts:318).
- Unshare deletes the collection's rows and its queued replaces in one statement (neon-storage.ts:647-680, the replaces at 661), but not its queued forgets.
- The device planner offers a forget for any live memory, whether or not its collection is still Shared here (connector-client.ts:813-829). That is deliberate: a forget a cloud app asked for while the collection was shared stays offered after the unshare, on the Mac today and on this list, and needs a yes like any other (KNOWN-LIMITS.md:35 on 66ad784). A property test pins the reason: "Whether canceled (pending) or queued (delivered), this content must never be a live vault entry after the next down-sync" (apps/connector-server/test/c3-property.test.ts:257). Dropping the request at unshare would break it.

How a change reaches cloud apps when a Mac exists:
- The Mac's vault auto-sync runs inside the Mac app (apps/web/src/session.ts:55) and inside each local MCP server process an AI app starts (packages/mcp-server/src/auto-sync.ts:1-11).
- After auto-sync pushes or pulls, or finds the Mac exactly in sync, the Mac pushes its Shared collections to Cloud Connect when they differ from what the connector holds (packages/sync/src/connector-auto.ts:10-21; on by default, connector-config.ts:118-120). A push removes from the connector every row of those collections the Mac does not hold live (neon-storage.ts:600-610; the default `list` leaves out forgotten and superseded rows).

The vault operations:
- `markReplaced(old, new)` sets `superseded_at` and `superseded_by` in place (vault.ts:729-742). It refuses project paperwork, two scopes, and a restored copy. Nothing clears those two fields again.
- An edit (`supersedeEntry`) and a consolidation (`consolidateMemories`, vault.ts:1204 onward, the UPDATE at 1250) set the same two fields. A consolidation's combined memory carries `metadata[CONSOLIDATION_METADATA_KEY]` (vault.ts:1234-1236). The columns alone cannot tell a mark from an edit.
- `forget` blanks the content and metadata for good (vault.ts:564 onward, the UPDATE at 592-594).
- `confirmMemory` writes a new row with `confirmed: {by: "user", at}` (vault.ts:748-755).
- `superseded_at` and `superseded_by` are outside the row hash (the comment at vault.ts:2185-2190 above `computeEntryHash` at 2196), so clearing them keeps the chain valid.

Notices:
- No notification code or dependency in the phone app (apps/mobile/package.json:22-61). The app ships two local native modules (apps/mobile/modules/nl-tagger, modules/pdf-text).

## 1. The items

Needs your yes:

| Kind | Read from | Built in | Yes does | No does | Undo of Yes |
|---|---|---|---|---|---|
| Replace | connector replace queue, pending v3 | this milestone | `markReplaced(old, new)` | ack `replaces: [id]`; both stay live | `clearReplaced(old, new)` |
| Forget | connector forget queue | this milestone | `forget(id)` as the owner | ack `keep_forgets: [id]`; cloud apps see the memory again | none |
| Pair, waiting | vault `questions` table, kind `pair`, state `waiting` | milestone 5's phone build | 0092's step that applies a waiting record with the user's mark | record state `declined`; no memory changes | 0092's `undoAnswer` |
| Confirm, waiting | vault `questions` table, kind `confirm`, state `waiting` | milestone 8's phone build | `confirmMemory(id)` and record state `applied` | record state `declined` | 0092's `undoAnswer` |

Accepted lately:

| Line | Read from | Undo |
|---|---|---|
| A chat answer NorthKeep accepted | `questions` rows of kind `pair` in state `applied` or `both`, and kind `confirm` in state `applied`, on any device | 0092's `undoAnswer(recordId)`: the retired memory comes back, the mark goes, the record becomes `undone` |
| A Yes given on this phone | the phone's own store (ids, kind, time; never text) | as in the table above; a forget shows "Forgotten. Cannot be undone." |
| An answer undone or declined | the same rows, state `undone` or `declined` | none; shown for the record |

Rules for every item:
- A forget asked for while a collection was shared is listed even if the collection is no longer Shared on this phone (`vault.sharedScopes()`), as the Mac's review lists it; its card says so (section 2; review 1, W3).
- Only memories outside project scopes. Project changes stay in the Mac's review; `listNeedsYes` returns them as one number, `waiting_on_mac`, shown as "N changes to projects wait for your Mac."
- An item names memory ids. The list follows `superseded_by` to the live head, so an app's edit moves the item to the new version instead of making it vanish. A head that is forgotten settles the item. A pair whose two sides reach the same head is settled.
- An item the phone cannot see yet is not shown; an item settled elsewhere drops off at the next refresh.
- A cloud answer recorded on the connector but not yet taken in by a device is not listed. It appears in one section or the other after the pull that accepts it or holds it (ADR 0092 D5).

What 0092 and 0094 provide, and this list reads: one place in the vault, 0092's `questions` table, for everything that waits or was accepted. Kind `pair` or `confirm`; states `waiting`, `applied`, `declined`, `undone`, `both`, `void`; the memory ids; the app in stored source form; the time; for `pair` the reported answer and the user's reported words. 0094 writes its waiting interview answers there at a pull and keeps no separate declined record. Every chat mark NorthKeep writes has a row there, so "Accepted lately" has one reader.

## 2. The screen (for the mock)

One screen. Jay approved the mock on 2026-11-25 ("Mock ok"), after asking for the list to "live in the bar on the bottom with its own tab" with "one of those little red notification numbers". Mock: https://claude.ai/artifact/EQ6BJjpYKEH4KdaH2hqzdX.

Entry:
- A fourth tab in the bottom bar (apps/mobile/src/BottomNav.tsx), in the order Projects, Memories, Review, Settings. The Review tab carries a red number: the "need your yes" count, hidden at zero. Answers accepted in chat do not add to it. The app still opens on Projects (apps/mobile/app/index.tsx:18).
- On the screen, above the sections, one line when chat answers arrived since the person last looked: "2 answers were accepted in chat since you last looked. They are under Accepted lately, each with an Undo." Hidden at zero.
- The app icon shows the "need your yes" count (section 8).

Header: "Review". Under it, small: "Checked 3:12 PM". Pull down to check again.

Section 1, "Needs your yes", open by default. One card per item, oldest first. Card, top to bottom:
1. A heading in NorthKeep's words, fixed per kind: "Replace a memory?", "Forget a memory?", "Settle a disagreement?", "Confirm a fact?".
2. A source line. The app name is a value, never part of a sentence NorthKeep says: "App: Pier Helper (as the app reported) · arrived Nov 24". For a forget: "Asked by a connected app. NorthKeep does not record which one or when." For a forget in a collection no longer Shared on this phone, a second fixed line: "Asked while this collection was shared with your apps. It is not shared now."
3. One or two boxes of saved text. Each box has a small label outside it ("Old", "New", "Memory", "1", "2") and the text inside, in a quote style with a left rule. Saved text appears only inside a box.
4. For a pair only, what the app reported, in two parts. A fixed line with the app name as a value: "Pier Helper (as the app reported) reported you said:". Then a box labelled "Reported words" with the reported words. Then a fixed line: "Reported answer: 2 is right." (or "1 is right", "Both are right", "Neither; it reported the right fact as:" followed by a box labelled "Reported fact").
5. One line in NorthKeep's words saying what Yes does: "Yes marks Old as replaced by New. You can undo this." For a forget: "Yes forgets this memory on all your devices. This cannot be undone."
6. Three buttons in a row, each at least 44 points tall: the action ("Replace", "Forget", "Yes, apply it", "Confirm"), then "No" ("Keep both" on a replace, "Keep it" on a forget), then "Not now".

"Forget" opens a dialog that holds focus until answered: "Forget this memory on all your devices? This cannot be undone." Buttons "Forget" and "Cancel".

Section 2, "Accepted lately", open by default when the accepted-since-you-last-looked count is above zero, otherwise collapsed. Newest first, 20 lines, then "Show more", which loads older lines; nothing is dropped. Each line:
- A fixed lead per kind: "Accepted in chat", "Both kept in chat", "You said yes on this phone", "Undone", "Declined".
- The app as a value where there is one ("Pier Helper (as the app reported)"), and the date.
- A box with the text that won (for a pair) or the memory (for a confirm, replace or forget), one line, cut at 120 characters; tapping it opens the memory's own screen (apps/mobile/app/memory/[id].tsx).
- "Undo", 44 points tall, where an undo exists. A forget shows "Forgotten. Cannot be undone." with no button.

Undo opens a dialog that holds focus: "Undo this? The memory it retired comes back and the mark is removed." Buttons "Undo" and "Cancel".

Empty state: "Nothing needs your yes." Under it: "When an AI app asks to change or remove a memory, or a fact about money, ownership, accounts, legal matters or numbers needs you, it shows here. Answers your AI apps settle in chat are listed under Accepted lately."

Messages:
- Not in sync: "This phone is not in sync with your other devices yet, so nothing changed. Let sync finish, then try again." (adapted from connect-flow.ts:61).
- Changed since shown: "This changed since you looked, so nothing changed. Here is the new version." The card refreshes.
- Settled elsewhere: "Already decided on another device." The card leaves.
- Undo refused: "This can't be undone here: <reason>." Reasons are fixed strings, such as "the memory that replaced it was forgotten" and "it was changed since".
- Older connector on a forget's No: "NorthKeep's server could not record that yet. Nothing changed; try again later."

Minimum type 11 points; touch targets 44 points; a 390-point-wide screenshot goes with the build PR.

## 3. Text an AI app wrote

Every memory text, reported word and app name on this screen may have been written by an AI app.
- Flattening, in the shared order: every run of whitespace, including line and paragraph separators and NEL, becomes one space; then control, format and direction characters and unpaired surrogates are removed; then it is trimmed. This reverses today's `tameOneLine` order (packages/core/src/text-safe.ts:21-26), so the phone uses a new `flatLine` in core, and the build PR either moves `reviewLine` to it or records why not.
- The whole text, not the first line: `reviewLine` shows the first readable line (connector-client.ts:894-902); a harmless first line could hide the real change.
- Length, one box: shown up to 280 characters, then "Show all". When the text is longer than 280 characters, the action button stays disabled until "Show all" has been opened, so the person cannot confirm or forget words they were not shown.
- Length, two boxes (replace, pair): if both texts fit in 280 characters, both are shown whole. Otherwise both boxes open at the first character where the two flattened texts differ, less 40 characters of lead, with "…" before; "Show all" expands both. Two texts identical for their first 280 characters can no longer hide the change (review 1, W4).
- The "changed since you looked" check: when a card is drawn the phone keeps a hash over the item id, the kind, and, for each box, the memory id, its role label and its full flattened text, plus the reported answer and words for a pair. Yes and Undo recompute it from the re-read and refuse on any difference. The hash covers the full texts, not the slice shown.
- Saved text appears only inside a labelled box. NorthKeep's own words are fixed strings in the app, never built from saved text.
- App names: flattened, quotes and brackets removed (" ' ` « » “ ” ‘ ’ ( ) [ ] { } < >), capped at 40 characters, shown only as a value followed by "(as the app reported)". An empty result shows "a connected app".
- What an app reported is never in NorthKeep's voice: "Pier Helper (as the app reported) reported you said:", never "You said" (review 1, W5).
- A memory with no readable text shows "(no readable text)", as today (connector-client.ts:905). Rows carrying NorthKeep's welcome-record mark (ADR 0094) are never listed.

## 4. From a tap to the vault and the connector

### Refresh (writes nothing)

Under either answer to the open question: when the list opens and on pull-down. Under "yes", also on each wake (the app returning to the foreground), at most once every 15 minutes while paired. The phone fetches `/client/pending?v=3` outside the vault gate, then, under the gate, computes the items with a new `listNeedsYes({vault, pending})` beside `planDownSync`, and the accepted lines with `listAccepted({vault})`. No vault write, no ack from the list itself. Under "yes", the read on wake is also the pull at which the phone takes in and accepts everyday cloud answers under ADR 0092 (a vault write, through Yes's steps 1 and 4 to 6, acknowledged only after the vault push lands). (The GET itself may drop dead queue entries on the server, as it does today: create-server.ts:1082-1088.) Between reads the count row and badge use the last read's item ids, kept on the phone, plus the vault's waiting rows.

### Yes and Undo (one path)

1. If a sync server is configured, the phone's vault file must equal the server's copy (the `phoneVaultStamp` check). Otherwise refuse with the not-in-sync message; nothing changes.
2. Fetch pending again, outside the vault gate. Then, under the gate: re-plan, find the item or line by its id, follow each memory to its live head, and recompute the hash of section 3. If the item is gone: "Already decided on another device." If the hash differs: "This changed since you looked."
3. Apply exactly one change: for Yes, the table in section 1, plus the additions this sync carries, as Sync now does today (a replace whose new memory is still a pending row adds it first); for Undo, the undo in section 7.
4. Save. Record a Yes in the phone's own store (ids, kind, time; never text).
5. Release the gate. Ack the additions, after the save, as today.
6. Push the vault to the sync server (`pushAfterSave`).
7. Do not ack the replace or forget when a sync server is configured. Under "yes" to the open question: if step 6 was a clean push (not a conflict recovery), push the Shared collections to Cloud Connect with the version that push returned; with no sync server, push with no version (as a device with no vault sync does, connector-auto.ts:19-21) and then ack the replace or forget the phone applied.

Undo uses the same path so that it is as careful as Yes: an Undo pushed from a phone that was behind would itself be the phone-side form of wound W1.

### No

Writes nothing to the vault and needs no in-sync check. It is a call the person starts, under either answer.
- Replace: `POST /client/ack {acked: [], forgets: [], replaces: [replace_id]}`. Exists today. `replaces: 0` in the reply means another device already settled it.
- Forget: `POST /client/ack {acked: [], forgets: [], keep_forgets: [entry_id]}`. New. The connector deletes only the queue entry (the second statement of today's `applyForget`, neon-storage.ts:904) and answers `kept: n`. Cloud apps see the memory again. An older connector ignores the field and returns no `kept`; the phone shows the older-connector message and keeps the card. That fails safe: the memory stays hidden, as today.
- Pair or confirm: the record becomes `declined`; a vault write with no memory change, through the Yes path's steps 1, 2, 4 and 6.

No cannot be undone. The app can ask again.

### Not now

Stored on the phone only, by item id, until local midnight. Not in the vault, not sent anywhere.

## 5. Two devices, two copies of the vault (review 1, W1)

The phone and the Mac each hold a whole copy of the vault, and the later push wins on the phone's side. A decision is a vault write, so a later push from the other device can undo it.

What the review showed: the Mac approves a cloud replace, marks the old memory, saves and acks; the queue entry is gone. Before the Mac's vault push lands, the phone, holding the older copy and in sync with the server, saves a change and pushes. The Mac's push is refused, it ends up with the phone's copy, and `computeDropReport` sees nothing to refuse because a lost mark is not a drop (client.ts:581-600). The retired memory is live again and nothing will ask again.

The treatment, the smallest that is true:
- With a vault sync server configured, a device acknowledges a cloud replace, approved or settled, only after the vault push of the same run has landed. `applyDownSync` returns those replace ids unacked; the caller (`/api/share/sync` in api.ts, `shareSyncCmd` in shareCmd.ts) sends them in a second `POST /client/ack {replaces: [...]}` only after its manual push's vault step returned a version (`manualVaultStamp` returned, so the vault push succeeded or the Mac was already in sync after its save). If the vault push fails or is refused, nothing is acked.
- With no vault sync server, the device holds the only copy, and it acks at once as today.
- If the push lost, the entry is still queued. At the next review the planner either finds the old memory still marked here (the Mac won after all) and settles it, or finds it live again (the phone's copy won) and asks again. A lost yes comes back as a question.
- A Cloud Connect push from the Mac already waits for the vault push (`manualVaultStamp`), so the connector's own dead-drop of the entry (create-server.ts:1082-1088) can only follow a vault push that landed.
- Forgets need no change: a forgotten-here, live-there row is a `restored_deletes` entry, so the Mac refuses that pull and says so (client.ts:592-594).
- The phone follows the same rule: it acks nothing it applied while a sync server is configured, and under "yes" its Cloud Connect push follows only a clean vault push.

This closes the window before the vault push lands, and nothing more. What remains possible, in one sentence for KNOWN-LIMITS: "If your phone saves a change while it is behind your other devices, it keeps its own copy, so a memory you retired on another device can come back without a question; the phone says it kept its copy and saves the other one as a backup."

Why there is no guard on the pull: a pull that refused a copy in which a memory marked replaced here is live there would also refuse the phone's own Undo, which produces exactly that shape (review 1). The phone's last-writer-wins push is the root; changing it is ADR 0044's sync, not this list. Question 2 asks Jay to accept the remainder.

## 6. What settles the queue, and what each person gets

With only today's person-started pulls and the Mac's automatic vault sync and Cloud Connect push. "Mac" here means the Mac app, or a local AI app that starts NorthKeep's server, running unlocked.

The open question has two halves, and a yes covers both: (a) the phone tells Cloud Connect itself after a Yes or an Undo, and reads it when the app opens; (b) on the phone, an everyday answer an app reported is accepted without a tap, at the phone's read, under ADR 0092's rules. Half (b) is the phone changing an existing memory with nobody tapping, which ADR 0063's founder rule ("the phone applies only additions until it has a preview screen") forbids today; a yes replaces that rule for these answers only, and the bulk sync stays additions only. Every answer the phone accepts is listed under "Accepted lately" with an Undo, and the phone acknowledges it only after its own vault push lands (ADR 0092 D5).

| | A Mac and a phone | Only a phone |
|---|---|---|
| Answer "no" | Items appear when the person opens the list or pulls down. A phone Yes or Undo reaches the vault on the sync server at once. The Mac takes it at its next automatic pull (clean: nothing is missing or brought back) and then pushes its Shared collections to Cloud Connect, so cloud apps see the change and the replace's queue entry clears at the next v3 read by any device, the phone's next refresh included. A forget's entry clears at the next Sync now on the Mac or `share sync`; until then it only hides a memory that is already gone. Everyday cloud answers are accepted only at the Mac's Sync now or `share sync`; they reach the phone list after that through the vault. | Items appear when the person opens the list. A Yes or Undo changes the phone's vault only. Cloud apps keep seeing both memories of a replace, and an Undo never reaches them; a forgotten memory stays hidden, as it already was. Queue entries stay, harmless. No device ever accepts a cloud chat answer, so every cloud answer of milestones 5 and 8 stays recorded and unaccepted, and cloud apps keep seeing both memories. |
| Answer "yes" | As above, and the list also refreshes when the app opens. After a Yes or Undo and a clean vault push, the phone pushes its Shared collections to Cloud Connect, so cloud apps see the change within seconds; the replace's entry clears at the next v3 read. If that push is refused because another device pushed a newer copy, nothing is lost: the Mac's push carries the change later. An everyday cloud answer is accepted at whichever device reads first, the phone when the app opens or the Mac's Sync now, and is listed with an Undo. | The list refreshes when the app opens. After a Yes or Undo the phone pushes its Shared collections to Cloud Connect (stamped if it has a sync server, unstamped if not), and, with no sync server, acks what it applied. Cloud apps see the change within seconds. Everyday cloud answers are accepted when the app opens, listed with an Undo, and reach cloud apps by the same push. The phone is this person's only device that decides. |

Under "yes" the push removes from the connector every row of those collections the phone does not hold live, as the Mac's push does (neon-storage.ts:600-610), and the connector refuses a push from an older vault version (HTTP 428, KNOWN-LIMITS.md:1442-1449). Cost: the phone sends content it already shares, more often, and the connector learns when the phone app is open. No new recipient.

## 7. Undo

- Replace: core `clearReplaced(id, expectedBy)` sets `superseded_at` and `superseded_by` back to empty on row `id`. It refuses unless the row's `superseded_by` equals `expectedBy`; refuses when the row `expectedBy` carries `metadata[CONSOLIDATION_METADATA_KEY]` (a combined memory or a restored copy); refuses when either row is forgotten. It does not guess whether the mark came from an edit. Both fields are outside the row hash, so the chain stays valid. Review 1's case: clearing a consolidation source would leave it and the combined memory both live and break the consolidation's restore; that is now refused (W2). The phone's Undo of its own replace calls `clearReplaced(old, new)`. ADR 0092's `undoAnswer` calls it with its own expected ids.
- Pair and confirm (milestones 5 and 8): the phone calls 0092's `undoAnswer(recordId)`, which brings back the retired memory, removes the mark, whether a chat mark or the user's mark from a Yes here, and sets the record to `undone`. 0092 owns it and its refusals; the phone shows them as the "Undo refused" message.
- Forget: no undo. `forget` blanks the text (vault.ts:592-594). The card says so before the tap, and the dialog again.
- No on anything: no undo; the request is gone and the app can ask again.

## 8. The notice

**A. Tab count and app-icon badge, set while NorthKeep runs (built).** The count is computed at each refresh. The badge is set by a small local native module beside the two the app already ships, calling iOS's own badge API (`setBadgeCount` from iOS 16, the older `applicationIconBadgeNumber` before it). One permission prompt (iOS ties the badge to the notification permission). No third-party dependency, no network, nothing leaves the phone. Limit: the badge shows what the phone knew when NorthKeep last ran.

**B. A local notification from a background refresh.** iOS wakes the app on its own schedule; the vault key is out of reach in the background (secure-store.ts:60), so it could count only the connector's queues and would overcount. Not built.

**C. A push notification.** Apple (and Expo, if it relays) becomes a new recipient; the phone's push token is stored on the connector; an Apple push key on the server. Not built; it would need its own ADR.

What any notice may contain: fixed words and, for A, the number on the icon. Never memory text, app names, collection names, kinds or ids.

## 9. The same item on another device

- Every Yes, Undo and No re-reads first (section 4).
- Approved on the Mac first: once the Mac's vault push lands it acks; the phone's re-read finds the item settled or gone: "Already decided on another device."
- Approved on the Mac, phone not yet synced: the phone's in-sync check fails until it pulls.
- Either memory edited, confirmed or forgotten on another device first: the item follows the live head or settles (section 1).
- Both devices decide within one sync window: section 5. The Mac does not notice a lost mark; the queue's ack-after-push rule makes a lost Mac approval ask again, and the remainder is the KNOWN-LIMITS line.
- The Mac keeps its review as today, plus the ack-after-push rule.

## 10. Protocol, schema, release

- Pending protocol: no new version. The phone moves from v2 to the existing v3 (ADR 0085). A version 3 Mac is unchanged; older phone builds keep asking v2 and never see the queue.
- Ack: one new request field, `keep_forgets`, and one response field, `kept`. Older clients never send it; an older connector ignores it (section 4).
- Unshare and the planner do not change: a forget asked for while a collection was shared stays queued and offered after the unshare (section 1).
- Ack after push: `applyDownSync` returns replace acks unsent when the caller says a vault sync server is configured; the two callers send them after the vault push lands (section 5).
- The connector change deploys before the phone build, like every connector-first change.
- Schema: none. "Not now", the Yes store and the last read's ids live on the phone, outside the vault. The `questions` table arrives with ADR 0092's schema step 0.4 to 0.5, and milestone 5's phone build, which reads it, must be in the App Store before the Mac release that migrates the vault (vault.ts:438-441).
- The App Store release Jay runs: one phone build carrying the screen, the v3 read, the one-item Yes, Undo and No path, `keep_forgets`, the badge module and its permission prompt, and the version and build number bump.

## 11. Trust

- The connector chooses which ids appear. It cannot make the phone show one text and apply another: the text comes from the phone's vault, and Yes refuses if the re-read differs from what was shown.
- For a replace's new memory that is still a pending row, the text comes from the connector, which decrypts it. It is trusted to relay that honestly, as for every addition today; the person reads it before tapping.
- For a pair, the reported answer and words came through the app and, for a cloud app, the connector. ADR 0092 asks Jay whether he trusts the connector to relay them; this list shows them labelled as reported and lets him decide.
- A forged No could only drop a request, which the app can make again.

## 12. Limits for KNOWN-LIMITS

- If your phone saves a change while it is behind your other devices, it keeps its own copy, so a memory you retired on another device can come back without a question; the phone says it kept its copy and saves the other one as a backup.
- The badge shows what the phone knew when NorthKeep last ran.
- A forget request does not say which app asked or when; NorthKeep never recorded it.
- "Arrived" on a replace is when the memory reached your devices, not when the app asked.
- Under "no" to the open question: a Yes or Undo on the phone reaches your AI apps when your Mac next syncs, and never with no Mac; with no Mac, no answer given in a cloud app is ever accepted. Under "yes": within seconds, unless another device pushed first, and the phone accepts everyday cloud answers when the app opens.
- Project changes still wait for the Mac. Not now is per phone. "You said yes on this phone" lines are listed only on the phone that said yes.
- KNOWN-LIMITS.md:34 and 1483-1491 change: the phone shows, applies and declines waiting replacements and forgets on this list.

## 13. Acceptance test

Runs with no AI app, on throwaway data, as test files. It fails on today's main: `listNeedsYes`, `listAccepted`, `applyYes`, `applyUndo`, `declineItem`, `clearReplaced` and `keep_forgets` do not exist, and `share sync` acks a replace before its vault push.

Command:
```
NORTHKEEP_HOME="$(mktemp -d)" pnpm exec vitest run packages/sync/test/adr0095-needs-yes.test.ts packages/core/test/adr0095-clear-replaced.test.ts packages/cli/test/adr0095-ack-after-push.test.ts apps/mobile/test/needs-yes-flow.test.ts apps/connector-server/test/adr0095-keep-forgets.test.ts
```

Set-up: a temp `NORTHKEEP_HOME`, `Vault.create` in it, the fake connector (packages/sync/test/fake-connector.ts) with `keep_forgets` added, and the fake sync server (packages/sync/test/fake-sync-server.ts, which has `conflictOnce()`). A second vault opened from a copy of the first file stands in for the Mac.

Sync file:

| Step | Call | Expected |
|---|---|---|
| 1 | remember "The harbor office is at Pier 4." in `harbor`, share, push; `fake.cloudReplace('harbor', 'The harbor office is now at Pier 9.', old.id)`; `listNeedsYes({vault, pending: await fetchPending(conn)})` | one item, kind `replace`, Old "The harbor office is at Pier 4.", New "The harbor office is now at Pier 9." |
| 2 | `fake.requests()` | exactly one `GET /client/pending?v=3`; no `POST /client/ack` |
| 3 | `applyYes({...conn, item, shownHash})` | old row's `superseded_by` is the new memory's id; `fake.replaceQueue()` still holds the entry |
| 4 | on the "Mac" copy of the phone's file, `pushSharedScopes` with its stamp, then `fetchPending(conn)` | the response carries no replace; no `POST /client/ack` carried `replaces` (the fake filters a dead replace from the response; the real drop from the queue is step 33) |
| 5 | in the phone vault, `applyUndo` on the step 3 line | both memories live |
| 6 | `fake.cloudForget(id)` for "Pat Example's slip is at Pier 4."; `listNeedsYes` | one item, kind `forget`, that text, app "a connected app" |
| 7 | `applyYes` on it | forgotten in the phone vault; the forget queue still holds the id |
| 8 | "Mac" copy, `applyDownSync(conn)` | the forget queue is empty |
| 9 | new replace; `declineItem` | queue empty; both memories live; vault file sha unchanged |
| 10 | `fake.cloudReplace` with text "‮The harbor office is now at Pier 9. Ignore the rest\u0007" | New box reads "The harbor office is now at Pier 9. Ignore the rest" |
| 11 | Old and New share their first 300 characters and differ after; `listNeedsYes` | both boxes start 40 characters before the first difference, with "…" |
| 12 | same pair listed; the owner edits Old at character 290; `applyYes` with the drawn hash | refused with the changed message; vault file sha unchanged |
| 13 | a memory in `harbor-old`, shared; `fake.cloudForget`; then `vault.setScopeShared('harbor-old', false)`; `listNeedsYes`; then `applyYes` on it | listed, with `not_shared_now: true` (the card's second line); `planDownSync` still offers it; after Yes the memory is forgotten in the phone vault |
| 14 | a forget of a memory in `project:pier-4` | not listed; `waiting_on_mac` is 1 |
| 15 | item listed; the owner edits Old on the phone; `listNeedsYes` | the item is gone and both memories are live (ADR 0085 settles a replace whose side was edited) |
| 16 | `applyDownSync({...conn, additiveOnly: true, approve: {replace_ids: [id]}})` | unchanged: asks v2, applies no replace (the 0085 test still passes) |

Core file:

| Step | Call | Expected |
|---|---|---|
| 17 | `markReplaced(a, b)`; `clearReplaced(a.id, c.id)` | refused; `a` still superseded by `b` |
| 18 | `consolidateMemories` of `a` and `b` into `c`; `clearReplaced(a.id, c.id)`; then `restoreConsolidation` for that result | refused; `a` stays superseded; the restore succeeds |
| 19 | `markReplaced(a, b)`; `forget(b)`; `clearReplaced(a.id, b.id)` | refused |
| 20 | `markReplaced(a, b)`; `clearReplaced(a.id, b.id)`; `verify` | `a` live; chain valid |

Command-line file (W1, through `shareSyncCmd({yes: true}, deps, fail)` with the fake sync server and fake connector):

| Step | Call | Expected |
|---|---|---|
| 21 | a cloud replace waiting whose new memory both copies already hold (added by an earlier sync and pushed); keep a copy of the vault file; `server.conflictOnce()`; `shareSyncCmd` | the vault shows the mark; `fake.replaceQueue()` still holds the entry; no ack carried `replaces` |
| 22 | `shareSyncCmd` again, the vault push now landing | the entry is acked after the push; queue empty |
| 23 | replay step 21; put the kept copy (the phone's, without the mark) on the fake sync server as a newer version; `pullVault({refuseDrops: true})`; then `planDownSync({vault, pending: await fetchPending(conn)})` | the pull goes through with an empty drop report (the lost mark is not a drop); the replace is in `cloud_replaces`, waiting again, not settled |
| 24 | no sync server configured; approve a replace | acked in the first ack, as today |

Mobile flow file (pure TypeScript with ports, like apps/mobile/test/connect-flow.test.ts):

| Step | Call | Expected |
|---|---|---|
| 25 | Yes, and separately Undo, with the status port reporting a sha different from the local file | refused with the not-in-sync message; the apply port never called |
| 26 | a one-box text of 400 characters; Yes before "Show all" | the action is disabled |
| 27 | Not now at 3:00 PM, then list at 11:59 PM and 12:01 AM (clock port) | hidden, hidden, shown |
| 28 | badge port after a refresh with two items, one hidden by Not now | badge set to 1 |
| 29 | written to Jay's answer: after a clean push and after a conflict-recovered push | "yes": the Cloud Connect port is called once, after the clean push only; "no": never called |

Connector file (in-memory storage, and Postgres through PGlite as apps/connector-server/test/tombstone-pg.test.ts does):

| Step | Call | Expected |
|---|---|---|
| 30 | a cloud `memory_forget` of a shared memory; `POST /client/ack {keep_forgets: [id]}` | `kept: 1`; `listPendingForgets` empty; the row still exists; a cloud `memory_list` shows the memory again |
| 31 | `POST /client/ack {keep_forgets: ["not-queued"]}` | `kept: 0`; no row deleted |
| 32 | a queued forget in `harbor`; unshare `harbor`; `listPendingForgets` | the forget is still queued (today's behaviour, unchanged, pinned because section 1 relies on it) |
| 33 | a queued replace in `harbor`; a stamped push of `harbor` that leaves out the old row; a v3 pending read | `listPendingReplaces` is empty with no ack (today's behaviour, pinned because section 6 leans on it) |

Then, with the build on the iOS Simulator, the verifier opens the screen on a test vault seeded with steps 1 and 6 and saves a 390-point-wide screenshot of each card, an "Accepted lately" line and the empty state. The badge on a real iPhone is Jay's step. Milestone 5's phone build adds the tests for `pair` and `confirm` items, for following `superseded_by` to the live head after an app's edit, and for chat answers under "Accepted lately"; those rows do not exist before its schema step.

## What I did not verify

- That iOS shows the badge with only the badge permission, that the prompt reads as expected, and that a local Expo module can set it without a notification dependency. Not tried; no device or build was run.
- The phone's minimum iOS version. app.config.ts sets it through `expo-build-properties` without naming one (lines 113-119); review 1 says 15.1. The badge module's fallback for iOS 15 covers either.
- Whether App Store review asks about a badge-only permission.
- That `planDownSync`'s replace and forget planning can run on the phone without its additive gates touching project rows. Described, not written.
- That every caller of `applyDownSync` with a vault sync server is the two named. I found three call sites (api.ts:1207, shareCmd.ts:321, vault-session.tsx:1424); the phone's is additive and acks no replace.
- The final shapes of ADRs 0092 and 0094. They are being revised beside this one. I read both short ADRs and grepped both design records as they stood at 06:51 on 2026-11-25. 0092's change back to "an AI-written memory can win unless the same app wrote it" is from the lead's message, not yet in the file I read.
- That after `conflictOnce()` the Mac is still "ahead", not "diverged", so step 22's second run is allowed. The fake server does not move on that 409, but `pushVault` keeps its generation bump on a 409 (client.ts:437-442); the build must check this before relying on step 22.
- Every line number above was read on main at 1089445; none was run.

## Review log

### Review 1 (2026-11-25): CLEARED WITH WOUNDS

Fresh Opus reviewer, design at 5b51535 against main 1089445; report at ~/Claude/Reports/Evidence/northkeep/2026-11-25-design-review1-0095.txt. No kill shot; about 40 "today" claims matched; capped because the badge is unverified on a device. Ten probes ran against the built code and the fake connector.

- **W1, a phone push silently undoes a yes given on the Mac.** The draft said the Mac's automatic pull refuses that case; it does not (`computeDropReport` looks only for missing rows, restored forgets and missing project heads). Changed: the false claim is removed from every section; section 5 adds the rule that a cloud replace is acked only after the vault push carrying it lands, so a lost Mac approval asks again; the phone acks nothing with a sync server; Undo uses the Yes path; the remainder is one KNOWN-LIMITS sentence and question 2. No pull-side guard, because the phone's Undo has the same shape.
- **W2, `clearReplaced` clears rows it must not.** Changed: `clearReplaced(id, expectedBy)`, refusing unless `superseded_by` equals `expectedBy` and when the successor carries consolidation metadata; the edit guess is gone. Steps 17 to 20.
- **W3, a forget offered for a collection no longer shared.** Not a bug to drop: offering it is deliberate and pinned by apps/connector-server/test/c3-property.test.ts:257; KNOWN-LIMITS on 66ad784 already says it is still offered and needs a yes. (A first revision filtered it out and cleared it at unshare; the lead tried that in code, it broke that invariant, and it is withdrawn.) Changed: the card says "Asked while this collection was shared with your apps. It is not shared now.", and the permanent-forget confirmation stays. Steps 13 and 32 pin today's behaviour.
- **W4, the 280-character cap hides the change.** Changed: two boxes open at the first difference; one long box must be opened before the action is enabled; the hash covers full texts, ids and roles. Steps 11, 12 and 26.
- **W5, NorthKeep's voice on what an app reported.** Changed: "<app> (as the app reported) reported you said:", with the words in a box and the answer as a fixed phrase.
- **Note, "the Mac's next pull settles the queue" leaned on ADR 0096.** Changed: 0096 is withdrawn; section 6 says what settles the queue with today's pulls and automatic pushes, for a Mac and a phone and for a phone alone, under each answer.
- **Note, 0096 said the phone never pushes to Cloud Connect, against question 3.** Gone with 0096; the phone's push is the open question.
- **Note, `setBadgeCount` needs iOS 16.** Changed: the module falls back to the older badge property before iOS 16.
- **Questions off Jay's list:** the mock (a standing gate), badge versus push, building the undo here, "Keep it" on the phone only, connector trust (ADR 0092 asks it), forgets naming no app, projects waiting for the Mac. Each is settled below with its reason. Kept: the phone telling Cloud Connect, with the read when the app opens added, and, per the lead, the phone accepting everyday answers without a tap named as its second half.
- **Biggest reason it might be the wrong thing to build** (the phone becomes a second device that decides, on a sync that keeps the last writer's copy): not changed. It is why section 5 exists and why question 2 asks Jay to accept the remainder or ask for the larger sync change.

## Settled here, with the reason

- The mock of the screen went to Jay and he approved it on 2026-11-25, with the list moved to its own bottom tab.
- Notice: the Review tab's count and the icon badge only. A push service adds Apple as a recipient for little gain.
- `clearReplaced` is built here, because this is the first milestone with an undo and milestone 5 needs the same step.
- "Keep it" for a cloud forget exists on the phone only in this milestone: the smallest change; the Mac can gain it later.
- A forget request names no app and no time: the connector never recorded them, and adding them needs a new pending version for a label.
- Project changes stay in the Mac's review: they need ADR 0063's larger preview screens.
- Trust in the connector to relay reported answers is asked once, in ADR 0092.

## Agreed across ADRs 0092, 0094 and 0095

Checked against 0092's and 0094's files in the clone as of 06:51 on 2026-11-25, and the lead's message of the same morning.
- Build order: 0095 (this phone list), then 0092 (milestone 5), then 0094 (milestone 8). ADRs 0093 (milestone 6, deferred) and 0096 (withdrawn) are not depended on.
- Schema steps: 0095 none; 0092 takes 0.4 to 0.5, which creates the `questions` table; 0094 none. The phone build that understands 0.5 must be in the App Store before the Mac release that migrates the vault.
- Pending protocol: 0095 moves the phone from v2 to the existing v3 and adds only the ack field `keep_forgets`. 0092 introduces version 4. 0094 introduces version 5, which adds its archive mark to pending rows.
- The chat mark is `confirmed: {by: "chat", app, at}`, with an optional `question` id set only by 0092; `app` is the stored source form; `isConfirmed` means `by: "user"` only; the command line says "confirmed in chat". On the connector path it travels as `chat: {app, at}`. Only a device writes it.
- One place in the vault for everything that waits or was accepted: 0092's `questions` table, kind `pair` or `confirm`, states `waiting`, `applied`, `both`, `declined`, `undone`, `void`. 0094 writes a `confirm` row in state `waiting` for each waiting interview answer and in state `applied` for every answer a device chat-marks, and keeps no separate declined record. So every chat mark has a row, and "Accepted lately" has one reader.
- A waiting item follows `superseded_by` to the live head.
- The step that clears a replaced mark is `clearReplaced(id, expectedBy)`, built here: it refuses unless `superseded_by` equals `expectedBy` and when the successor carries consolidation metadata. 0092's `undoAnswer(recordId)` is the full undo of an accepted answer (retired memory back, mark gone, whether a chat mark or the user's mark from a Yes here; record `undone`), and the phone's Undo calls it.
- Every accepted chat answer is listed under "Accepted lately" with that Undo. No chat answer is applied before milestone 5's phone build, which lists it, is live.
- "Both are right" is listed and undoable, and does not stop another app's different answer from reaching "Needs your yes".
- What waits for the user: any digit in either text, after NFKC folding; a word beginning with a listed stem after splitting on anything that is not a letter or digit and dropping a trailing 's (own, co-own, owner, share, stake, shareholder, member, partner, llc, inc, ltd, corp, account, bank, loan, mortgage, lien, deed, title, lease, landlord, tenant, rent, trust, will, estate, tax, contract, agreement, court, lawsuit, sue, custody, divorce, attorney, salary, wage, debt, owe, dollar, percent, work, employ, boss, job, client, lawyer, doctor, advis, dispute, sold, bought, paid, board, compan); $ % € £ anywhere; a user-confirmed memory; a waiting cloud replacement on either memory. Interview keys that always wait: work, companies, colleagues, advisers, never contact, organizations, dealings, properties, projects, always ask, disputes.
- Who may win in chat (ADR 0092): any memory, AI-written or not, unless the same app that reports the answer is known to have written it; a winner whose writer is unknown is accepted. This list shows whatever 0092 accepted, with the Undo.
- A cloud answer's ids are mapped on the device by vault id and through `metadata.connector.server_id`; one still unmapped after three pulls is void. With PR 98 merged, a side found among the vault's forgotten connector ids can void at once (0092's call).
- A cloud answer is accepted at the next pull by a device that can re-check it: the Mac's Sync now, the command line, or the phone if Jay says yes to the question below. Until then cloud apps see both memories.
- A device acknowledges anything that changes an existing memory only after the vault push carrying it has landed. That closes the window before the push lands, and nothing more: a phone that later saves while behind can still undo it (section 5). No design claims the Mac's automatic pull detects a lost mark.
- Text an AI app wrote is never in NorthKeep's voice: whitespace flattened before control and direction characters are removed; app names without quotes or brackets; "<app> reported you said". 0094's welcome records are recognised by NorthKeep's archive mark, not by text, and are never listed here.
- The hand test passed for Grok Bot and Muse (Jay, 2026-11-25).
- The open phone question is asked once, here; 0092 and 0094 point to it.

## Decisions waiting for Jay

Answered in part, 2026-11-25. Jay: "C yes", to the question as the lead put it to him: the phone tells Cloud Connect itself after a Yes or an Undo, and the connector can then tell when the phone app is open. The second half below (the phone accepts an everyday answer with no tap, ending the additions-only rule for those answers) follows from his "answer the agent and then accept that" for a person with only a phone; the lead stated it back to him the same day and asked him to say no if he did not mean it. Treat the first half as decided and the second as decided unless he objects.

1. **May the phone tell Cloud Connect itself after a Yes or an Undo, and read the connector when the app opens, so a person with only a phone is served?** A yes allows two things. First, the phone sends your shared memories to Cloud Connect after you tap Yes or Undo, and checks Cloud Connect each time you open the app, so the connector can tell when the phone app is open. Second, when the phone checks, it accepts an everyday answer an AI app reported, with no tap, as the Mac does at Sync now; that ends ADR 0063's rule that the phone only adds memories, for these answers only. Every accepted answer is listed with an Undo. Recommend yes: the first outside customer may never run anything on a Mac.
   - Yes, with a Mac and a phone: your AI apps see a phone Yes or Undo within seconds; everyday answers are accepted by whichever device checks first.
   - Yes, with only a phone: the phone does everything the Mac would; answers are accepted when you open the app and reach your AI apps within seconds.
   - No, with a Mac and a phone: the phone checks only when you open this list or pull down; a phone Yes or Undo reaches your AI apps when your Mac next syncs; answers are accepted only at the Mac's Sync now.
   - No, with only a phone: you can see and decide items on the phone, but your AI apps never learn of a Yes or Undo, and no answer given in an AI app is ever accepted.
2. **Do you accept that, after a decision has fully saved on one device, a phone that was behind and then saves its own change can still bring a retired memory back without asking?** Recommend yes for now: the phone says it kept its own copy and backs up the other, and the new ack rule closes the common case. Yes: the KNOWN-LIMITS sentence in section 5 ships as written. No: the phone's sync must stop keeping its own copy over a newer one, which changes ADR 0044's phone sync in its own ADR; this list waits for it. A guard on the Mac's pull is not an option, because it would refuse the phone's own Undo.
3. **Will you run one phone release through the App Store for this list?** It carries the screen, the version 3 read, the Yes, Undo and No path, `keep_forgets`, and the badge with its notification permission prompt. Recommend yes. Yes: built and released as described, after the connector deploy. No: nothing here reaches the phone, and replaces and forgets keep waiting for the Mac's review.
