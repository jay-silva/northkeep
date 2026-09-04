# ADR 0044 — Automatic sync: push after write, fast-forward pull on wake

- **Date:** 2026-09-03
- **Status:** Accepted by Jay 2026-09-03 ("Push and accepted"). Becomes the
  next milestone. Product code follows this record.
- **Deciders:** Jay (product owner), adversarial reviewer
- **Extends:** ADR 0009 (sync protocol), ADR 0038 addendum 2026-08-26
  (sync generation counter, phone last-writer-wins), M6-2 mobile conflict
  policy (`apps/mobile/src/lib/sync-flow.ts`)
- **Does not touch:** vault schema, the sync-server wire protocol, the
  connector, billing, the redaction harness, conflict resolution rules,
  ADR 0035, ADR 0036, ADR 0037

## Context

Sync is the plumbing that the 2026-08-22 direction shift leans on: memories
and projects available from any agent on any device. Today that plumbing is
mostly manual.

What is automatic now:

- The phone pushes after every save (`runSyncAfterSave`), with the
  last-writer-wins conflict recovery from M6-2.
- The phone pulls only on first install (no local vault) or when the user
  taps pull.
- The Mac never syncs on its own. Push and pull are buttons in the GUI and
  `northkeep sync push|pull` on the CLI. Writes that arrive through the local
  MCP server (Claude Code `memory_remember`, `project_update`) land in the
  vault and stay there until a human pushes.

The cost showed on 2026-09-03. The hosted sync server had crashed on every
route since at least 2026-08-28. Nobody noticed for six days because nothing
was syncing on a schedule, so nothing failed on a schedule. The monitoring
half of that is fixed by `.github/workflows/hosted-probe.yml` (a 15-minute
probe plus a post-deploy smoke; no ADR needed, it is CI). This ADR is the
product half: the devices keep themselves in sync without a button press,
without changing what happens when two devices disagree.

## The one rule that makes this safe

**Automatic pull is fast-forward only.** A device pulls on its own only when
its local vault is unchanged since its last sync AND the server is ahead. If
the local vault has changed, the device pushes instead (which is what it
already does after a save). If both have changed, nothing automatic happens
beyond what M6-2 already does on the phone (last-writer-wins with a
recoverable `.bak`), and the desktop keeps punting to the human exactly as
today. No automatic path ever replaces a locally edited vault.

This is what removes the KNOWN-LIMITS warning "push before you pull on a
machine you've edited" from the automatic paths: the automatic pull refuses
to run in the one case that warning exists for.

## Decision 1: The Mac pushes after every vault write

Mirror the phone. Every write that goes through `Vault` on the desktop
(GUI, CLI, Converse, and the local MCP server) schedules a push. Pushes are
debounced: one push at most every 5 seconds per vault, coalescing bursts
such as a Claude Code session writing several memories in a row. The 4 MB
blob cap and the per-account window (120 requests per 5 minutes) both hold
comfortably at that rate.

The push runs only while the vault is unlocked, because the sync generation
stamp needs the key (0.20.0, M17). A write that happens while locked (there
are none today, but the guard stays) leaves a pending flag that the next
unlock drains.

A failed push is not retried in a tight loop. It backs off (30 s, 2 min,
10 min, then hourly) and surfaces in the GUI sync indicator. A 402 or 403
stops retrying until the next explicit user action, since retrying a paywall
is noise.

## Decision 2: Both devices pull on wake, fast-forward only

"Wake" means: app launch, vault unlock, and return to foreground (phone
`AppState` active; desktop window focus after at least 60 s in the
background). On wake the device:

1. Calls `GET /api/status` (a few hundred bytes, no blob).
2. If the server version equals the last synced version, stops. This is the
   common case and costs one small request.
3. If the server is ahead and the local vault is unchanged since the last
   sync (the existing `syncState` post-sync hash says so), pulls the blob,
   runs the same verify-opens-with-key and structural checks the manual pull
   runs, and reloads.
