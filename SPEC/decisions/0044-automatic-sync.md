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

**Automatic pull replaces only what the user did not write.** On the
desktop that means: a device pulls on its own only when its vault is
byte-identical to what it last synced and the server is ahead; anything
else is reported and left to the human. On the phone the same rule has one
more branch, added by the sixth review: the phone records a dirty flag under
the vault gate before every user write (saves, imports, edits, forgets), so
"bytes moved with nothing dirty" can only be a torn baseline (an install
whose bookkeeping did not complete), and the phone repairs it from the
server, fast-forwarding whenever the server's copy differs, whatever its
version. Every automatic install on either device keeps the displaced file
as `vault.nkv.auto-pull.bak`.

What this rule does not cover, on purpose: the phone's conflict recovery
(M6-2, ADR 0038) still resolves a real two-sided change last-writer-wins,
and the desktop then fast-forwards onto whatever the phone pushed, because
the phone's re-push carries a higher generation. A newer Mac write can
therefore leave the server through a phone conflict; it survives in the
phone's `.conflict.bak` and the Mac's `.auto-pull.bak`. That is ADR 0038's
residual N2, kept by Decision 4, and this ADR does not claim otherwise.

This is what removes the KNOWN-LIMITS warning "push before you pull on a
machine you've edited" from the automatic paths: they never pull over a
user write.

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
   automatic. The state is `diverged`; the indicator says the vault differs
   from the server's newer copy (or, when this machine has no recorded
   baseline, that the server changed and this machine may have) and the user
   chooses, as today. No indicator asserts that this machine changed.

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
- The GUI sync panel gains the age line and a diverged message that never asserts this Mac changed.
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

## Fifth adversarial review (2026-09-04, run against 3e31353..4919e7e)

Fresh eyes on Opus; phone orchestration re-ported; saves landed at six wake
await points including inside the native digest window; real CLI and MCP
processes. Verdict: NOT CLEARED. Everything from the fourth round held:
the gate closes every interleave (no memory lost at any await point), the
desktop grows the generation by exactly one across five failed retries and
the manual pull that follows succeeds, all six ADR checks pass on the
desktop, forged `sync.json` in four spellings never yields a pull.

- KILL SHOT (phone). The fourth review's generation fix was applied on the
  desktop only. `preparePushMobile` still bumps the generation on every
  attempt, and `installPulledBlob` still compares an incoming blob with the
  local stamp instead of what the phone last synced. On the establish path
  that is terminal: establish inflates the stamp, never sets dirty, never
  establishes the baseline, so every wake says "pull to catch up" while the
  pull refuses every honest blob as a replay. The only escape is a save,
  which LWW-pushes the stale vault over the other device. Trigger: a failing
  PUT with a reachable status endpoint, exactly the 2026-08-28 outage. Fix:
  mirror the desktop. The phone stores `lastSyncGeneration`; the push bumps
  only when the stamp is not already ahead of it (one bump per logical
  push); the install's replay check compares with `lastSyncGeneration`
  (null means inert), never with the local stamp.
- FLESH WOUND (claims). KNOWN-LIMITS says one bump per push and a replay
  check against the last synced copy; both are false for the phone until
  the fix above. The refresh-pull line omits that the pull can be refused.
- FLESH WOUND (MCP wording). `flushBounded` reads `phase === 'pending'`,
  but a debounced push that has started uploading is `syncing`, so a
  stranded write logs the "sync still running" line. Fix: treat pending
  and syncing with a pending write as "push still pending".
- FLESH WOUND (phone wording). A conflict with the phone's own establish
  push is reported as another device.
- SCAR TISSUE: a permanently failing wake pull retries on the backoff
  ladder forever, flipping the pill (bounded by hourly); `writeAtomic`
  replaces a symlinked vault path with a regular file on the first save
  (pre-existing storage seam).
- Residual: no live push with a subscribed account (the push/pull protocol
  itself is unverified against reality); no device run.

## Fixes after the fifth review (2026-09-04)

- Phone mirrors the desktop: `lastSyncGeneration` stored on every accepted
  push and every install; `preparePushMobile` bumps once per logical push
  (`nextPushGeneration`, restore-from-older stamps above the baseline);
  `installPulledBlob` compares the pulled generation with
  `lastSyncGeneration ?? 0` and never with the local stamp. Tested on the
  fifth review's A2 scenario: three failed establishes inflate the stamp to
  8, the next wake says pull, and the Mac's generation-2 blob is accepted.
