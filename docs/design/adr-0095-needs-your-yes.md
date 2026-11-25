# Design record: ADR 0095, Needs your yes

Status: Proposed 2026-11-25 (prerequisite for milestones 5 and 8) · Draft: not reviewed, not accepted. Nothing here is built.

Code references are to main at 1089445, read on 2026-11-25 from the read-only checkout. Line numbers can drift; the names are the anchor. Examples are fictional.

## In one screen

- One new phone screen, "Needs your yes". It lists what waits for the person, oldest first. Each row shows the words involved as plain text, which app (as the app reported) and when, and three buttons: Yes, No, Not now.
- In this milestone a row is one of two kinds that wait today: a cloud app asked that one memory replace another, or a cloud app asked to forget a memory. Milestone 5 (ADR 0092) adds its level 2 answers and milestone 8 (ADR 0094) adds its waiting interview answers, each in its own phone build. A row is always something already answered or asked; the phone never asks open questions.
- Every line on the screen is read from the phone's own vault, or from the row this sync is about to add. The connector supplies only which ids.
- Yes applies exactly that one change to the phone's vault, saves, and pushes the vault to the sync server. The Mac's vault gets it the way it gets any phone edit today. The phone does not acknowledge the item to the connector; the Mac's next pull finds the change already made and clears the queue entry with code that exists.
- No changes no memory. It removes the request from the connector's queue: for a replace with today's ack, for a forget with one new ack field.
- Not now hides the row on this phone until local midnight.
- A replace done on the phone can be undone. A forget cannot, and the phone says so before the person taps.
- The notice is a count line inside the app and a number on the app icon, both set only while NorthKeep runs. No push service. A push notification is described with its costs and left for its own ADR.
- No schema step. No new pending protocol version: the phone moves from version 2 to the existing version 3, and the ack gains one field.
- This is the "preview screen" ADR 0063's founder decision waited for, one item at a time. The bulk phone sync stays additions only.

## The problem, and what the owner chose

Things that wait for the user today:
- A cloud app's replacement of a memory (ADR 0085 D4). Approved only in the Mac app's sync review or `northkeep share sync` (KNOWN-LIMITS.md:34).
- A cloud app's forget of a memory. Same review (connector-client.ts:1019-1031 applies only approved forgets).
- Confirming a memory as the user's own. Only `northkeep confirm` (packages/cli/src/index.ts:278-288) calls `confirmMemory`; no Mac app route or phone screen does (it is called nowhere else under apps/ or packages/ outside tests).
- Soon: milestone 5's level 2 answers and milestone 8's interview answers about money, ownership, accounts and legal matters.

Jay rarely opens the Mac app and never a terminal. The first outside customer works only in cloud AI apps. Jay's answer on 2026-11-24 (decision 3 in the round 3 brief): these are confirmed on the phone, from a short list with a notice, as its own milestone needing an App Store release he runs.

## What the code does today (checked)

The phone and its vault:
- The phone opens the same vault format with the same core code (`Vault.openWithKey`, apps/mobile/src/lib/vault-session.tsx:346). An older build refuses a newer schema: "Vault schema ... is newer than this build understands" (packages/core/src/vault.ts:438-441). Schema today is 0.4 (packages/core/src/types.ts:151).
- The phone already writes the vault as the owner: add, edit and forget (vault-session.tsx:1155-1227). Each saves, then pushes the vault to the sync server (`pushAfterSave`).
- Phone vault sync is last-writer-wins: on a 409 it keeps the server copy as a backup and pushes its own over it (apps/mobile/src/lib/sync-flow.ts:11-31). The Mac's automatic pull refuses a server copy that would drop or undo something it has (packages/sync/src/client.ts:542-545, 581-600). ADR 0063's record calls that refusal load-bearing because of the phone (docs/design/sync-guardrails.md:488-505).
- The phone syncs only when it is open: a wake runs when the app returns to the foreground (vault-session.tsx:1145-1153). KNOWN-LIMITS.md:388: "A phone left in your pocket does not sync until you open it."
- The phone reads Cloud Connect only when the person taps Sync now on the sharing screen (apps/mobile/app/sharing/scopes.tsx:134-136). That call passes `additiveOnly: true` (vault-session.tsx:1419-1424).
- The phone's sharing push requires the phone's vault file to equal the sync server's copy, or no sync server at all (`phoneVaultStamp`, apps/mobile/src/lib/connect-flow.ts:92-103; message at line 61).
- The vault key needs Face ID or the passphrase (`requireAuthentication: true`, apps/mobile/src/lib/secure-store.ts:60, 72). The device secret does not (line 42 options, lines 51-52).