4. If the server is ahead and the local vault HAS changed, does nothing
   automatic. The indicator shows "behind and edited"; the user chooses, as
   today.

Wake pulls run only while unlocked, because verification needs the key. A
locked app on wake shows "last synced N ago" and pulls after unlock.

`syncState` already computes everything step 3 needs. The desktop's
"baseline unknown" case (no recorded post-sync hash) is treated as "changed":
no automatic pull until one manual sync establishes the baseline.

## Decision 3: Staleness is visible even when nothing has failed

Both apps show the age of the last successful sync ("Synced 2 min ago",
"Last synced 6 days ago") next to the existing status. A failed automatic
sync shows its classified error (existing `classifySyncError`) in the same
place, loud per invariant #6, but the banner is not re-raised on every
retry; it stays until the next success or user tap.

## Decision 4: Conflict rules do not change

- Phone: last-writer-wins with recoverable `.bak`, generation bump to
  `max(local, remote) + 1` (0038 addendum). Unchanged.
- Desktop: a 409 on push still tells the user to pull then push. Unchanged.
  Automating desktop conflict resolution is out of scope; the desktop is
  where the human is.
- Equal-generation forks (0038 residual N2) remain a known limit. Automatic
  sync makes them rarer (devices are behind for minutes instead of days),
  not impossible.

## Decision 5: Budget and battery

- Per wake: one status request. Per write burst: one push. A heavy day is a
  few hundred requests, well under the account window.
- No background timers. Nothing runs while the app is not in front. iOS
  background fetch is explicitly out of scope for v1; the phone syncs when
  you open it, which is when you need it current.
- The desktop debounce and backoff are the only timers, and both stop when
  the vault locks.

## What the adversarial review must check against code

1. Automatic pull cannot run when `syncState` reports `localChanged` or
   `baselineKnown === false`. Try to force it with a stale hash file.
2. A pull that arrives mid-write on the desktop cannot interleave with a
   push (single sync mutex per vault, same one the phone's state machine
   implies).
3. Debounce does not drop the last write of a burst.
4. Backoff stops on lock, on 402/403, and on quit; no orphan timers.
5. The sync generation still increments exactly once per push and the
   behind-phone LWW tests in `packages/sync/test/sync.test.ts` still pass.
6. Attack the wake pull with a forged higher version from a hostile server:
   the existing verify-opens-with-key check must still reject it.

## Consequences

- KNOWN-LIMITS: the "push before you pull" item is rewritten to say the
  automatic paths never pull over local edits; the manual pull keeps the
  warning.
- A phone build (buildNumber bump, TestFlight) and a Mac release. Batch with
  the next milestone per the EAS batching rule.
- The GUI sync panel gains the age line and the "behind and edited" state.
- The CLI is unchanged except that `northkeep sync status` reports the age.

## Open questions, with the defaults that apply unless Jay overrides

1. Desktop debounce at 5 s, or longer (30 s) to keep Claude Code sessions to
   one push per session pause? Default: 5 s.
2. Should the desktop also pull on window focus, or only on launch and
   unlock? Focus is the most useful and the noisiest. Default: yes, after
   at least 60 s in the background.
3. Is "Synced N ago" wanted in the phone's list header, or only in Settings?
   Default: both; the header line is one short row under the status dot.

## Implementation (2026-09-03, commits 3e31353..e120364, local only)

- `packages/core`: `onVaultSave` after-save hook.
- `packages/sync/src/auto.ts`: the `AutoSync` engine (debounced push, wake,
  backoff, 402/403 pause, `runManual`, `syncAge`).
- Desktop hosts: GUI server and page, standalone MCP server, CLI push-on-exit
  and `sync status` age.
- Phone: `decideWakeAction`, `fetchRemoteStatus`, wake on unlock and
  AppState active, persisted local-dirty flag, sync age in the header and
  Settings.
- KNOWN-LIMITS rewritten; the M5 e2e scenario reads the automatic pushes.