- A conflict that displaces this phone's own earlier upload says so when the
  displaced blob hashes to the recorded baseline; otherwise the existing
  wording stands (recorded: not always provable by hash).
- MCP shutdown reads the engine's `pushPending` flag, not the phase, so a
  push mid-upload at exit logs "push still pending"; tested with phase
  `syncing`.
- KNOWN-LIMITS: the refresh pull line says it can be refused when the
  server's copy is older than what the phone last synced.
- Recorded: the read-back of the stamped generation in `preparePushMobile`
  has no off-device coverage; a permanently failing wake pull retries on the
  backoff ladder (hourly at most).

## Sixth adversarial review (2026-09-04, run against 3e31353..46242a7)

Fresh eyes on Opus, three parallel tracks. The fifth round's fixes held:
one generation per logical push on the phone, the establish wedge closed,
replay refused on automatic and manual pulls, nothing lost at any of the
six wake await points, all six desktop checks, eight server forgeries.
Verdict: NOT CLEARED.

- KILL SHOT (phone). A torn baseline: the install writes the server's bytes
  and then the baseline bookkeeping (version, sha, generation) can fail or
  be interrupted, and a single SecureStore write failure (the device locking
  during a wake pull is enough) is a trigger. The stored sha then names the
  old bytes, `localChanged` reads true, and the next wake pushes a vault
  holding nothing the user wrote; the 409 and the LWW re-push roll the other
  device's committed write off the server, and the Mac fast-forwards onto
  the rollback. Both pills read Synced. Fix: `localChanged` alone never
  pushes. A wake pushes only when the user edited (dirty, set under the gate
  BEFORE the save) AND the bytes moved; dirty without moved bytes clears
  dirty; moved bytes without dirty is a torn baseline and is repaired from
  the server (status sha equals the file: record the baseline; else a
  fast-forward pull, which is safe because nothing is unpushed). The
  baseline is one JSON value written once, not three keys.
- KILL SHOT (MCP host). A single 402 or 403 pauses the engine and nothing on
  the standalone server ever resumes it; the session cannot push for its
  lifetime, and the exit notice is suppressed on exactly that path. Fix: a
  pause expires (10 min) for wake and write on headless hosts, and the exit
  line reports a paused engine with a pending write.
- FLESH WOUND (desktop). A write landing during a FAILED manual push or pull
  is dropped: the failure path neither re-checks the hash nor re-arms.
- FLESH WOUND (phone). A stale generation baseline makes the next push skip
  its bump (same root as the kill shot).
- FLESH WOUND (claims). KNOWN-LIMITS: "once, not once per attempt" is false
  for a phone with no baseline (each failed establish bumps); "until one
  manual push or pull" is false (an automatic establish sets it); "pushes a
  few seconds after every change" is false inside the failed-manual-sync
  window. The ADR's null-generation note understated the window.
- FLESH WOUND (hosts). The MCP server disables automatic sync for a
  non-default vault with no stderr line; a file-symlinked default vault is
  replaced by a regular file on the first write, so the realpath fix is
  inert for file symlinks.
- SCAR TISSUE: `sync.json` is unauthenticated (a forged `lastSha` equal to
  the current unpushed bytes pulls over them; 0600 beside the vault);
  `notifyWrite` compares raw paths; CLI-vs-CLI stranding with no engine on
  the machine; a truncated `sync.json` sends the engine silently off;
  event ordering prints "in sync" before "pushed".
- INCIDENT (review process). The third review's CLI attacks ran the real
  CLI without `NORTHKEEP_HOME`, overwrote `~/.northkeep/sync.json` with a
  loopback fake server and pushed Jay's real vault (ciphertext) to it, and
  wrote test memories into the real vault. Nothing left the machine. The
  server URL was restored and the base version reset to the hosted server's;
  the vault contents are being checked. Every future attack harness must
  set `NORTHKEEP_HOME` to a temp directory before touching the CLI.
- Residual: the push/pull protocol is unverified against reality; no device
  run.