What `additiveOnly` does (ADR 0063's reason):
- ADR 0063 Decision, founder bullet (SPEC/decisions/0063-sync-guardrails.md:15): "the phone applies only additions until it has a preview screen". The incident behind 0063 was one Sync now rolling five projects back by writing cloud documents over newer local ones, unseen (same file, Context). The design record adds that the phone must not ack a forget "or the Mac never sees the forget" (sync-guardrails.md:179-189, 1003).
- In code: the phone asks `/client/pending?v=2`, so it never receives the replace queue (connector-client.ts:562-568, 947). Project fast-forwards are deferred (796), forgets are neither applied nor acked (814-822), queued replaces are deferred (847-852), and every approval is ignored (949-951). A test pins this: the phone adds the new memory and never applies or acks a replace "even when told to" (packages/sync/test/adr0085-cloud-replace.test.ts:175-184).

The two queues on the connector:
- `pending_replaces` holds ids and scope, with `created_at` (apps/connector-server/src/neon-storage.ts:158-166). The v3 response sends `replace_id, scope, old_id, new_id` only, no time (apps/connector-server/src/create-server.ts:1076-1096).
- `pending_forgets` holds the entry id and `created_at`, no app (neon-storage.ts:101-106; `enqueueForget` at 801-807, called with the id only at mcp.ts:707). The response sends `{entry_id}` only (create-server.ts:1095).
- A queued forget hides the memory from cloud apps at once (mcp.ts:318).
- `/client/ack` takes `acked`, `forgets` and `replaces`. Each forget id runs `applyForget`, which deletes the queue entry and the shared row (create-server.ts:1143-1146; neon-storage.ts:895-906). Each replace id is dropped from the queue (create-server.ts:1125, 1149). There is no way today to drop a forget request without forgetting the memory.
- Nobody can say no to a cloud forget or replace today: an unapproved one stays pending (connector-client.ts:1021-1025, 1039-1043) until a side changes.

What a down-sync does with them on a device that confirms (Mac, CLI):
- `planDownSync` turns a forget of a live entry into a `PlannedForget` and one for an entry not live here into `settled_forgets`, which are acked (connector-client.ts:813-829, 1019). A replace whose side is forgotten or superseded here is `settled_replaces`, acked (865-870, 1034).
- `applyDownSync` re-fetches and re-plans before applying, so an approval names an item that must still be there (929-951).
- The replace line shown to the user is `reviewLine`: the first line that has a letter or digit, after `tameOneLine` (894-902). `tameOneLine` removes control and direction characters, and U+2028 and U+2029, before it collapses whitespace (packages/core/src/text-safe.ts:11, 21-26). So a line separator joins two lines: the existing test expects "...Pier 9.Ignore the rest" (adr0085-cloud-replace.test.ts:76-79).
- A connector-born row is saved with no time from the connector (connector-client.ts:981), so its `created_at` is when this device pulled it.

The vault operations:
- `markReplaced(old, new)` sets `superseded_at` and `superseded_by` in place (vault.ts:729-742). It refuses project paperwork, two scopes, and a restored copy. Nothing in the code clears those two fields again.
- `forget` blanks the content and metadata for good (vault.ts:558-596, the UPDATE at 592-594).
- `confirmMemory` writes a new row with `confirmed: {by: "user", at}` (vault.ts:748-754).

Notices:
- No notification code and no notification dependency in the phone app (apps/mobile/package.json:22-61; a search of app/ and src/ for "notif" finds only a code comment). The app already ships two local native modules (apps/mobile/modules/nl-tagger, modules/pdf-text).

When a phone change reaches cloud apps when a Mac exists:
- The Mac's vault auto-sync runs inside the Mac app (apps/web/src/session.ts:55) and inside each local MCP server process an AI app starts (packages/mcp-server/src/auto-sync.ts:1-11: "the session starting is a wake"). Cloud Connect is then updated by the automatic push from an in-sync device (packages/sync/src/connector-auto.ts:10-21).
- A device with no vault sync "is the only copy of its vault, so it pushes on a debounced save and sends no version" (connector-auto.ts:19-21).

## 1. The items

| Kind | Where it comes from | Built in | What the row shows | Yes does to the vault | No does | Undo of Yes |
|---|---|---|---|---|---|---|
| Replace | connector replace queue, pending v3 | this milestone | Old line, New line, app that saved the new memory, when it arrived | `markReplaced(old, new)` | drops the request with today's ack `replaces: [id]`; both memories stay live | yes: clears the replaced mark |
| Forget | connector forget queue, pending v2 and v3 | this milestone | the memory's line, who saved it and when; "A connected app asked to forget this" | `forget(id)` as the owner | drops the request with the new ack field `keep_forgets: [id]`; cloud apps see the memory again | no: the text is gone |
| Answer (level 2) | ADR 0092's question record, state waiting | milestone 5's phone build | both memories, and the answer in fixed words: "You said the second one is right" | 0092's level 2 apply: the chosen memory gets the user's mark, the other is marked replaced | records "declined on the phone"; no memory changes | yes, with 0092's undo |
| Confirm | ADR 0094's waiting answers | milestone 8's phone build | the memory's line, "From the welcome interview in <app>, <date>" | `confirmMemory(id)` | leaves it unconfirmed and stops listing it | yes: a new version without the mark |

What Yes does for a level 2 answer, by answer (the same move as 0092's `northkeep answer`; 0092 owns the details):
- "The first is right" or "the second is right": the chosen memory gets the user's mark (`confirmMemory`), the other is marked replaced by it.
- "Both are right": both get the user's mark; nothing is replaced.
- "Neither; the right fact is X": X was already saved, unconfirmed, when the app reported the answer. Yes gives X the user's mark and marks both memories replaced by X.
A Yes on the phone is the person's own mark, the same as `northkeep confirm`. The rule that an AI app cannot raise the standing of a memory it wrote does not block it, because no app gives it.

Not a general confirm button: the list shows only items NorthKeep marked as waiting. A "Confirm" button on every memory's own screen would give a second way to confirm anything; nobody asked for it, so it is left out.

Rules for every kind:
- Only memories outside project scopes. A forget or replace in a project scope, and every project fast-forward or conflict, stays in the Mac's review. `listNeedsYes` returns these as one number, `waiting_on_mac`, and the phone shows one fixed line under the list when it is above zero: "N changes to projects wait for your Mac." (question 8)
- Only items whose memories are live on the phone, or will be added by this same sync. An item the phone cannot see yet is not shown; it is not an error.
- An item already settled elsewhere drops off at the next refresh.

What 0092 and 0094 must provide (proposed in "Agreed across" below): every waiting item they create lives in the vault, in 0092's question table, with a kind (`pair` or `confirm`), the memory ids, the app in stored source form, the time, and for `pair` the answer the app reported. Then the phone reads one table plus the two connector queues. If 0094 keeps its waiting list in its welcome record instead, the phone reads that too, at the cost of a second reader.

## 2. The screen (for the mock)

One screen. Every new screen needs a mock Jay approves before build; this is the text to mock.

Entry:
- On the Projects screen, where the app opens (apps/mobile/app/index.tsx:18), and on the Memories screen: one row at the top, "3 things need your yes", with a chevron. Hidden when the count is zero.
- The app icon shows the same count (section 7).

Header: "Needs your yes". Under it, small: "Checked 3:12 PM". Pull down to check again.

Section "Waiting". One card per item, oldest first. Card layout, top to bottom:
1. A heading in NorthKeep's words, fixed per kind: "Replace a memory?", "Forget a memory?", "Settle a disagreement?", "Confirm a fact?".
2. A source line in NorthKeep's words with the app name as a value: "App: Pier Helper (as the app reported) · arrived Nov 24". For a forget: "Asked by a connected app. NorthKeep does not record which one or when."
3. One or two boxes of saved text. Each box has a small label outside it ("Old", "New", "Memory", "1", "2") and the text inside it, in a quote style with a left rule. Saved text is only ever inside a box.
4. One line in NorthKeep's words saying what Yes does, for example: "Yes marks Old as replaced by New. You can undo this." For a forget: "Yes forgets this memory on all your devices. This cannot be undone."
5. Three buttons in a row, each at least 44 points tall: the primary button names the action ("Replace", "Forget", "Confirm", "Yes, apply it"), then "No", then "Not now". "No" on a forget reads "Keep it"; on a replace, "Keep both".

Tapping a box opens the memory's own screen (apps/mobile/app/memory/[id].tsx) when the memory is in the vault, to read it whole.

"Forget" opens a dialog that holds focus until answered: "Forget this memory on all your devices? This cannot be undone." Buttons "Forget" and "Cancel".

Section "Decided lately", collapsed by default, last 30 days: one line per decision made on this phone and, from milestones 5 and 8, each memory confirmed in chat. Each line: what happened, the date, a short form of the text, and "Undo" where undo exists. A forget shows "Forgotten. Cannot be undone." with no button.

Empty state: "Nothing needs your yes." Under it: "When an AI app asks to change or remove a memory, or a fact about money, ownership, accounts or legal matters needs you, it shows here."

Messages:
- Not in sync: "This phone is not in sync with your other devices yet, so nothing changed. Let sync finish, then try again." (the wording of connect-flow.ts:61, adapted).
- Changed since shown: "This changed since you looked, so nothing changed. Here is the new version." The card refreshes.
- Settled elsewhere: "Already decided on another device." The card leaves.
- Older connector on a forget's No: "NorthKeep's server could not record that yet. Nothing changed; try again later."

Minimum type 11 points; touch targets 44 points; a 390-point-wide screenshot goes with the build PR.

## 3. Text an AI app wrote

Every memory text and app name on this screen may have been written by an AI app. The rules:
- Saved text is shown whole, as one line: every run of whitespace, including line and paragraph separators and NEL, becomes one space first; then control, format and direction characters and unpaired surrogates are removed; then it is trimmed. Shown up to 280 characters, then "Show all", which expands the same flattened line. This is the shared order. It reverses today's `tameOneLine` order (text-safe.ts:21-26), so the phone uses a new `flatLine` in core, and the build PR either moves `reviewLine` to it or records why not.
- The whole text, not the first line. `reviewLine` shows the first readable line (connector-client.ts:894-902); a harmless first line could hide the real change.
- Saved text appears only inside a labelled box. NorthKeep's own words (heading, source line, what Yes does, buttons) are fixed strings in the app, never built from saved text.
- App names: flattened the same way, quotes and brackets removed (" ' ` « » “ ” ‘ ’ ( ) [ ] { } < >), capped at 40 characters, shown only as the value after "App:", followed by "(as the app reported)", the label ADR 0085 D1 uses on the Mac. An empty result shows "a connected app".
- A memory with no readable text shows "(no readable text)", as today (connector-client.ts:905).
- Record-shaped rows (such as ADR 0094's welcome record) are never listed.

## 4. From a tap to the Mac's vault and the connector

### Refresh (writes nothing)

When the list opens, on pull-down, and on a wake at most once every 15 minutes while the phone is paired: fetch `/client/pending?v=3` (the highest version this build understands) outside the vault gate; then, under the gate, compute the items with a new `listNeedsYes({vault, pending})` beside `planDownSync`. No vault write, no ack, no discard of the phone's own. (The GET itself may drop dead queue entries on the server, as it does today: create-server.ts:1014, 1088.)

### Yes

1. If a sync server is configured, the phone's vault file must equal the server's copy (the `phoneVaultStamp` check). Otherwise refuse with the not-in-sync message; nothing changes. The phone's normal wake pulls, and the person tries again.
2. Fetch pending again, outside the vault gate (ADR 0096 D4's order: no network call while holding the vault). Then, under the gate: re-plan and find the item by its id. Resolve both memories in the phone's vault. If the item is gone, say "Already decided on another device." If any shown text differs from what this re-read gives (compared by a hash taken when the card was drawn), refuse with "This changed since you looked".
3. Apply exactly that one change, plus the additions this sync carries, as Sync now does today. For a replace whose new memory is still a pending row, it is added first, then marked.
4. Save. Record the decision in the phone's own "Decided lately" store (ids, kind, time; never text).
5. Release the gate. Ack the additions, after the save, as today; a failure there is retried as a duplicate next time. Today's Sync now keeps its deliberate exception of holding the gate across the network (vault-session.tsx:1407-1412); this new path does not need it, because its fetch and its writes are separate steps.
6. Push the vault to the sync server (`pushAfterSave`).
7. Do not ack the replace or the forget.

How it reaches the Mac: the Mac's next vault pull brings the phone's vault. The phone only marked or forgot rows that exist on the Mac too, so nothing is "only here" and nothing forgotten comes back: the drop report stays empty (client.ts:581-600) and the automatic pull goes through. The Mac's automatic push then updates Cloud Connect. On the Mac's next connector pull, the replace's old side is no longer live, so it is a settled replace and acked; the forgotten entry is not live, so it is a settled forget and acked (connector-client.ts:813-819, 865-870, 1019, 1034).

When that happens: whenever the Mac app runs, or an AI app on the Mac starts NorthKeep (auto-sync.ts:1-11). ADR 0096's draft runs its background pull in those same two places, not in the Keep Watch helper, and acks the settled items there (its D3), so the queue entry clears then too. Until then cloud apps still see both memories of a replace, and the forgotten memory stays hidden as it already was.

When no Mac process runs, the yes never reaches cloud apps: they keep seeing both memories of a replace, and a confirm never reaches cloud ranking. A phone with no sync server is worse: no Mac will ever settle anything. That is the first outside customer's likely setup. The option (question 3):
- After a yes, and only when the vault push in step 6 was clean (not a conflict recovery), the phone pushes its Shared collections to Cloud Connect with the same stamp its share add uses (`phoneVaultStamp`, connect-flow.ts:92-103): the phone holds exactly the sync server's newest copy, so it can displace nothing newer. A phone with no sync server pushes with no stamp, as a desktop with no vault sync does (connector-auto.ts:19-21).
- That push removes from the connector every row of those collections the phone does not hold live (neon-storage.ts:600-610; `list` leaves out forgotten rows, vault.ts:1922-1934). So the replaced memory leaves the connector, and the next v3 read finds the replace dead and drops it (create-server.ts:1083-1088): the queue drains with no phone ack. A forget request stays queued but names a row already gone; a Mac settles it when it next pulls, and on a phone with no sync server the phone acks the forget it applied.
- Cost: the phone pushes content it already shares, more often. No new recipient. If the push is refused (another device pushed a newer copy), nothing is lost: the Mac's own push carries the change later.

### No

Writes nothing to the vault and needs no in-sync check.
- Replace: `POST /client/ack {acked: [], forgets: [], replaces: [replace_id]}`. Exists today. A response of `replaces: 0` means another device already settled it.
- Forget: `POST /client/ack {acked: [], forgets: [], keep_forgets: [entry_id]}`. New. The connector deletes only the queue entry (the second statement of today's `applyForget`, neon-storage.ts:904) and answers `kept: n`. Cloud apps see the memory again. An older connector ignores the field and returns no `kept`; the phone then shows the older-connector message and keeps the row. That fails safe: the memory stays hidden, as it is today.
- A level 2 answer (milestone 5): the question record becomes "declined"; a vault write with no memory change, pushed like any other.
- A confirm (milestone 8): the item leaves the waiting list; the memory stays unconfirmed.

No cannot be undone. The app can ask again.

### Not now

Stored on the phone only, by item id, until the person's local midnight. Not in the vault and not sent anywhere, so the Mac and other phones still show the item. Matches the plan's rule "'Not now' holds until tomorrow".

## 5. What this changes in ADR 0063, and why it is safe

ADR 0063 held the phone to additions because a bulk sync could overwrite or remove what the person never saw. This design keeps that bulk path unchanged: `additiveOnly` still zeroes every approval and the pinned test stays as it is. It adds a separate path that applies one memory change by id, after the person saw that change's words from the phone's own vault. That is the preview the founder decision waited for.

What it allows: a memory marked replaced, a memory forgotten, a memory confirmed, all outside project scopes, one per tap. What it still forbids: project fast-forwards, project conflicts, project-scope forgets, and any bulk approval.

The second half of 0063's reason was the forget ack: if the phone acked a forget, the Mac would never see it. This design keeps that rule by never acking a yes (with a Mac). The Mac learns of the change from the vault, which is better evidence than the connector's queue.

The third risk is the phone's last-writer-wins vault push. A yes is a vault write like the phone's own edits and forgets today, so it carries the same risk, no more: two devices writing within one sync's window. The in-sync check in step 1 narrows the window to the seconds between check and push. If it still happens, the Mac's automatic pull refuses and says so, as today.

## 6. Undo

- Replace (this milestone): a new core primitive, `clearReplaced(oldId)`, sets `superseded_at` and `superseded_by` back to empty on a row that `markReplaced` marked. It refuses when the row that replaced it has since been forgotten by the user, when the old row is forgotten, and when the old row was superseded by an edit rather than marked (its `superseded_by` row is a later version of itself). Both fields are outside the row hash (`computeEntryHash`, vault.ts:2185-2214, comment at 2186-2189), so the chain stays valid. The phone's Undo calls it, saves and pushes. The Mac's pull is clean: no row disappears. ADR 0092 was to build this primitive (its D7); since this milestone ships first, it builds the replace half and 0092 adds its command and Mac action and the chat-mark half. That changes 0092's ownership and needs the lead's agreement (question 4 for Jay).
- Forget: no undo. `forget` blanks the text (vault.ts:592-594). The card says so before the tap and the dialog says it again.
- No on anything: no undo; the request is gone and the app can ask again.
- Level 2 answer and confirm: undone with 0092's primitive, which must remove a user mark as well as a chat mark for this.
- Chat marks (milestones 5 and 8): the "Decided lately" section lists memories confirmed in chat in the last 30 days, each with Undo, which removes the chat mark. This is the phone list's undo action the shared shapes require.

## 7. The notice

Three options, with what each costs.

**A. Count line and app-icon badge, set while NorthKeep runs (recommended).** The count is computed at each refresh. The badge is set by a small local native module beside the two the app already has, calling iOS's own badge API. Costs: one permission prompt ("NorthKeep would like to send you notifications"; iOS uses the notification permission for a badge); no third-party dependency; no network; nothing leaves the phone. Limit: the badge shows what the phone knew when NorthKeep last ran. A request that arrives while the app is closed does not change the badge.

**B. A local notification from a background refresh.** iOS may wake the app now and then (its schedule, not ours, and never after the person swipes the app away). In the background the vault key is out of reach (secure-store.ts:60), so the phone could count only the connector's queues, with the device secret, and would overcount items already settled on the Mac. Costs: a background-task dependency, the alert permission, a connector request on each wake (the connector learns when the phone wakes), and a count that can be wrong. Not recommended.

**C. A push notification.** The connector, or a relay, sends through Apple's push service when an item enters a queue. Costs: Apple becomes a new recipient (and Expo too, if its push service relays); the phone's push token is stored on the connector against the account; an Apple push key held on the server; the push entitlement in the app. CLAUDE.md invariant 7 (a new networked dependency needs an ADR and Jay's OK) and the review gate (a new recipient) apply. It covers only items that pass the connector; items made on the Mac do not. If Jay wants it, it gets its own ADR.

What any notice may contain: fixed words only, "Something in NorthKeep needs your yes." For A, the number on the icon. Never memory text, app names, collection names, kinds or ids. For C, not even a count.

## 8. The same item on the Mac, or changed elsewhere

- Every Yes re-reads the queue and the vault (section 4, step 2), the way `applyDownSync` re-plans before applying.
- Approved on the Mac first: the Mac acks, the queue entry is gone, and the phone's re-read finds nothing: "Already decided on another device."
- Approved on the Mac, phone not yet synced: the phone's in-sync check fails until it pulls; after the pull the item is settled and gone.
- Declined on the phone, then the Mac's review: the item is no longer there.
- Either memory edited, confirmed or forgotten on another device first: after the phone pulls, the item is settled (connector-client.ts:868-870) and drops off.
- Both devices act in the same minute: the whole-vault sync limit KNOWN-LIMITS.md:253 already states. The Mac's automatic pull refuses and asks.
- The Mac keeps its review exactly as today. It gains no "keep" for forgets in this milestone (question 5).

## 9. Protocol, schema, release

- Pending protocol: no new version. The phone moves from v2 to the existing v3 (ADR 0085). Older clients: a version 3 Mac is unchanged; phone builds before this one keep asking v2 and never see the queue.
- Ack: one new request field, `keep_forgets`, and one response field, `kept`. Older clients never send it. An older connector ignores it (handled in section 4). The connector change deploys before the phone build, like every connector-first change.
- Later kinds: milestone 5's and 8's items reach the phone only in a phone build that reads the pending versions those milestones introduce.
- Schema: none. "Not now" and "Decided lately" live on the phone, outside the vault.
- Release order that matters: when milestone 5 moves the vault to schema 0.5, a phone build that understands 0.5 must be in the App Store first, or the phone refuses the vault (vault.ts:438-441).

What this needs from the App Store release Jay runs: one phone build carrying the screen, the refresh and one-item apply path, the v3 read, the `keep_forgets` call, the badge module and its permission prompt, and the version and build number bump (CLAUDE.md "Ship safely"). Nothing else.

## 10. What a background pull may do with these items (ADR 0096)

Nothing on this list applies without the person. A background pull on the Mac may apply additions, as today, and must ack the settled replaces and forgets that `planDownSync` already finds (connector-client.ts:813-819, 865-870), or a phone yes leaves the queue entry sitting until someone opens the Mac. It must never approve a replace or forget.

## 11. Trust

- The connector chooses which ids appear. It cannot make the phone show one text and apply another: the text is read from the phone's vault, and Yes refuses if the re-read text differs from what was shown.
- For a replace's new memory that is still a pending row, the text comes from the connector, which decrypts it. The connector is trusted to relay it honestly, as it already is for every addition; the person reads it before tapping.
- A level 2 answer (milestone 5) shows what the app reported the user said. The connector is trusted to relay that honestly; the person sees both memories and the result before tapping. This is the sentence the shared shapes ask to be listed for Jay (question 6).
- No needs no in-sync check because it changes no memory; a forged "No" could only drop a request, which the app can make again.

## 12. Limits for KNOWN-LIMITS

- The badge shows what the phone knew when NorthKeep last ran; nothing tells you about a new request while the app is closed.
- A forget request does not say which app asked or when; NorthKeep never recorded it.
- "When" on a replace is when the memory reached your devices, not when the app asked.
- Under question 3's "no": a yes on the phone reaches your AI apps when your Mac next syncs (the Mac app, or an AI app on the Mac that starts NorthKeep), and never if neither runs. Under "yes": within seconds, unless another device pushed first.
- Project changes still wait for the Mac.
- Not now is per phone.
- Two devices deciding at the same moment can still conflict; the Mac then asks.

## 13. Acceptance test

Runs with no AI app, on throwaway data, as test files. It fails on today's main because `listNeedsYes`, `applyYes`, `declineItem`, `clearReplaced` and `keep_forgets` do not exist.

Command:
```
NORTHKEEP_HOME="$(mktemp -d)" pnpm exec vitest run packages/sync/test/adr0095-needs-yes.test.ts apps/mobile/test/needs-yes-flow.test.ts apps/connector-server/test/adr0095-keep-forgets.test.ts
```

Set-up for the sync file: a temp `NORTHKEEP_HOME`, `Vault.create` in it, the existing fake connector (packages/sync/test/fake-connector.ts) with `keep_forgets` added. A second vault opened from a copy of the first file stands in for the Mac after a vault sync.

| Step | Call | Expected |
|---|---|---|
| 1 | remember "The harbor office is at Pier 4." in `harbor`, share, push; `fake.cloudReplace('harbor', 'The harbor office is now at Pier 9.', old.id)`; `listNeedsYes({vault, pending: await fetchPending(conn)})` | one item, kind `replace`, old line "The harbor office is at Pier 4.", new line "The harbor office is now at Pier 9." |
| 2 | `fake.requests()` | exactly one `GET /client/pending?v=3`; no `POST /client/ack` |
| 3 | `applyYes({...conn, item, shownHash})` | old row `superseded_by` is the new memory's id; `fake.replaceQueue()` still holds the entry (the phone did not ack it); no ack carries `replaces` |
| 4 | copy the vault file to the "Mac" path, open it, `applyDownSync(conn)` there | `fake.replaceQueue()` is empty |
| 5 | in the phone vault, `clearReplaced(old.id)` | both memories live |
| 6 | `fake.cloudForget(id)` for "Pat Example's slip is at Pier 4."; `listNeedsYes` | one item, kind `forget`, line that text, app shown as "a connected app" |
| 7 | `applyYes` on it | the row is forgotten in the phone vault; the forget queue still holds the id |
| 8 | the "Mac" copy from the phone's file, `applyDownSync(conn)` | the forget queue is empty |
| 9 | new replace; `declineItem` on it | queue empty; both memories live; vault file sha unchanged |
| 10 | `fake.cloudReplace` with text "‮The harbor office is now at Pier 9.\u0007" | item's new line is "The harbor office is now at Pier 9." with a space where the separator was |
| 11 | item listed; owner edits the old memory; `applyYes` with the old hash | refused with the changed message; vault file sha unchanged |
| 12 | `applyDownSync({...conn, additiveOnly: true, approve: {replace_ids: [id]}})` | unchanged behaviour: asks v2, applies no replace (the 0085 test still passes) |
| 13 | a forget of a memory in `project:pier-4` | not listed; `waiting_on_mac` is 1 |

Mobile flow file (pure TypeScript with ports, like apps/mobile/test/connect-flow.test.ts):

| Step | Call | Expected |
|---|---|---|
| 14 | Yes with the status port reporting a sha different from the local file | refused with the not-in-sync message; the apply port never called |
| 15 | Not now at 3:00 PM, then list at 11:59 PM, then at 12:01 AM (clock port) | hidden, hidden, shown |
| 16 | badge port after a refresh with two items, one hidden by Not now | badge set to 1 |

Connector file (in-memory storage, and Postgres through PGlite as apps/connector-server/test/tombstone-pg.test.ts does):

| Step | Call | Expected |
|---|---|---|
| 17 | a cloud `memory_forget` of a shared memory, then `POST /client/ack {keep_forgets: [id]}` | response `kept: 1`; `listPendingForgets` empty; the shared row still exists; a cloud `memory_list` shows the memory again. On today's main the response has no `kept` and the queue still holds the id. |
| 18 | `POST /client/ack {keep_forgets: ["not-queued"]}` | `kept: 0`; no shared row deleted |

Then, with the build on the iOS Simulator, the verifier opens the screen on a test vault seeded with steps 1 and 6 and saves a 390-point-wide screenshot of each card and the empty state. The badge on a real iPhone is Jay's step (a physical device).

## What I did not verify

- That iOS shows the badge with only the badge permission granted, that the permission prompt reads as quoted, and that a local Expo module can set the badge without a notification dependency. Not tried; no device or build was run.
- Whether App Store review asks anything about a badge-only notification permission.
- That nothing else on the Mac syncs the vault. I found vault auto-sync only in the Mac app (session.ts:55) and in MCP server processes (auto-sync.ts:47); ADR 0096's draft says the Keep Watch helper holds no key, which I did not check.
- That `clearReplaced` can tell a mark from an edit with the fields the vault has. The rule in section 6 is a sketch; the build must prove it with a test on a row edited and then marked.
- The final shapes of ADRs 0092, 0094 and 0096. They are being revised beside this one; I read the 0092 and 0094 drafts in the clone (dated before the round 3 brief), and 0096's short ADR and the parts of its record that mention the phone, which appeared while I wrote. 0096's record says in one place that the background pull acks settled replaces and forgets (its D3) and in another that it "never acks or settles any of them"; this design relies on the first.
- Whether `planDownSync` can run its replace and forget planning on the phone without its additive gates touching project rows. The one-item path is described, not written.
- Every line number above was read on main at 1089445; none was run.

## Review log

No review yet. Before build this needs the ADR and an adversarial review: it changes who decides (the phone may now apply a cloud replace or forget) and it puts text an AI app wrote in front of a person on a review surface. The reviewer should start from sections 4, 5 and 11, and try: a connector that swaps ids between list and Yes; a memory whose text imitates the card's own words; two devices deciding at once; a phone with no sync server.

## Agreed across ADRs 0092, 0094, 0095 and 0096

The shared shapes from the round 3 brief, as this design uses them. My proposals for the other three are marked "proposed".
- Build order: 0096 and 0095 first, then 0092, then 0094. 0095 takes no schema step; 0092 keeps 0.4 to 0.5.
- The chat mark is `confirmed: {by: "chat", app, at}`, with an optional `question` id set only by 0092. `app` is the stored source form. `isConfirmed` means `by: "user"` only. The command line says "confirmed in chat". `isOldAgentNote` does not demote a chat-confirmed or user-confirmed note.
- On the connector path the mark travels as one envelope field `chat: {app, at}`, only on a chat-confirmed row. Pending version 4 is introduced by the first of these designs that adds a pending field, and each later one that adds a field takes the next. 0095 adds no pending field: it reads the existing v3. Its one change is the ack field `keep_forgets`, which needs no version because an older connector's reply lacks `kept`.
- Level 2 is the one shared rule: the pair or answer touches a user-confirmed memory; or a waiting cloud replacement names either memory; or the differing words or the answer include a digit; or a word from the shared list appears (own, co-own, owner, share, stake, shareholder, member, partner, llc, inc, ltd, corp, account, bank, loan, mortgage, lien, deed, title, lease, landlord, tenant, rent, trust, will, estate, tax, contract, agreement, court, lawsuit, sue, custody, divorce, attorney, salary, wage, debt, owe, dollar, percent, and $ % € £). Interview keys work, organizations, advisers, dealings, disputed, companies and properties always wait. Level 2 is settled on this phone list and by the existing command-line confirm; no design says "in the Mac app" for confirming.
- What a cloud app asks for takes effect only at a pull. The background pull (0096) may apply additions and ack settled items; it never approves a replace, a forget, a level 2 answer or a waiting interview answer.
- Trust in the hosted connector: a change to an existing memory arriving from the connector with no person's yes on a device applies only if the device re-derives it from its own record, at most three per pull, each listed. A yes on this list is a person's yes on a device. The connector is trusted to relay answers honestly; listed for Jay.
- Text an AI app wrote is never NorthKeep's voice: whitespace flattened before control and direction characters are removed; app names without quotes or brackets; record-shaped text refused on every write path and never listed here.
- No chat answer takes effect before an undo exists; the undo covers a chat mark with no question id (an unmark command and this list's Undo); it refuses to bring back a memory whose replacing row the user has since forgotten.
- Proposed: every waiting item 0092 and 0094 create lives in 0092's question table, with kind `pair` or `confirm`, memory ids, app, time, and for `pair` the reported answer, so this list has one reader in the vault.
- Proposed: this milestone builds `clearReplaced`, the replace half of the undo primitive; 0092 builds its command, its Mac action and the chat-mark half, and makes it remove a user mark too.
- Limits a design accepts go to Jay as yes/no questions.

## Decisions waiting for Jay

1. **Mock approval: do you approve the screen described in section 2 (one list, cards with Yes, No, Not now, a "Decided lately" section, a count row on Projects and Memories, an icon badge)?** A mock comes to you before build. Recommend yes once you have seen the mock. Yes: build to the mock. No: the mock is redrawn; nothing is built.
2. **Is a badge that updates only while NorthKeep runs enough for now, with a push notification left for its own ADR?** Recommend yes: no new recipient, no new dependency. Yes: option A. No: a push ADR comes first; Apple (and maybe Expo) become recipients of a fixed-text notice, and this milestone waits for it.
3. **After a yes, should the phone update your AI apps itself (push its Shared collections to Cloud Connect, only after a clean vault push, with the same check sharing uses), instead of waiting for the Mac?** Recommend yes: the first outside customer may never run anything on a Mac. Yes: a yes reaches cloud apps within seconds; the phone pushes content it already shares more often. No: a yes reaches cloud apps only when the Mac app or a local AI app runs NorthKeep, and on a phone with no sync server, never; KNOWN-LIMITS says so.
4. **Should a replace approved on the phone be undoable from the first build, by building the replace half of the undo here instead of in milestone 5?** Recommend yes. Yes: as written; milestone 5 reuses it. No: a phone replace cannot be undone until milestone 5, the same as a Mac approval today.
5. **Should "Keep it" for a cloud forget exist on the phone only in this milestone, with the Mac and command line still offering only approve or leave waiting?** Recommend yes: smallest change. Yes: as written. No: the Mac review and `share sync` gain "keep" in the same milestone.
6. **Do you accept that the connector service is trusted to relay what an app reported you said, so the phone shows it and you decide?** Recommend yes: you see both memories and the result before tapping. Yes: as written. No: level 2 answers on the phone show only the two memories and you pick, ignoring the reported answer.
7. **Do you accept that a forget request says only "a connected app asked", with no app name or time, and that "when" on a replace is when it reached your devices, not when the app asked?** Recommend yes for now. Yes: as written. No: the connector records the app with each forget request and sends both queues' own times, in a new pending protocol version, before this ships.
8. **Is it acceptable that project changes from cloud apps (new versions of a project document, conflicts, forgets inside a project) still wait for the Mac's review, with only a count on the phone?** Recommend yes for this milestone: those need the larger preview screens ADR 0063 describes. Yes: as written; the phone shows "N changes to projects wait for your Mac". No: a later milestone designs project review on the phone.

## Reconciled by the lead (2026-11-25)
The four records were written side by side. Where one disagrees with this section, this section is the intent and the next review should flag the sentence.
- Build order: ADR 0096 (background pull), ADR 0095 (phone list), ADR 0092 (milestone 5), ADR 0094 (milestone 8). ADR 0093 (milestone 6) is not decided and is stale against these four; nothing here depends on it.
- Schema steps: 0092 takes 0.4 to 0.5 and 0094 takes 0.5 to 0.6. 0095 and 0096 take none. Each schema step locks out older phone builds, so a phone build that understands the step must be in the App Store before the Mac release that makes it. The phone list of 0095 is one phone release; 0092 and 0094 each need another unless they ship together.
- Pending protocol: 0095 moves the phone from version 2 to the existing version 3. 0092 introduces version 4. 0094 introduces version 5.
- The step that clears a replaced mark is called `clearReplaced` everywhere and is built in 0095, the first milestone that needs it. 0092 adds the undo of a chat answer and the removal of a chat mark on top of it.
- Every answer or interview item that waits, for any reason, appears on the phone list of 0095, read from one place in the vault (0092's question table, with a kind for a pair and a kind for a single memory to confirm). "Level 2" in 0095 means every waiting reason 0092 and 0094 name.
- "Listed word" means a word that begins with a listed stem, after splitting on anything that is not a letter or digit and dropping a trailing 's; the whole text is checked, not only the differing words; any digit waits.
- The background pull of 0096 may apply new memories and acknowledge items already settled in the vault. It never approves a replacement, a forget, a waiting answer or anything about a project.
- Nothing on the Mac runs all the time with the vault key. A pull happens only while a local AI app's NorthKeep server or the Mac app is running and unlocked, or when the phone syncs. A person who runs none of those gets nothing from 0096. That limit is a decision for Jay in each record that depends on it.