## Adversarial review findings (2026-09-03, run against the implementation)

Fresh-eyes review with executed attacks (engine, phone decision layer, and a
desktop-side chain test; one read-only live call to the hosted server).
Verdict: NOT CLEARED. Nothing ships until the kill shot and the flesh wounds
below are fixed and the fixed code is reviewed again.

- KILL SHOT (phone). `decideWakeAction`'s `status === 'error'` branch returns
  `retry-push` for any non-paywall error, without consulting `localDirty`. A
  status check that fails with no signal leaves the phone in `error`; the next
  wake pushes a vault with nothing new, gets a 409, and the existing M6-2
  last-writer-wins recovery re-pushes the phone's STALE vault over the Mac's
  newer one. The Mac then fast-forwards onto it, and one more Mac write
  overwrites the rolling `.bak`. Both devices show Synced. This is the exact
  outcome this ADR forbids, on a path with no user edit. Fix: retry-push only
  when `localDirty`; a non-dirty error becomes `check`.
- FLESH WOUND (desktop). `syncState`'s no-sha fallback (a server that omits
  `sha256`) reports `behind` with `localChanged:false` for an edited vault, and
  the engine pulls over the edit. Verify-opens-with-key cannot reject a replay
  of the user's own blob, so check 6's defense does not cover this. Our server
  always sends the sha; a hostile or third-party server reaches it. Fix: with
  no remote sha, decide from `lastSha` versus the local file (edited since
  sync means never pull), and lowercase any sha before comparing.
- FLESH WOUND (desktop). Two engines on one machine (GUI plus the standalone
  MCP server) race: `pushVault` reads `lastVersion` before taking the file
  lock, the loser 409s, bumps its generation, and is left `pending` with no
  timer. KNOWN-LIMITS' sentence "a 409 here means another device moved on,
  not the other local process" is false. Fix: read the config under the lock,
  and on 409 re-read `syncState`; if the server already holds these bytes,
  settle; if we are merely ahead of the refreshed base, push once more.
- FLESH WOUND (desktop). An automatic pull's displaced vault goes to the
  rolling `vault.nkv.bak`, which the next save (including the engine's own
  generation bump) overwrites, and nothing tells the user a pull happened.
  Fix: an automatic pull keeps its own copy (`vault.nkv.auto-pull.bak`) and
  the event line says so.
- SCAR TISSUE, accept and record: trailing-edge debounce with no maximum
  wait starves under a write stream faster than the debounce (a max wait of
  30 s is cheap and will be added with the fixes); armed timers fire once
  more after lock, with no network, before going quiet; while diverged each
  write costs a generation bump and a full-blob 409; the fast-forward
  decision and the replacement are separate lock scopes (one event-loop-turn
  window).
- Residual: no live sync against the hosted server with a subscribed account
  (a throwaway bearer is 402-gated and a real push is a side effect); no
  device run of the phone wake; no Tauri window-focus run.

## Fixes after the first review (2026-09-03)

- Kill shot: `decideWakeAction` pushes from a wake only when `localDirty`;
  an error state with nothing unpushed goes to the status check and can only
  fast-forward or do nothing. Tested for every error kind.
- No-sha fallback: `syncState` with no remote hash decides from the local
  baseline alone (edited means ahead or diverged, never behind) and lowercases
  any hash before comparing. Tested against a no-sha server in both the
  client and the engine suites.
- Same-machine race: `pushVault` reads `sync.json` under the file lock; on a
  409 the engine re-reads `syncState`, settles when the server already holds
  these bytes, pushes once more when merely ahead of a refreshed base, and
  reports anything else. KNOWN-LIMITS sentence corrected.
- Displaced copy: an automatic pull first copies the vault to
  `vault.nkv.auto-pull.bak`, which ordinary saves never touch; the event, the
  MCP stderr line, the GUI result line and `status().lastPull` all name it.