## Fixes after the sixth review (2026-09-04)

- Phone: the baseline is one JSON value (`nk.sync_baseline`: version, sha,
  generation, pending stamp) written in one call; legacy keys migrate once
  and are wiped with everything else. `localDirty` is set under the gate
  before every save and cleared only inside the gated section that records
  an accepted push or a completed install, and only when the accepted sha
  still equals the file. `decideWakeAction`: dirty and moved bytes push;
  dirty without moved bytes clears the flag; moved bytes without dirty is a
  torn baseline and repairs (status sha equals the file: record the baseline
  with no network write; else fast-forward, safe because nothing is
  unpushed). A stamped-but-unlanded push is not re-stamped while the
  baseline is null. Tested on the review's D1 and E1 scenarios: the other
  device's write stays on the server.
- Engine: a 402/403 pause expires after 10 minutes for wake and write on
  every host (one attempt; a fresh refusal re-pauses); `runManual` and
  `resume()` still lift it at once. MCP exit says "push still pending (sync
  paused: ...)" instead of nothing. A write during a failing manual push or
  pull is re-armed. The MCP server logs when its vault is not the default.
- Storage: `writeAtomic` and the pull's swap write through a symlinked
  vault path instead of replacing the link.
- KNOWN-LIMITS corrected for all four false claims.
- Review process: every attack harness sets `NORTHKEEP_HOME` to a temp
  directory before touching the CLI (the third review's harness overwrote
  the real `sync.json`; restored, nothing left the machine).

## Seventh adversarial review (2026-09-04, run against 3e31353..6a020cc)

Fresh eyes on Opus, three tracks, every harness under a temp home (the real
`sync.json` verified byte-identical before and after). Every prior kill
shot held under execution: the gate at all six wake await points on both
the pull and the repair branch, the one-call baseline under a real
SecureStore failure, one generation per push, replay refused, the pause
expiry, the MCP exit lines in real processes, all six desktop checks, eleven
`sync.json` forgeries, eight hostile-server shapes, symlinks. Verdict: NOT
CLEARED.

