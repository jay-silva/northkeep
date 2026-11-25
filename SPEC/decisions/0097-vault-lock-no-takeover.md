# ADR 0097: A running app keeps the vault, and a save checks it still has it

Status: Draft for Jay, 2026-11-25 (Jay: "Speed it up and fix the lock") · Review: not yet run

## Context
Every app that changes the vault takes a lock file first, because a save replaces the whole vault file. Today a lock older than 60 seconds is taken over by the next action, even when its owner is still running. The owner then saves anyway. One side's changes are lost and nothing shows a message. Seven merge reviews on 2026-11-25 (PRs 99 and 100, both closed) reproduced the loss and kept finding new paths. The fault is in the lock.

## Decision
- D1: A lock whose owner is still running is never taken over, however old. Another app waits its usual 5 seconds, then shows the vault-is-busy message, which now names the app holding it.
- D2: A lock is taken over only when its owner has exited, as today, or when the lock file cannot be read as ours and is over 60 seconds old.
- D3: Before a save, the vault checks that this process still holds the lock it took. If not, the save is refused: "Another app took the vault while this was running. Nothing was saved. Try again." Nothing is then confirmed to Cloud Connect.
- D4: The phone is unchanged: its actions already wait in line.
- D5: KNOWN-LIMITS states the two "Harder" limits below, in the same PR.

## Consequences
- Easier: the silent loss ends for every path at once. A slow sync makes another app say "busy" where it used to lose a save.
- Easier: deleting a lock file by hand can no longer cause a silent overwrite; D3 catches it.
- Harder: an app that is running but stuck holds the vault until someone quits it. Today it clears itself after a minute.
- Harder: if a crashed app's process number is reused by another program, the lock looks owned and must be deleted by hand.
- Risk: a save made outside a lock is not checked by D3. The build lists and tests each place a vault file is written.

## Rejected
- A longer limit than 60 seconds: the loss stays, only rarer.
- Refreshing the lock's age: planning and saving run without a pause, so no timer fires.
- Fixing each path (PR 99): four reviews, and two paths were still open.
- Listing it as a known limit only (PR 100): three reviews could not bound it.

## What leaves the machine
Nothing. No network call, dependency or schema change.

## Links
- Evidence: `~/Claude/Reports/Evidence/northkeep/2026-11-25-pr99-merge-review.txt`, `2026-11-25-pr100-merge-review.txt`
- Code today: `packages/core/src/lock.ts`; `Vault.save` in `packages/core/src/vault.ts`
- Acceptance test, agent-run on throwaway vaults: one process holds the lock past the old limit while a second tries to save and a third reads. Both get the busy message, the first saves, nothing is missing. Then the lock file is deleted mid-hold and the holder's save is refused.
