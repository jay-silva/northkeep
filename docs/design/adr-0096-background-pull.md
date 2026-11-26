# Design record: ADR 0096, background pull

Prerequisite for milestones 5 and 8 of relaunch step 1. Drafted 2026-11-25 against main at 1089445. Design only: nothing here is built. Every "today" statement was checked against the code at 1089445 with file and line; anything I inferred rather than read says so. Examples use made-up names only (the harbor office, Pier 4, Tidewater Boats LLC).

## In one screen

Today a memory that a cloud app (Claude on the web, ChatGPT, Grok Bot) saves through Cloud Connect sits on the connector until a person pulls it: Sync now in the Mac app, `northkeep share sync`, or the phone's sync button. The automatic engine that keeps Cloud Connect current only pushes.

This design lets that same engine pull too, with no person present, and keeps it as small as the code allows:

- **Who pulls.** The automatic Cloud Connect engine, in the two hosts that already run it all session: the NorthKeep server each local AI app starts (Claude Desktop, Claude Code, Codex, Cursor), and the Mac app's own server while the app is open. Not the command line. Not the Keep Watch helper, which cannot.
- **When.** Only on triggers that exist today: launch, unlock, and each time automatic sync pushes the vault, pulls it, or finds it in sync. No timer.
- **Only from a current device.** It pulls only when this device holds exactly the newest vault, the same rule the engine already uses before it pushes.
- **What it applies.** New memories only, in collections already Shared on this device, within the connector's size cap, at most 50 per pull. The rest wait for the next trigger.
- **What it never applies.** Project documents, new projects, the ADR 0050 fold that marks a private project Shared, forgets, project replacements, and cloud replaces. They stay waiting for a person; ADR 0095 lists them on the phone.
- **What it does clear.** A waiting forget or replace that no longer applies on this device (for example because the person said yes on the phone, ADR 0095) is acknowledged, exactly as Sync now does today without asking. That changes nothing in the vault; it only lets the connector drop the dead item.
- **Safety at the lock.** No network call while it holds the vault lock, so an app's save or search is never stuck behind a slow connector. Until the connector confirms a memory was received, the device remembers that it saved it, so a failed confirmation never brings back a memory the person forgot in the meantime.
- **How the person learns.** A line on the Cloud screen and in `northkeep share status`: when it last pulled, how many it added, how many wait. No notification.
- **What it does not fix.** If no NorthKeep process is running (Mac app closed and no local AI app open), or the vault is locked, nothing pulls. A customer who uses only cloud apps and never opens the Mac app or a local AI app gets nothing from this design.

No schema step. No new protocol version: it reuses pending v3, the version the Mac's own Sync now asks for, so a version 3 Mac, the phone on version 2 and an older connector see nothing new, and an older NorthKeep server simply never pulls. No new content leaves the machine.

## What the code does today (checked)

### Who pulls cloud writes into the vault

- The Mac app's Sync now: `POST /api/share/sync` (apps/web/src/api.ts:1175-1249). It previews by default (api.ts:1199-1204), checks the device can push (api.ts:1206), then calls `applyDownSync` inside `session.withVault` (api.ts:1207-1211).
- The command line: `northkeep share sync` (packages/cli/src/shareCmd.ts:283-343): checks the device can push (shareCmd.ts:298), fetches (shareCmd.ts:304), plans under the vault (shareCmd.ts:305), asks only when `planNeedsConfirmation` is true (shareCmd.ts:311), then applies under `withVault` (shareCmd.ts:321).
- The phone: additions only, when the person taps sync (apps/mobile/src/lib/vault-session.tsx:1401-1434, `additiveOnly: true` at 1424).
- Also, not in the brief's list: "take theirs" on a project conflict pulls that one cloud document (apps/web/src/api.ts:1284 onward; `northkeep share resolve`, packages/cli/src/index.ts, `share resolve`).
- Nothing else. The automatic Cloud Connect engine says in its header that it "pushes only, never down-syncs" (packages/sync/src/connector-auto.ts:10-21).

### Why the engine only pushes

No ADR states a reason for push-only; the design record lists it as scope (docs/design/sync-guardrails.md:374-376). The reason I infer from the decisions around it: ADR 0063 D3 requires a preview before any replace or forget, and the engine has no screen; the founder decision in ADR 0063 (SPEC/decisions/0063-sync-guardrails.md:15) kept the phone to "additions only until it has a preview screen", which is the same shape this design uses. ADR 0044 D4 adds "No background timers" (SPEC/decisions/0044-automatic-sync.md:12), and KNOWN-LIMITS.md:384-388 publishes it: "Wake means launch, unlock, or return to the app, not a schedule."

### What a pull applies with no yes today