- KILL SHOT (phone). Round six routed "bytes moved, nothing dirty" to a
  repair that fast-forwards from the server. A vault the user imports by
  hand (Settings, Import vault file) is exactly that shape: `importVaultFile`
  writes the file with no gate, no dirty flag and no baseline. The next wake
  pulls the server's copy over the import, keeps no durable copy, and the
  pill reads Synced. Before this ADR an import was pushed, which is what the
  user wanted. Fix: an import is a user write. It runs under the gate and
  sets dirty before the write; the baseline is kept (its version gives the
  push its base, its generation puts the import above what the phone last
  synced, and a known baseline keeps the refresh pull's warning), so the
  next wake reads dirty and moved and pushes it. And repair's fast-forward
  keeps a durable copy like the desktop's.
- FLESH WOUND (phone). An automatic pull keeps no `.auto-pull.bak` on the
  phone; only the one-deep rolling `.bak`. Fix: the install copies the
  displaced file to `vault.nkv.auto-pull.bak` under the gate on the success
  path, exactly as the desktop does.
- FLESH WOUND (claims). The "one rule" wording ("byte-identical to what it
  last synced AND the server is ahead") is false for the repair
  fast-forward, which runs because the bytes are not identical and can run
  when the server is at the same version. Reword: the phone repairs a torn
  baseline only when nothing was written by the user (dirty is the user's
  signal, set before every save) and keeps a durable copy.
- FLESH WOUND (desktop). A torn desktop baseline (a kill between the pull's
  rename and the config write, inside the lock) reports "both changed" on a
  machine with no local edits; a manual pull recovers with a `.bak`.
  Recorded as a scar: the window is microseconds inside the file lock.
- FLESH WOUND (GUI). `syncSentence` ignores `baselineKnown` and asserts
  "this Mac and the server both changed" when that is unknowable. Fix:
  hedge like the CLI does.
- FLESH WOUND (ADR text). Decision 2 named a "behind and edited" indicator
  that does not exist; the condition is `diverged`. Corrected in place.
- SCAR TISSUE: the pause expiry has no host knob (ten minutes, engine
  tested); a perfect `sync.json` forgery pulls over an edit; a no-sha
  replaying server moves `lastVersion`; CLI-vs-CLI stranding with no engine
  on the machine; `localChanged` reads true on the no-sha path for an
  untouched file (cosmetic); the symlinked vault's `.auto-pull.bak` sits
  beside the target.
- Residual, and the cap: the push/pull protocol is unverified against the
  real server with a real account (a throwaway bearer is 402-gated). That
  caps any verdict at CLEARED WITH WOUNDS until Jay's own account makes
  one live push and one live pull.

## Fixes after the seventh review (2026-09-04)

- Phone import runs under the gate, sets dirty before the write, keeps the
  baseline, and closes and reopens the session vault in the same gated
  section; the next wake pushes the import (tested at the decision level
  with the session's exact inputs and through the real secure-store module).
- Automatic pulls on the phone (the wake's pull and the repair fast-forward)
  pass `keepDisplacedCopy` and the install copies the previous file to
  `vault.nkv.auto-pull.bak` under the gate on the success path; manual
  pull-to-refresh does not. Settings says so in one line.
- GUI: the diverged sentence hedges unless the baseline is definitely known.
  ADR Decision 2 and Consequences no longer name a "behind and edited"
  state. KNOWN-LIMITS states the repair exception to the one rule and the
  phone's durable copy.
- Scars recorded: the desktop's microsecond torn-baseline window inside the
  file lock (manual pull recovers); the pause expiry has no host knob.

## Eighth adversarial review (2026-09-04, run against 3e31353..b6d2b3f)

Fresh eyes on Opus; the real `importVaultFile` through a picker shim; every
prior kill-shot scenario re-run; 447 repo tests; real CLI and MCP processes;
the real `sync.json` byte-identical before and after. Verdict: CLEARED WITH
WOUNDS. No kill shot survived execution.

- FLESH WOUND (phone). The import became an unwarned automatic push that
  can roll another device's newer content off the server through the
  phone's conflict recovery. Fix: a confirmation before the picker that
  says exactly that, and a notice after.
- FLESH WOUND (claims). The ADR's "one rule" section was still absolute;
  both sentences of the KNOWN-LIMITS correction were false against the
  repair branch (it fast-forwards whenever the server's copy differs, at
  any version); the GUI's hedge missed the torn-baseline case. Fix: the
  rule is restated as "automatic pull replaces only what the user did not
  write" with the repair branch and the ADR 0038 N2 residual admitted in
  the same section; KNOWN-LIMITS matches; every diverged sentence (engine,
  GUI, CLI) now says the vault differs from the server's newer copy and
  never asserts that this machine changed.
- SCAR TISSUE (recorded): a foreign-lineage import locks the phone until a
  wipe and pull (the confirm names it); `.auto-pull.bak` is two deep; the
  Settings note sits under the server field; event ordering prints "in
  sync" before "pushed".
- Residual: the push/pull protocol is unverified against the hosted server
  with a real account, which caps any verdict at CLEARED WITH WOUNDS until
  Jay's account makes one live push and one live pull.

## Fixes after the eighth review (2026-09-04)

Import confirmation and notice on the phone; neutral diverged wording in
the engine, the GUI and the CLI; the one rule restated with the repair
branch and the N2 residual; KNOWN-LIMITS matched. Suites green.

## Ninth adversarial review (2026-09-04, run against 3e31353..437f17f)

Fresh eyes on Opus; the full prior battery re-run (repo suite 1400 green,
real CLI and MCP processes, phone harness through the real import); the
real `sync.json` byte-identical before and after. Verdict: CLEARED WITH
WOUNDS, all three wounds wording: the MCP server's diverged line still
asserted "both changed" (the eighth-review record's list of surfaces
missed it); the import confirmation promised the server's copy as a
backup when what is kept is this phone's previous vault, until the next
change; KNOWN-LIMITS line 60 still described the old status wording.
Scars: `DIVERGED_MESSAGE`'s comment claimed the GUI and CLI show it
verbatim; two tracked tests pinned the old wording. Residual unchanged:
the hosted push/pull protocol with a real account, which caps the verdict.

## Fixes after the ninth review (2026-09-04)

MCP diverged line neutral (its test updated); import confirmation says the
phone's current vault is kept as `vault.nkv.bak` until the next change;
KNOWN-LIMITS line 60 matched; the constant's comment corrected. In tracked
code, "both changed" now survives only in the CLI push-on-exit line after a
409 (where this machine demonstrably just wrote) and the test that pins it;
the ADR's review records quote the old wording historically.

## Tenth adversarial review (2026-09-04, run against 3e31353..eb983fc)

Focused on the ninth round's fixes plus the full battery, with a side-by-side
run at the previous commit to prove no regression; the MCP line verified
from a real spawned process on a torn baseline. Verdict: CLEARED WITH
WOUNDS. The MCP fix held; two wording fixes had half-landed: the import
confirmation still promised a `.bak` that the next wake's generation stamp
rewrites (proved through the real import and push path), KNOWN-LIMITS line
60 matched only the known-baseline status string, and Decision 2 still said
the indicator "says both changed". Scars: the fix note overclaimed its grep;
the untracked attack battery is not a green gate and its plain vitest
config skips every phone suite; the installed 0.20.0 app still shows the
old wording until the next desktop build.

## Fixes after the tenth review (2026-09-04)

The import keeps the replaced vault at `vault.nkv.pre-import.bak`, written
only by imports, and the confirmation and the notice name it (nothing is
promised on a phone that had no vault). KNOWN-LIMITS line 60 carries both
status phrasings. Decision 2 says no indicator asserts that this machine
changed. The fix note's grep claim corrected.

## Eleventh adversarial review (2026-09-04, run against 3e31353..9c383a0)

Focused on the import copy plus the battery. The copy survives the wake's
stamp (proved through the real import and push path), a failing copy write
leaves the vault untouched with the flag set, a save queued behind an
import lands on the reopened vault. Verdict: CLEARED WITH WOUNDS: "Sign out
and wipe" left the pre-import copy (and the older auto-pull copy) on disk,
unreadable without the device secret but contrary to the alert; the copy
rolled an undocumented `.pre-import.bak.bak`; ADR Consequences claimed a GUI
hedge that was never built; KNOWN-LIMITS attributed both diverged phrasings
to every status line.

## Fixes after the eleventh review (2026-09-04)

The wipe deletes every sidecar beside the vault (rolling backup, temps,
auto-pull, conflict and pre-import copies, each with its own rolling
`.bak`). The import removes the previous copy before writing the new one,
so exactly one documented copy exists, and records where it went before the
reopen runs. The two doc lines corrected.

## Live verification (2026-09-04, Jay's own account)

The residual every review carried is closed. From the Mac, with the repo's
current CLI: `northkeep sync push` answered "Pushed. Server is now at
version 9." The phone then opened and pulled; Jay: "phone just worked". A
read-only `northkeep sync status` afterwards reported "In sync, this vault
and the server hold the same bytes", which is the byte comparison against
the server's `sha256` for a real account (lowercase, matching the local
file), and `sync.json` recorded `lastGeneration: 9`, a field only the new
three-phase `pushVault` writes. Not exercised live: a real 409 and the
phone's new client (the phone ran the shipped 0.20.0 build). Those wait for
the next phone build's first wake, the hand-run acceptance test.

## Found in use (2026-09-04): the torn record after an exit mid-upload

The ADR 0045 live test closed its MCP client while the server's push was
still uploading. The upload landed (server v14) but the process exited
before the record step, leaving `sync.json` at v13 with the old hash: bytes
in sync, record stale. A later write would then have read as diverged with
no way out short of a manual pull. Fixes: the engine repairs a stale record
whenever a wake or a 409 finds the bytes already in sync (records the
server's version and hash and the file's generation); the MCP and GUI
shutdown budgets are 10 s so an upload in flight normally records itself.
Residual, recorded: a write that lands after a torn record and before any
wake (only the CLI, which has no wake) still reads as diverged and is
reported for the human; the write is intact locally.

The code has cleared every executed attack across eleven rounds, and the
hosted push and pull have now run for a real account. What remains
is rule 2 of the review skill: one live push and one live pull against the
hosted server with Jay's own account, which no throwaway credential can
perform (an unknown bearer is answered 402, not 401).

## Status of this record

Accepted 2026-09-03. Written the same day, after the sync-server outage.
The defaults above stand until Jay says otherwise.