- Scar accepted and mitigated: the debounce now has a 30 s maximum wait.
- Scars accepted as-is: the one extra timer tick after lock (no network);
  the generation bump plus 409 per write while diverged (0038 design); the
  one-turn window between the fast-forward decision and the replacement.

## Second adversarial review (2026-09-03, run against 3e31353..8293200)

Fresh eyes again, no knowledge of the first pass, every claimed fix attacked
directly. First kill shot confirmed closed: 120 status, error and version
combinations with nothing unpushed never yield a push. Verdict: NOT CLEARED.

- KILL SHOT (phone). `localDirty` tracks push ATTEMPTS, not bytes. It is set
  only inside `pushAfterSave`, after the early return for "no server URL".
  Memories saved before sync is configured, or while the first push fails
  (402 before subscribing, 403, offline; the URL is kept either way), are
  never flagged. The next wake sees server version above the phone's 0,
  decides `pull`, the generation check passes, and those memories go to the
  rolling `.bak` with the pill reading Synced. Plausible onboarding path:
  enable sync on the phone, get 402, subscribe on the Mac, reopen the phone.
  Fix: the phone decides from bytes like the desktop (a stored post-sync hash
  of the vault file compared before any automatic pull), or marks dirty on
  every save including unconfigured ones and clears it only on a landed push
  or an installed pull.
- FLESH WOUND (desktop, all hosts). `pushVault` and `pullVault` hold the vault
  file lock across the network call (up to 120 s) while `withFileLock` gives
  up after 5 s. With every write now pushing, a slow or hung server makes
  every other process's reads and writes fail for the duration (executed:
  CLI `remember` blocked 13 s, a second `remember` and a `list` failed after
  5.7 s; the GUI's own status call failed during an unlock pull and the page
  said "Could not unlock"). Fix: scope the lock. Push: snapshot and bump under
  the lock, upload outside, record under the lock. Pull: download outside,
  verify and swap under the lock, re-checking the local hash before the swap.
- FLESH WOUND (desktop). The fast-forward precondition is decided outside the
  critical section: a write by another process that holds the lock while the
  wake decides `behind` is buried by the pull, and `.auto-pull.bak` (copied
  before the lock) lacks it. Closed by the same lock restructuring.
- FLESH WOUND (desktop). A failed automatic pull attempt overwrites
  `vault.nkv.auto-pull.bak` with the current vault because the copy is taken
  before `pullVault`; `lastPull` keeps pointing at it. Fix: copy to a temp
  name and promote on success.
- FLESH WOUND (GUI). The "a pull is never silent" line only shows on a
  foreground wake; the server-side wakes on unlock and launch are invisible
  to the page's `pulled` diff. Fix: the page diffs `lastPull.at`.
- FLESH WOUND (desktop). Quit with a push in flight exits with the lock file
  held (bounded flush gives up at 1.5 s); the next process fails every vault
  operation for up to 60 s. Closed by the lock restructuring.
- FLESH WOUND (minor). A 409 that re-checks to `ahead` twice (server restored
  from a backup or wiped) parks the engine `pending` with no message and no
  retry; the pill says Syncing forever. Fix: report it and back off.
- SCAR TISSUE: uppercase `x-sha256` from a third-party server fails every
  pull (ours is lowercase); a hostile no-sha server can move `lastVersion` by
  replaying our own blob at a forged version; the 409 retry bumps the
  generation twice for one logical push; a phone crash between the push's
  200 and the SecureStore write manufactures an LWW (M6-2 design); the
  `withFileLock` 5 s timeout and 60 s stale window predate this ADR.
- Residual: no live push against the hosted server with a subscribed
  account; no device run of the phone wake; no Tauri focus run.

## Fixes after the second review (2026-09-03)

- Kill shot: the phone stores a post-sync hash of its vault file (set from
  the exact bytes a push uploaded or a pull installed) and `decideWakeAction`
  takes `localChanged` (unknown hash counts as changed); changed or dirty
  means push, never pull. `pushAfterSave` marks dirty before the
  "unconfigured" early return. Tested on the review's onboarding path.