- `planNeedsConfirmation` is true only for project replacements, forgets and cloud replaces (packages/sync/src/connector-client.ts:505-508). The plan's own comment: "Additions, dedupes and discards need no confirmation" (connector-client.ts:474-478).
- "Additions" in the code are wider than new memories. They include a new project document from a base-`new` row (connector-client.ts:800-808) and every row of an ADR 0050 fold, whose scope is then marked Shared (connector-client.ts:731-734, mark at 1013-1017).
- The Mac app applies additions without any preview when nothing needs confirmation: it goes straight from the preview call to apply (apps/web/static/index.html:8125-8132). The command line asks only when `planNeedsConfirmation` is true (shareCmd.ts:311). So no surface today shows a person each new memory before it lands.
- A memory row in a collection that is not a project is treated as applicable whether or not that collection is Shared on this device (connector-client.ts:706). The connector refuses a cloud write to a collection the device has not shared (apps/connector-server/src/mcp.ts:505-524), so today the device relies on the connector for that.
- Dedupe is by exact text among live rows in the same collection (connector-client.ts:744-745). `vault.list` leaves out forgotten and replaced rows unless asked (packages/core/src/vault.ts:1934-1939).
- Each pulled memory is saved with `source: connector:<host>` and `metadata.connector = {server_id, app}` (connector-client.ts:964, 981).
- `applyDownSync` saves before it discards or acks (connector-client.ts:1066-1075), so a failure after the save is retried.

### What "a person started it" was doing

| Guard | Did the person's presence do safety work? |
|---|---|
| Review of each new memory | No. Additions apply unreviewed on the Mac (index.html:8125-8132) and the command line (shareCmd.ts:311). |
| Size limits | No. The connector refuses a cloud memory over 8 KB at write time (apps/connector-server/src/mcp.ts:72, 471-474). The device's own caps mirror it (packages/core/src/agent-write-limits.ts:10-11, 24-34). |
| A flood from a misbehaving app | Little. The connector caps an account at 5,000 rows (mcp.ts:73, 525-531) and each token at 120 requests per 5 minutes (apps/connector-server/src/create-server.ts:90-91, 103). The person saw only a count after the fact. |
| ADR 0050 fold (a private project marked Shared with no dialog) | Partly. It applies without a yes, but the person is told right after: "now marked Shared" (shareCmd.ts:338-343; `newly_shared` at api.ts:1247). With nobody present that notice is lost. ADR 0050 also records that under multi-device lag a fold "can include another device's private memories" (SPEC/decisions/0050-hosted-project-creation.md, What leaves the machine). |
| Holding the vault lock across network calls | Yes. Every pull today calls `applyDownSync`, which fetches and acks over the network (connector-client.ts:947, 1067-1075), inside the vault lock (api.ts:1207 with apps/web/src/session.ts:166-180; shareCmd.ts:321). The phone's code says so and accepts it only because the pull is "user-initiated" (vault-session.tsx:1407-1412). |
| Device is current | Yes, but a check does the work, not the person: `assertDeviceCanPush` refuses behind or diverged (packages/sync/src/connector-push.ts:48-54). |

The lock matters most. Another process waits at most 5 seconds for the lock and then fails, and a lock older than 60 seconds is taken over even if its owner is alive (packages/core/src/lock.ts:10-12, 75-86). Each connector call may take up to 30 seconds (connector-client.ts:36). A local AI app's save or search runs inside the same lock (packages/mcp-server/src/server.ts:342). A background pull that held the lock across the network could make another app's save fail, or, past 60 seconds, let two processes write the whole vault file at once.

### Which processes run on the Mac

- **The NorthKeep server each local AI app starts.** It starts the sync engine and the Cloud Connect engine (packages/mcp-server/src/server.ts:1801; packages/mcp-server/src/auto-sync.ts:41-60) and runs one wake at start (server.ts:1807). It exits when the app closes its input (server.ts:1889-1895). Several run at once, one per open app session. It has the vault key only from the Keychain or an environment variable (auto-sync.ts:39; packages/mcp-server/src/key.ts).
- **The Mac app's own server.** It runs both engines too (apps/web/src/session.ts:50-62) and wakes at launch and unlock (apps/web/src/server.ts:136-142; api.ts:668-672). The shell stops it when the app exits (apps/desktop/src-tauri/src/main.rs:280-289). I found no code that keeps the app running after its window closes (main.rs has no `ExitRequested` handling), so I read it as quitting with its window; not run.
- **The Keep Watch helper.** A root launchd script that only runs `pmset -a disablesleep 0` (apps/web/src/keep-watch.ts:19-34, 141-144). It has no vault key and no NorthKeep code. ADR 0080 commits that turning Keep Watch off is its only privileged action. It cannot pull and must not.
- **The command line.** A short-lived process; after a write it runs the Cloud Connect engine once (packages/cli/src/autoPush.ts:97-120).

So there is no process that is always running and holds the key. The one that runs most is the local AI app server, and only while such an app is open.

### The engine's rule for "this device holds the newest vault"

With vault sync configured, the engine stops when automatic sync reports a pull waiting for review, a diverged vault, or is off, paused or in error (connector-auto.ts:271-278). Then it asks the sync server and requires exactly `in-sync`, because "two devices can each be ahead of one version" (connector-auto.ts:279-287). With no vault sync, this device is the only copy and needs no check (connector-auto.ts:262-268). It makes no network call at all when nothing is Shared (connector-auto.ts:253-261).

