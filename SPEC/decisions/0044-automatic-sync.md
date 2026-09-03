# ADR 0044 — Automatic sync: push after write, fast-forward pull on wake

- **Date:** 2026-09-03
- **Status:** DRAFT for Jay's review. No product code until accepted.
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

## Open questions for Jay

1. Desktop debounce at 5 s, or longer (30 s) to keep Claude Code sessions to
   one push per session pause?
2. Should the desktop also pull on window focus, or only on launch and
   unlock? Focus is the most useful and the noisiest.
3. Is "Synced N ago" wanted in the phone's list header, or only in Settings?

## Status of this record

Draft. Written 2026-09-03 after the sync-server outage. Becomes a milestone
when Jay accepts it; product code follows acceptance, not this draft.