- Lock scope: `pushVault` snapshots and stamps under the vault lock, uploads
  with no vault lock, records under the lock; `pullVault` downloads with no
  vault lock, then verifies and swaps under it. A new sync lock
  (`vault.nkv.sync.lock`, waits through a full transfer) serializes pushers
  and pullers on one machine so two host processes never push from one base.
  Tested: a write and a read complete in well under a second while a PUT is
  parked server-side.
- Fast-forward precondition: an automatic pull passes the hash it decided on
  as `expectLocalSha`; `pullVault` re-checks under the lock and throws
  `LocalChangedError` instead of swapping. The engine then decides again from
  the new bytes (pushes if ahead, reports otherwise). Tested with a write
  landing mid-download.
- Auto-pull copy: written by `pullVault` itself (`keepCopyAt`), under the
  lock, only on the success path. Tested against a rejected download.
- GUI: the page diffs `lastPull.at` on every status refresh, so the "pulled
  version N, previous copy kept at" line shows after launch and unlock wakes
  too, and reloads the list.
- Quit with a push in flight: the upload phase holds no vault lock, so a
  bounded flush that gives up leaves only the sync lock, which the next
  process steals after its stale window and which blocks no read or write.
- 409 twice: the engine now fails loudly with a message and backs off
  instead of parking on Syncing.

## Third adversarial review (2026-09-03, run against 3e31353..f993fad)

Fresh eyes, both fix sections treated as unverified, the phone's real
transport and decision modules run under Node with a line-for-line port of
the orchestration. Verdict: NOT CLEARED.

- KILL SHOT (phone, upgrade path). Every phone that synced before this build
  has a stored last version and no stored hash, so the second-round rule
  "unknown hash counts as changed" makes its first wake a `retry-push` with
  nothing unpushed. The 409 triggers M6-2 last-writer-wins, which re-pushes
  the phone's stale vault over everything the Mac pushed since; the Mac then
  fast-forwards onto it. The first review's kill shot, reintroduced by the
  second review's fix. Fix: an unknown baseline never pushes on its own. With
  the server at the phone's last version, push once WITHOUT conflict
  recovery to establish the baseline (a 409 there is reported, not
  resolved); with the server ahead, do nothing automatic and say "the server
  has newer changes, pull to catch up".
- FLESH WOUND (phone). `runWake` captures dirty, changed and the pill status
  before its network awaits and the pull never re-checks; a save during the
  wake whose push fails is buried by the pull and its dirty flag cleared.
  Fix: re-read the inputs after the status request and re-check the file
  hash immediately before install (`expectLocalSha` on the phone too).
- FLESH WOUND (phone, pre-existing, exposed). The phone's sync generation
  never increases across pushes: `pushVaultMobile` bumps it in a second
  Vault instance and the session's open instance writes the old value back
  on the next save. Every phone blob shares one generation, so the
  generation check, the only defense against a replay of the user's own
  blob, is void for phone blobs on both devices. Fix: the session vault
  adopts the stamped generation after each push.
- FLESH WOUND (desktop, all hosts). Check 3 fails: `notifyWrite` ignores
  saves while the engine's own operation runs, and that flag spans the whole
  upload, so a write that lands during a push is dropped until the next
  wake. Fix: after a push, compare the file hash with the recorded one and
  re-arm when they differ.
- FLESH WOUND (CLI). A writer command's push-on-exit waits on the sync lock
  for as long as another process's push is stalled (up to 150 s). Fix: the
  CLI waits at most 2 s, then prints that another process is syncing and
  returns; the other engine's post-push hash check picks the write up.
- FLESH WOUND (CLI/engine). `sync.json` is per account, the engine is per
  vault path: a write to any `--vault` now pushes that vault over the
  account's server copy. Fix: automatic sync applies to the default vault
  only; other vaults keep manual push/pull.