With no vault sync, the Cloud Connect engine runs only after a local save (connector-auto.ts:151-156): the sync engine's wake returns at once with no sync configured (packages/sync/src/auto.ts:455-460), so nothing calls the Cloud Connect engine at launch.

### The acknowledgement and ids

- The ack renames the connector row to the vault id and clears its pending flag. Acking a row already renamed changes nothing (apps/connector-server/src/neon-storage.ts:818-856).
- The ack also re-points any waiting cloud replace and forget that named the old connector id (neon-storage.ts:846-855), so a replace whose new memory was pulled still names it.
- Cloud memory ids are random (`conn_` plus a random UUID, mcp.ts:622). A cloud-created project's id comes from its scope (ADR 0050 D2), so it can repeat.
- A push makes the connector's copy of each Shared collection match the device, deleting rows the push does not carry, except undelivered cloud writes (create-server.ts:772-775; connector-push.ts:116-122).

## The design

### Which process pulls, and when

The Cloud Connect engine (`ConnectorAutoPush`) gains a pull step, switched on by its host. The local AI app server (packages/mcp-server/src/auto-sync.ts) and the Mac app's server (apps/web/src/session.ts) turn it on. The command line's one-shot push does not: a command should finish quickly, and `northkeep share sync` is its pull.

Triggers are the ones the engine already has: `wake()` and `onVaultCurrent()` (connector-auto.ts:158-166), that is launch, unlock, and each automatic vault push, pull or in-sync check. One addition: both hosts call the Cloud Connect engine's `wake()` at launch and unlock, beside the sync engine's wake. Without it a device with no vault sync would pull only after a local save.

No timer. ADR 0044 D4 and KNOWN-LIMITS.md:384 promise no background schedule, and a timer would change that claim. For the owner, local AI app sessions start many times a day, and each start is a pull. A timer is a question for Jay below.

The pull follows the existing `share auto on|off` switch (packages/sync/src/connector-config.ts:118-127). Off means no pull and no push, as today.

The same engine runs on Linux and Windows desktops; the design is not Mac-only, though the title follows the brief.

### Order inside one run

1. The existing gates, unchanged: configured and switched on (connector-auto.ts:237-241), unlocked (247-251), something Shared (257-261), and with vault sync, exactly in sync (271-287).
2. Entitlement, as today (connector-auto.ts:289).
3. **Pull** (new): fetch the pending rows with no lock held. Then, under the vault lock on a freshly opened vault, plan, apply and save, with no network call. Then, with the lock released, send the ack.
4. If the pull added anything, end the run here and note that the next run must skip the pull once. The save fires the save hook (auto-sync.ts:55-60), automatic sync pushes the vault, and its `pushed` event runs the engine again (auto-sync.ts:52). That run skips the pull and pushes Cloud Connect with the new vault version. With no vault sync, the save re-arms the engine directly (connector-auto.ts:151-156) with the same effect. Pushing in the same run as the pull would label the new rows with the older vault version checked in step 1. Skipping the pull in the run its own save caused keeps a backlog from draining in one unbroken chain of vault uploads (see The cap).
5. Otherwise, continue to the existing no-change check, manifest read and push (connector-auto.ts:265-320).

The pull must sit before the no-change early return at connector-auto.ts:265-268, or a device with no vault sync would never pull while nothing changes locally.

### What it may apply with no person present

It fetches the same pending version the Mac's own Sync now asks for (v3 today, with the replace queue, falling back to v2 at connector-client.ts:562-568). It plans exactly as Sync now plans (`planDownSync`, connector-client.ts:674) and then takes from the plan only three things. Everything else in the plan is left alone.

First, additions, but only those that pass all of these:

- a new memory (`kind: 'memory'`), never a project document (`kind: 'project'`);
- not in a collection the ADR 0050 fold would mark Shared (`plan.to_mark`);
- in a collection already Shared on this device (`vault.sharedScopes()`), so the device stops relying on the connector's scope label (connector-client.ts:706);
- within the device's own size cap for that collection (`sharedEntryTooLargeMessage`, agent-write-limits.ts:24-34), so an oversize row cannot stall the next push;
- within the first 50 such memories in the order the connector lists them.

