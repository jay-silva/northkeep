# ADR 0097: A running app keeps the vault, and a save refuses if the vault changed under it

Status: Revised 2026-11-25 after review 1 (NOT CLEARED), awaiting Jay. He accepted version 1 ("Accept 97"); D2 to D4 changed.

## Context
Every Mac app that changes the vault takes a lock file first, because a save replaces the whole vault file. Today a lock older than 60 seconds is taken over even when its owner is still running. The owner then saves anyway and one side's changes are lost with no message. Seven merge reviews on 2026-11-25 (PRs 99 and 100, closed) reproduced it on path after path.

## Decision
- D1: A lock whose owner is still running is never taken over. Another app waits 5 seconds, then shows the vault-is-busy message, which names the holder.
- D2: A lock is dead when its owner has exited, or when it is older than this Mac's last start. Taking one re-checks it at that moment, so two apps cannot both take it.
- D3: On the Mac, a save first checks that the vault file is the one this app opened or last saved. Each save already stamps the file with a fresh mark; a different mark means someone else wrote. The save is refused: "The vault changed while this was running. Nothing was saved. Try again." A sync pull that replaces the file makes the same check. It also covers a lock deleted by hand and older app versions.
- D4: The phone is unchanged. Its actions already wait in line; D3 stays off there until tested on a device.
- D5: KNOWN-LIMITS states the limits below, in the same PR.

## Consequences
- Easier: a lost save becomes a visible "busy" or "try again" on every Mac path.
- Harder: an app that is stuck or paused holds the vault until it is quit. A first meaning search can hold it for minutes.
- Harder: stopping sharing deletes Cloud Connect's copy before the local save. If that save is refused, the collection still shows as shared here.
- Harder: an app from before this change still takes over after 60 seconds. The newer app's save is then refused, not lost.
- Risk: D3 touches every save; the build tests each writer.

## Rejected
- A longer limit: the loss stays, only rarer.
- Checking the lock at save (the first D3): saves made with no lock, and pulls, slip past.
- Fixing each path, or listing it as a limit: seven reviews could not bound it.

## What leaves the machine
Nothing.

## Links
- Review 1: `~/Claude/Reports/Evidence/northkeep/2026-11-25-design-review1-0097.txt`
- Code: `packages/core/src/lock.ts`; `Vault.save`; `installBlob` in `packages/sync/src/client.ts`
- Acceptance test, agent-run, three real processes, throwaway vaults: one holds the lock past the old limit; a second saving and a third reading get the busy message; nothing is missing. The lock file is deleted mid-hold, a newcomer saves, the holder's save is refused, the newcomer's memory survives. A lock from before the last start is taken at once.