- SCAR TISSUE (accepted unless fixed alongside): an orphaned sync lock
  after a crash mid-upload makes pushes and pulls wait 150 s until the
  stale window (reads and writes unaffected); fixed cheaply by stealing a
  lock whose recorded pid is dead. Manual Push/Pull queue behind a parked
  automatic push for the PUT timeout. `stop()` does not cancel an in-flight
  pull's swap. Two engines in one process would ping-pong generation bumps
  (one engine per process is convention, not code). A no-sha replaying
  server moves `lastVersion` and later pushes fail "refused twice" until a
  manual pull. A non-string `sha256` throws instead of being ignored; an
  uppercase `x-sha256` fails phone downloads (both trivial). A server wiped
  or restored below `lastVersion` is unrecoverable from the UI (pre-existing,
  out of scope). The 409 retry bumps the generation twice.
- Residual: no live push with a subscribed account; no device run; the
  upgrade-path premise (version key persists, hash key absent) inferred from
  the key history, not observed on a device.

## Fixes after the third review (2026-09-03)

- Upgrade path: `decideWakeAction` takes `baselineKnown`. With no stored
  hash and nothing dirty it never pushes on its own: server at our version
  means one `establish` push with no conflict recovery (a 409 there is
  reported as "The server has newer changes. Pull to catch up." and the
  baseline stays unknown); server elsewhere means `needs-pull`, the same
  loud line and no network write. A manual pull then stores the hash.
  Tested over the full matrix: an unknown baseline never yields
  `retry-push` or `pull`.
- Save during wake: `runWake` re-gathers dirty, hash and status after the
  status request; `pullVaultMobile` re-hashes the file immediately before
  writing and throws `LocalChangedError` if it moved; the wake then
  re-decides (dirty pushes).
- Generation: `pushVaultMobile` returns the generation it stamped and the
  session vault adopts it (`setSyncGeneration`) after every push, so phone
  blobs no longer share one generation and the replay defense holds for
  them.
- Desktop write during upload: after a push the engine compares the file
  hash with the recorded one and re-arms when they differ; a manual push
  or pull does the same. Tested with a parked upload.
- CLI: push-on-exit is one direct push that waits at most 2 s on the sync
  lock, then prints that another process is syncing and returns.
- Default vault only: the engine and the CLI push-on-exit act on the
  account's default vault path; other vaults keep manual push/pull.
- Locks: a lock whose recorded pid is dead is stolen at once
  (`FileLockTimeoutError` is typed; `SyncBusyError` for a short wait).
- Nits: non-string `sha256` ignored; phone lowercases `x-sha256`.
- KNOWN-LIMITS gains the default-vault, no-wait CLI and dead-pid lines.

## Fourth adversarial review (2026-09-03, run against 3e31353..2f387a1)

Fresh eyes, all three fix sections attacked; phone orchestration re-ported
line for line, with a hook that lands a save inside the hash window; a real
standalone MCP process and a real SIGKILLed pusher. Verdict: NOT CLEARED.

- KILL SHOT (phone). The install re-check is not atomic: `hashVaultFile`
  reads the bytes, then awaits the native digest; a save landing in that
  window is hashed as absent, the install overwrites it, and the save's own
  conflict re-push then overwrites the rolling `.bak`. The memory exists
  nowhere while the pill says "Your edit was kept and pushed". Fix: an
  in-process vault gate (async mutex) that every mutation and the install
  (hash, write, reopen) take, so a save and an install never interleave;
  the push's stamp-and-read takes it too, the network call does not.
- KILL SHOT (desktop). Every automatic retry bumps and saves the sync
  generation before uploading, so an offline Mac with one pending write
  gains a generation per backoff tick. If any other device pushes meanwhile
  the Mac is `diverged`, the manual pull is refused as "older than this one
  (sync generation)" and the push 409s: no UI or CLI path out. Fix: record
  the generation of the last synced bytes in `sync.json` (`lastGeneration`);
  bump only when the file's stamp is not already ahead of it (one bump per
  logical push, however many attempts); and make the pull's replay check
  compare the pulled generation against `lastGeneration`, which is the
  question it exists to answer, not against the local stamp.