Each one is saved exactly as a person-started pull of the same build saves it: same `source`, same `metadata.connector` (connector-client.ts:964, 981). If a later ADR lets a new row carry a mark (ADR 0094's chat mark on an interview answer), the background pull applies that mark only as that ADR's own device re-check allows, the same as a person-started pull.

Second, memory dedupes: a cloud memory whose text is already a live row in the same collection is acked against it, as today (connector-client.ts:744-745). Project document dedupes are not taken.

Third, settled items: forgets for an entry no longer live here (`settled_forgets`, connector-client.ts:487-488, 814-819) and cloud replaces that can no longer apply because a side was replaced or forgotten here (`settled_replaces`, connector-client.ts:491-492, 868-871). Sync now acks both with no question today (connector-client.ts:1019, 1034). Acking them changes nothing in the vault. ADR 0095 needs this: its phone yes "never acks", and the Mac's next pull settles the queue (0095 draft, D3). Without it, a yes given on the phone would sit in the connector's queue until someone ran Sync now. Because the pull runs only on a device holding exactly the newest vault, "no longer live here" cannot mean "not yet synced here from another device".

Nothing else is acked, applied or discarded. In particular no project document stale or legacy row is discarded.

### Remembering what was saved until the ack lands

The problem: today, if a pull saves and then its ack fails, and the person forgets or edits that memory before the next pull, the next pull finds no live identical text (vault.ts:1934-1939; connector-client.ts:744) and adds it again. Inferred from the code, not run. A background pull retries without anyone watching, so it would hit this more often.

The memory's own `metadata.connector.server_id` cannot fix it: `forget` blanks the row's text and metadata (packages/core/src/vault.ts:595). An edit keeps the old row's metadata; a forget does not.

So the device keeps a short list, "saved, not yet acknowledged": connector id to vault id, for cloud memories only. It lives in the device's connector settings file (connector-config.ts), is written under the vault lock right after the save, and each entry is removed once an ack for it succeeds. Before adding a cloud memory, a pull on this device checks the list. If the connector id is there and that vault id still exists in the vault, live, forgotten or replaced, the pull acks the connector row against it and adds nothing. After that ack, the next push leaves a forgotten row out and the connector drops it. If the vault id no longer exists at all (the vault file was replaced by another device's copy that never had it), the entry is dropped and the row is planned as usual.

Crash safety: the list is written after the save, never before. A crash between the two leaves today's behaviour (dedupe by identical live text). Writing it before the save could ack a row against a vault id that was never saved, and the next push would then delete that memory from Cloud Connect.

Background pulls use the list. Sync now and the command line's sync should use it too once they take the split form; that is a build choice. Limit: the list is per device. If another device pulls in the window between this device's save and its ack, and the person forgot the memory meanwhile, that other device can still add it again.

This covers cloud memories only. A cloud-created project's id repeats per collection (ADR 0050 D2), and a project deleted here already waits as a question ("deleted on this Mac", connector-client.ts:800-806).

### What it never applies

Anything `planNeedsConfirmation` covers (project replacements, forgets, cloud replaces), plus: new projects, folds, project conflicts, project document dedupes and discards, held rows, rows of a type NorthKeep does not store, memories in collections not Shared here, oversize memories, and memories past the cap. All of them stay on the connector, unacked, for a person-started pull or, for a yes, ADR 0095's phone list. The only forgets and replaces it acks are the settled ones above, which change nothing here.

A cloud replace whose new memory the background pull added stays valid: the ack re-points the queue to the vault id (neon-storage.ts:853-855), so the next person-started pull shows it with both sides live.

### The cap

At most 50 new memories per pull. The rest wait for the next trigger, oldest first in the connector's order. The run caused by the pull's own save skips the pull (Order inside one run, step 4), so the next pull comes from a real trigger: a launch, an unlock, a local write, or another device's change arriving. Reasons:

- It bounds how long one pull holds the vault lock (one save, at most 50 rows).
- It bounds the follow-on work. Every pull that adds anything causes one whole-vault upload to the sync server, as any save does, plus about two connector requests. Without the skip, a 5,000-row flood would chain about 100 uploads in a row and run into the device token's 120 requests per 5 minutes (create-server.ts:90-91) around row 3,000.
- It slows a flood. A misbehaving app can still land up to the connector's 5,000-row account cap (mcp.ts:73) over many triggers, with nobody looking. Today one click of Sync now lands the same rows at once, also unreviewed.
- ADR 0094's interview has 21 questions (SPEC/decisions/0094-welcome-interview.md, draft D1), so a whole interview fits in one pull.

Stopping all background pulls at a large backlog is a question for Jay below. I recommend against it: a person who never opens the Mac app would never catch up.

### How the person learns it happened

The pull records, in the device's connector settings file beside `last_pushed_at` (connector-config.ts:101-106, 129-133): when it last pulled, how many memories it added, how many changes still wait, and the last error if any. Counts and times only, never text or collection names. The counts are written under the vault lock right after the save, so two processes do not overwrite each other mid-write. An ack error is written after the ack, outside the lock; if two processes race there, the later write wins, which costs at most one stale error line.

It is shown in:

- `northkeep share status`, one line under "Automatic updates" (shareCmd.ts:560);
- the Cloud screen, through the engine status the Mac app already serves (api.ts:1060, 1341-1350), one more line under "last pushed";
- one line on the local AI app server's error output, counts only, like its existing event lines (auto-sync.ts:76-85).

Each added memory also carries its app name, which the Mac app's memory list already shows "as the app reported" (KNOWN-LIMITS.md:28).

No notification. The memories are ones the person's own cloud app already told them it saved, and additions already land unreviewed today. A notice on every pull would be noise. The things a person must act on are the waiting changes, and ADR 0095's phone list owns those.

