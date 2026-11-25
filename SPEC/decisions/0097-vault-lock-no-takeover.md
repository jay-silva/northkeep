# ADR 0097: A running app keeps the vault, and a save refuses if the vault changed under it

Status: Accepted 2026-11-25 (Jay: "Accept 97", "Limit build 97") · Review: NOT CLEARED twice, findings folded in

## Context
Every Mac app that changes the vault takes a lock file first, because a save replaces the whole vault file. A lock older than 60 seconds was taken over even when its owner was still running. The owner then saved anyway and one side's changes were lost with no message. Seven merge reviews (PRs 99 and 100, closed) reproduced it on path after path.

## Decision
- D1: A vault lock whose owner is still running is never taken over. Another app waits, then gets the vault-is-locked message, naming the holder.
- D2: A lock is dead when its owner has exited, or when it names an earlier start of the machine (an identity in the lock, not a clock). A lock with no readable owner is dead after 60 seconds. Dead locks are taken one stealer at a time, re-read first. Locks are written whole.
- D3: On the Mac, a save first checks that the vault file is the one this handle opened or last saved, by the mark every save already stamps. If not: "The vault changed while this was running. Nothing was saved. Try again." The check is on unless a platform opts out.
- D4: The phone opts out, in one place, until tested on a device.
- D5: An app from before this change can still cause the loss while it runs. That is a listed limit; older apps are not locked out (Jay: "Limit").
- D6: The sync-transfer lock keeps its age takeover. KNOWN-LIMITS lists every limit here.

## Consequences
- Easier: between current apps, a lost save becomes a visible "locked" or "try again" on every Mac path.
- Harder: a stuck or paused app holds the vault until it is quit. Long work under the lock blocks other apps for as long.
- Harder: a crashed app's lock can look owned (process number reused) and must be deleted by hand.
- Harder: stopping sharing, and deleting a shared project from the command line, change Cloud Connect before the local save.

## Rejected
- A longer limit: the loss stays, only rarer.
- Fixing each path, or only listing the limit: reviews could not bound it.
- Making older apps refuse the vault: the phone would stop opening it until a phone release.

## What leaves the machine
Nothing.

## Links
- Reviews 1 and 2: `~/Claude/Reports/Evidence/northkeep/2026-11-25-design-review1-0097.txt`, `…review2-0097.txt`
- Code: `packages/core/src/lock.ts`; `Vault.save` in `packages/core/src/vault.ts`
- Acceptance test, agent-run, real processes, temp home: `pnpm exec vitest run --config e2e/vitest.config.ts e2e/vault-lock.test.ts`. A holder keeps a lock that looks five minutes old while a save and a read are refused; nothing is missing after. With the lock deleted by hand, whichever app saves second is refused. Dead locks are taken at once. Six processes race for one.