- FLESH WOUND (phone). After a refused install the re-decision forces
  `status: 'idle'` and can start a second `runSyncAfterSave` while the
  save's own push runs: six PUTs for one edit, a double stash, a stored sha
  that no longer matches disk, a false "another device is syncing" line.
  Fix: never start a push from the wake while one is in flight.
- FLESH WOUND (phone). Between `writeAtomic` and the session reopen the old
  vault instance can save pre-pull content over the installed file. Closed
  by the same gate.
- FLESH WOUND (phone). The needs-pull line says "newer changes" when the
  server is restored below us or empty, and points at pull-to-refresh,
  which replaces the vault with no warning and no re-check; on the upgrade
  path that buries a pre-0044 unpushed edit after one more save. Fix: honest
  wording ("The server's copy differs from this phone's"), the refresh pull
  warns when the phone has unpushed bytes, and KNOWN-LIMITS names the
  phone's refresh as a manual pull that replaces.
- FLESH WOUND (phone). Unknown baseline against an empty server: establish
  pushes from the stored version and is refused; the pill says pull, the
  pull finds nothing, every later save reports a conflict. Fix: establish
  against an empty server pushes from base 0.
- SCAR TISSUE: establish holds only until the next save, after which an
  unknown-baseline phone that is days behind LWW-pushes its stale vault
  (recoverable from two `.bak` copies; by M6-2 design). A replayed latest own
  blob at a forged version moves the stored version (false conflict next).
  A foreign live pid holding the sync lock is never stolen inside the wait
  because the wait is shorter than the stale window (fix: wait longer than
  stale). A symlinked or differently cased default vault path is "another
  vault" (fix: realpath). `flushBounded` says "push still pending" when only
  a wake was parked (fix wording). `sync.json` is written non-atomically
  (fix: temp and rename). Two engines in one process ping-pong; `stop()` does
  not cancel an in-flight pull's swap; no-sha replay moves `lastVersion`
  (all recorded before).
- Residual: no device run; no live push with a subscribed account; the
  digest-window width on a device is inferred.

## Fixes after the fourth review (2026-09-04)

- Phone gate: `vault-gate.ts`, a FIFO async mutex. Every mutation, the
  whole install (re-hash, verify, write, reopen, the version/sha/dirty
  writes) and the push's stamp-and-read run under it; network calls run
  outside it (`preparePushMobile` then `uploadPreparedMobile`). A save can
  no longer interleave with an install at any await point.
- Phone: no wake push while one is in flight (`pushInFlightRef`); establish
  against an empty server pushes from base 0; the needs-pull line reads
  "The server's copy differs from this phone's. Pull to replace this phone's
  vault; a copy is kept." and pull-to-refresh asks first when the phone
  holds unpushed bytes.
- Desktop generation: `sync.json` records `lastGeneration`; `pushVault`
  bumps once per logical push (never again on a retry; a restore from an
  older copy stamps above the recorded baseline); `pullVault`'s replay
  check compares the pulled generation with what this machine last synced,
  not with the local stamp. Tested on the review's offline-retries scenario:
  the generation grows by exactly one and the manual pull then succeeds.
- Sync lock waits 30 s longer than its stale window; `isAutoSyncVault`
  compares real paths; `sync.json` is written atomically; the MCP shutdown
  line distinguishes a pending push from a parked wake. KNOWN-LIMITS
  updated, including the phone's refresh pull.
- Known and recorded: on a fresh machine the first pull carries no key, so
  `lastGeneration` is null until the next push or pull and the replay check
  is inert for that window; the phone's connector down-sync holds the gate
  across its HTTP calls.

Fifth review: pending at the time of writing.

## Status of this record

Accepted 2026-09-03. Written the same day, after the sync-server outage.
The defaults above stand until Jay says otherwise.