The phone does not see this record: it is per device and does not sync.

### Vault sync between devices

The pull uses the engine's existing rule unchanged: with vault sync, only when this device is exactly in sync and automatic sync is healthy (connector-auto.ts:271-287); with no vault sync, always (the only copy). A behind or diverged device makes no pending request at all.

After the pull the device is one change ahead, and automatic sync pushes the vault as after any save. If another device pushed between the in-sync check and the apply, this device becomes diverged. Automatic sync then reports it and pulls nothing over it (packages/sync/src/auto.ts:27-31). Stale data cannot reach Cloud Connect: the engine does not push while diverged (connector-auto.ts:282), and the connector refuses a push from an older vault version (KNOWN-LIMITS.md:1443-1451). Sync now has the same window today, between `assertDeviceCanPush` and the apply, and so does any app's save. What follows matters more for the person this design is for: a diverged Mac stops both the automatic Cloud Connect push and the background pull (connector-auto.ts:275, 282) until a person syncs by hand, which someone who never opens the Mac app may never do. The phone tapping sync while the Mac pulls is another way into the same state. This is listed for Jay below.

### Older processes, and two at once

An older local AI app server keeps the code it started with (CLAUDE.md:138-142). It has no pull step, so it never pulls. Its push can race a newer process's ack: if it took its snapshot before the newer process saved, its push deletes the just-acked rows on the connector until the newer process's vault push and Cloud Connect push restore them. That is the existing limit at KNOWN-LIMITS.md:1458-1461 ("Cloud Connect drops that memory briefly"), now likelier while two generations run. No content is lost: the rows are in the vault.

Two new processes pulling at once, say Claude Desktop and Claude Code both open:

- Both may fetch the same rows. Only one holds the vault lock at a time, and each plans against a freshly opened vault.
- The second finds the first one's row on the "saved, not yet acknowledged" list, or by identical text, and acks against it. It never adds a second copy.
- Both acks are safe: the second renames nothing (neon-storage.ts:818-856).
- A person-started pull running at the same time holds the lock across the network as today. The background pull then waits up to 5 seconds, fails, records the error, and tries at the next trigger.

No schema step is needed: the one new piece of state, the "saved, not yet acknowledged" list, lives in the device's connector settings file, not the vault. So no older server is retired by this design.

### Failures

- A pull error (network, 401, 402, 409, a lock timeout) is caught inside the pull step, recorded, and logged without content. The run continues to the push step, which handles 402 and 409 as it does today (connector-auto.ts:321-328). A pull error never sets the engine's push pause.
- The engine runs on its own chain, never inside a tool call (connector-auto.ts:216-220; server.ts:1807 does not await it). An app's save or search never waits on the network for it and never fails because of it. It can wait on the vault lock while a pull saves, as it can wait behind any other save today.
- If the save succeeds and the ack fails, the rows stay pending and the next pull acks them against the saved rows.
- A locked vault means no pull, as for the push (connector-auto.ts:247-251).

### What leaves the machine

No new content and no new recipient. The ack already carries connector ids and vault ids on every Sync now.

New traffic: one `GET /client/pending` per engine run that passes the gates, and one `POST /client/ack` when something was added, matched or found settled. These go from the device's own connector token, which shares the 120-per-5-minutes budget with the device's pushes (create-server.ts:90-91, 103), not with the cloud apps' own tokens.

What the connector learns, beyond ADR 0063's list (which already includes "when devices wake or pull"): when a local AI app session or the Mac app starts on this device with the vault unlocked, and how soon a cloud write reaches the vault, now without a person pressing anything.

What the device trusts: the connector service to relay what cloud apps wrote honestly. With no person present, a dishonest or compromised connector could add up to 50 memories per pull to collections Shared on this device. It cannot replace, forget, mark Shared or touch private collections through this path. This sentence is listed for Jay below.

### What this does not fix

- No NorthKeep process running: the Mac app closed and no local AI app open, or the Mac asleep or off. Nothing pulls. Cloud memories wait on the connector.
- A locked vault: a local AI app server without a stored key (Keychain opt-out, ADR 0075) never pulls.
- **A customer who works only in cloud apps** and never opens the Mac app or a local AI app with NorthKeep. This design gives them nothing. Their memories live on the connector until a person-started pull (Sync now, `northkeep share sync`, or a tap on the phone). Anything milestones 5 and 8 need applied in the vault does not happen for them. Only an always-running login helper that holds the key could change that, which is a larger design with its own key-handling review.
- A behind or diverged device.
- Anything that waits for a yes (ADR 0095's phone list).

### What changes, file by file

- packages/sync/src/connector-client.ts: split `applyDownSync` into a network fetch, a lock-only apply that takes the fetched snapshot and returns the ack body, and a network ack; the person-started paths may keep calling the combined form. Add the "saved, not yet acknowledged" check to `planDownSync` for `kind: 'memory'` rows. Add the background selection from a full plan: filtered memory additions (memory, Shared here, not folded, size cap, first 50), memory dedupes, settled forgets and settled replaces.
- packages/sync/src/connector-auto.ts: a host option that turns the pull on; the pull step in `run()` in the order above, with the skip-once after a pull that added; pull status in `status()`.
- packages/sync/src/connector-config.ts: write and read the last-pull record and the "saved, not yet acknowledged" list.
- packages/mcp-server/src/auto-sync.ts and server.ts; apps/web/src/session.ts and server.ts: turn the pull on and call the Cloud Connect engine's wake at launch and unlock.
- packages/cli/src/shareCmd.ts: the status line. apps/web/static/index.html: the Cloud screen line.
- KNOWN-LIMITS.md: the connector section (1413-1426) and automatic sync section (384-388) say that this device brings in new cloud memories on its own while a NorthKeep process runs, what waits, and what this does not fix.

## Acceptance test

An agent runs this with no AI app in the loop, on throwaway data, against the fake connector. It is one new test file, `packages/sync/test/adr0096-background-pull.test.ts`, modelled on `packages/sync/test/adr0063-autopush.test.ts` (fake sync server, fake connector, two device homes, the `engines()` helper at lines 104-142 that wires `AutoSync` and `ConnectorAutoPush` the way the hosts do) and `packages/sync/test/adr0085-cloud-replace.test.ts` (the cloud replace queue). Plus one step in `packages/mcp-server/test/auto-sync.test.ts` for the host wiring. It uses only options that exist today (`clock`, `debounceMs`, `loadDeviceSecret`) and the existing `NORTHKEEP_MASTER_KEY` key source; it adds no test-only switch to shipped code. It names no CLI command.

Run from the repo root after `pnpm install --frozen-lockfile && pnpm build`:

```
pnpm exec vitest run packages/sync/test/adr0096-background-pull.test.ts packages/mcp-server/test/auto-sync.test.ts
```

Setup in `beforeEach`: `NORTHKEEP_HOME` is a fresh `fs.mkdtempSync` directory, as in adr0063-autopush.test.ts:33-35. Mac A's vault has a memory "The harbor office is at Pier 4." in collection `harbor`, marked Shared, and a memory in `private`, not Shared. Vault sync points at the fake sync server and the vault is pushed (in sync at version 1). The connector points at the fake connector, and `harbor` is pushed once so the connector holds a device row there. Engines come from the `engines()` helper with the pull turned on. "Settle" means the helper's `settle()`.

1. **A new cloud memory lands.** `conn.cloudRemember('harbor', 'Tidewater Boats LLC keeps the spare keys at Pier 4.', 'semantic', 'Example Cloud App')`, then `auto.wake()` and settle. Expect: `vault.list({ scope: 'harbor' })` has exactly one row with that text, `source` `connector:127.0.0.1`, `metadata.connector.app` `Example Cloud App`; the connector row is no longer pending and its id is that vault id; the vault is at version 2 on the fake sync server; `conn.pushes()` has one accepted push carrying version 2 and none carrying version 1 after the cloud write; the last-pull record reads added 1, waiting 0. **On today's main this fails:** no row is added and `conn.requests()` contains no `/client/pending`.
2. **What waits stays waiting.** `conn.cloudReplace('harbor', 'The harbor office is now at Pier 9.', <Pier 4 id>)`; `conn.cloudForget(<a pushed harbor id>)`; `conn.cloudCreate('project:tidewater', <a valid project document>)` for a project not on this device; `conn.cloudRemember('private', 'Pat Example parks in lot B.')`; `conn.cloudRemember('harbor', <9,000 bytes of text>)`. Settle after a wake. Expect: the Pier 9 memory is added (it is a new memory); `conn.replaceQueue()` still has 1 entry, now naming two vault ids; the Pier 4 memory is not replaced; the forgotten memory is still live; `vault.sharedScopes()` does not include `project:tidewater` and the vault has no row in it; no row in `private` from the connector; no 9,000-byte row; the last-pull record's waiting count is at least 4.
3. **Behind: no pull.** Device B pulls, writes, and pushes the vault. Run A's engine once. Expect: status reason `behind`; `conn.requests()` has no `/client/pending` since the step began.
4. **Cap.** Fifty-five `conn.cloudRemember('harbor', 'Pier 4 note N', ...)` with N from 1 to 55. `auto.wake()`, then settle. Expect: exactly 50 added (`Pier 4 note 1` to `Pier 4 note 50`); 5 recorded waiting; Cloud Connect received one accepted push carrying the 50; and `conn.requests()` shows exactly one `/client/pending` during the settle. Then `auto.wake()` and settle again. Expect: the other 5 added, 0 waiting.
5. **Two engines on one vault.** Build two `engines()` sets on Mac A's vault. `conn.cloudRemember('harbor', 'Harbor office fax is retired.')`. Wake both at once and settle both. Expect: exactly one live row with that text.
6. **Failed ack, then forget.** `conn.failNext('/client/ack', 500)`, `conn.cloudRemember('harbor', 'Pier 4 gate code changes monthly.')`, wake, settle. Expect: one row added; the connector row still pending; the record holds an ack error. Forget that row through `vault.forget(id)` and save. Wake and settle. Expect: no live row with that text; the connector row acked against the forgotten row's id; the "saved, not yet acknowledged" list is empty. On today's main a person-started `applyDownSync` in the same position adds the memory a second time.
7. **No network inside the lock.** Wrap `globalThis.fetch` in the test file so that each request to `/client/pending` or `/client/ack` records whether `<vault>.lock` exists at that moment. Run step 1's scenario. Expect: every recorded value is `false`.
8. **A failed pull does not stop the push.** `conn.failNext('/client/pending', 500)`. Write a new Shared memory on Mac A and settle. Expect: Cloud Connect receives the push with the new memory; the engine status is not `error` for the push; the last-pull record holds an error.
9. **A yes given elsewhere is settled.** `conn.cloudReplace('harbor', 'The harbor office is now at Pier 9.', <Pier 4 id>)` and `conn.cloudForget(<a pushed harbor id F>)`; wake and settle (the Pier 9 memory lands; both items wait). Then, standing in for the phone's yes (ADR 0095) or `northkeep confirm`, on Mac A's vault directly: `vault.markReplaced(<Pier 4 id>, <Pier 9 vault id>)`, `vault.forget(F)`, save. Settle. Expect: `fetchPending({ server: conn.url(), deviceSecret })` returns no forgets and `conn.replaceQueue()` is empty; the vault is unchanged by the pull (same live rows before and after it). On today's main the queue keeps both until a person-started pull.
10. **Switch off and nothing shared.** `setConnectorAutoPush(false)`: a wake makes no `/client/pending`. With every collection unshared: a wake makes no connector request at all, as adr0063-autopush.test.ts:268 already expects.
11. **Host wiring** (in packages/mcp-server/test/auto-sync.test.ts, beside the test at line 185). With `NORTHKEEP_MASTER_KEY` set to the throwaway vault's key and the fake connector configured, `createStandaloneAutoSync(defaultVaultPath())`, then `sync.connector.wake()` and `sync.connector.whenIdle()`. Expect: a cloud memory written to the fake connector beforehand is in the vault. Fails on main.

Steps 1, 2 (the Pier 9 addition), 4, 5, 7, 9 and 11 fail on today's main because nothing pulls. Step 6 fails on main for every pull.

## What I did not verify

- I did not run any code. Every claim about today's behaviour comes from reading the code at 1089445.
- That closing the Mac app's window quits the app. I found no code that keeps it alive (apps/desktop/src-tauri/src/main.rs), but did not run it.
- The forgotten-memory-comes-back defect (step 6) is inferred from `vault.list`'s defaults, the dedupe rule and `forget` blanking metadata (vault.ts:595); not reproduced.
- Whether anything else (an import, a restore, a compaction of non-project rows) removes a row whose id is on the "saved, not yet acknowledged" list. I read compaction only for project working rows (vault.ts:987-1000).
- How long one locked apply of 50 memories takes on a large vault. A save inside the lock is the same kind of save every app write makes, but the cap of 50 is a guess, not a measurement.
- That the real connector's ack re-points a cloud replace exactly as the fake does. I read both (neon-storage.ts:853-855; packages/sync/test/fake-connector.ts:135-145) but ran neither.
- How often the owner's local AI app sessions start. "Many times a day" is my assumption.
- The ADR 0092 and 0095 drafts are being rewritten as I write. The cross-design section below rests on the brief, not on their final text.
- Linux and Windows hosts: the engine is the same code, but I checked only the Mac paths.

## Found in passing

Every person-started pull today holds the vault lock across up to three connector calls of 30 seconds each, four when the v3 fetch falls back to v2 (connector-client.ts:36, 564-566, 947, 1067-1075). Past 60 seconds, another process takes the lock over even though its owner is alive (lock.ts:75-86), and two processes can then write the whole vault file. Inferred from the code, not run. Splitting `applyDownSync` here lets the person-started paths use the safe form too; whether they should is a build choice, not part of this ADR.

## Review log

No review yet. This draft has not been reviewed or accepted.

## Agreed across ADRs 0092, 0094, 0095 and 0096

- **Build order.** 0096 and 0095 are prerequisites; then 0092; then 0094. 0096 takes no schema step and introduces no pending protocol version. The background pull always fetches the version the Mac's own Sync now fetches in the same build, so when 0092 or 0094 introduce versions 4 and 5, the background pull receives their rows (including ADR 0094's `about-me` rows, which older clients never receive) without a change here.
- **What the background pull applies, by design.** 0096: new memories only, under the filters above. 0094: an interview answer arrives as a new memory; if it carries the chat mark `chat: {app, at}`, the background pull applies it exactly as a person-started pull would, with the device's own re-check from ADR 0094; level 2 answers are saved unconfirmed and wait on the phone. 0092: its current draft (D6) applies a Cloud answer "at a pull, background included (ADR 0096), after re-checking it against its own rows, at most three a pull". 0096 accepts that as the one change to an existing memory the background pull makes, under the shared trust rule (re-derivable from the device's own open question, not undone since, at most three per pull, each in a change list). Those three count within the 50. The change list is 0092's to define; 0096's own record holds counts only.
- **What waits.** Anything level 2, every live cloud replace, every forget of a live memory and every project change waits for a person and appears on ADR 0095's phone list. The background pull applies none of them. It acks a forget or replace only once it is already settled in the vault, which is what ADR 0095 D3 relies on ("the Mac's next pull settles the queue").
- **Text safety.** The background pull shows no app-written text anywhere. Its record and log line hold counts and times only.
- **Undo.** The background pull writes no chat mark of its own, so it needs no undo beyond what 0092 and 0094 already require for marks on rows it carries.
- **Trust.** The connector service is trusted to relay cloud writes and answers honestly; with the background pull no person is present when they land. Listed for Jay below.
- **The phone (ADR 0095).** The phone moves to pending version 3 and still never acks; its yes is applied in the vault and reaches the connector's queue through this pull. If the Mac runs no NorthKeep process, a yes on the phone takes effect in the vault, but Cloud Connect's copy and the connector's queue change only when a Mac process next runs: the phone never pushes to Cloud Connect (KNOWN-LIMITS.md:1483-1491).

## Decisions waiting for Jay

1. **Is "the helper" the NorthKeep server each local AI app starts, plus the Mac app while it is open?** No process that holds the vault key runs all the time today; the Keep Watch helper cannot pull. Recommendation: yes. Under yes: this design as written. Under no: a login helper that holds the vault key whenever you are logged in, which is a separate design with a key-handling review.
2. **Is it acceptable that a customer who uses only cloud apps, and never opens the Mac app or a local AI app with NorthKeep, gets nothing from this design?** Their memories wait on the connector until a person pulls, and milestones 5 and 8 do not take effect in their vault. Recommendation: yes for step 1, stated plainly in KNOWN-LIMITS. Under no: question 1's login helper, or the phone pulling on its own, each a separate design.
3. **Do you accept that the connector service is trusted to relay what cloud apps wrote honestly, now with nobody present, up to 50 new memories per pull into Shared collections?** Recommendation: yes. It cannot replace, forget, mark anything Shared or touch private collections through this path. Under no: no background pull.
4. **Should a backlog over 200 waiting memories stop background pulls until you look?** Recommendation: no, because a cloud-only person would never catch up. Under yes: the background pull applies nothing while more than 200 wait, records it, and a person-started pull clears it.
5. **Should the background pull also run on a timer (for example every 30 minutes while a NorthKeep process runs)?** Recommendation: no. It changes ADR 0044 D4 and the published "not a schedule" claim. Under yes: ADR 0044 and KNOWN-LIMITS.md:384 are amended in the same change.
6. **Should a background pull ever let a cloud app's new project mark a private project Shared (the ADR 0050 fold) with nobody present?** Recommendation: no; it changes who decides what is shared. Under yes: that is a change to invariant 1's first exception and needs its own review.
7. **Is a count on the Cloud screen and in `northkeep share status`, with no notification, enough for you to know it happened?** Recommendation: yes. Under no: a notice on the phone, owned by ADR 0095.

8. **Do you accept that a background pull can, in a window of a few seconds, leave this Mac diverged from your other devices, after which neither the automatic Cloud Connect push nor the background pull runs until you sync by hand?** The same window exists today for Sync now and for any app's save; the background pull adds more writes, so it happens more often. Recommendation: yes, with a KNOWN-LIMITS line. Under no: the pull asks the sync server again just before its locked apply, one more request per pull, which narrows the window but cannot close it.
9. **Do you accept that while an older and a newer NorthKeep server run at once, a memory just brought in can vanish from Cloud Connect for a short while, until the next push restores it?** This is the existing limit at KNOWN-LIMITS.md:1458-1461, made more likely. Nothing is lost from the vault. Recommendation: yes. Under no: the background pull waits to ship until older servers are retired by some schema step, which this design does not otherwise need.

Settled by the lead, not Jay: the cap of 50, that the pull follows the existing `share auto` switch, that the command line does not pull on its own, and the wording of the status line.

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

## Withdrawn (2026-11-25)
Reviewed once: CLEARED WITH WOUNDS (W1 the "saved, not yet acknowledged" rule could leave a forgotten memory served to cloud apps; W2 its list lived in a file other code rewrites with no lock; W3 the cap of 50 did not bound lock time). The review's larger point was that nothing on the Mac runs all the time with the vault key, so this only helps a person who already runs a local AI app or the Mac app, and the first outside customer runs neither. The lead told Jay so and recommended dropping it; he answered "Fix the bugs".

What survives from it:
- Its two reports of defects in today's code were both reproduced. A failed acknowledgement could bring back a forgotten memory: fixed in pull request 98. A person-started pull holds the vault lock across network calls: being fixed separately.
- For a person with only a phone, the phone is the device that pulls (ADR 0095).
