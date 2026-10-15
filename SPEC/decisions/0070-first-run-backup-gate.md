# ADR 0070: First run connects an app first; a backup gate holds setup and sync setup

Status: Accepted 2026-10-15 (Jay approved the first-run mock and its safety rule) · Review: CLEARED WITH WOUNDS, wounds fixed or stated

## Context
Setup asked for a passphrase, then a device key backup, then a model, then a tour. Connecting an AI app was not in setup at all. The approved mock moves the backup after the first connection, when the vault holds one test memory. Moving it later must not make it skippable.

## Decision
- D1: Setup order: welcome (with a static demo preview), passphrase, connect an AI app, try it, back up the device key, then optional model and sync.
- D2: `~/.northkeep/setup.json` (mode 0600) records `{ backup_confirmed, vault_path }`. New setup writes `false` before it creates the vault. No file, or a file naming another vault, counts as confirmed. A damaged file counts as not confirmed.
- D3: `POST /api/setup/backup-confirmed` sets it true; it needs an existing, unlocked vault and `{ confirmed: true }` from the required checkbox.
- D4: The app's `POST /api/sync/config` refuses with 409 while a vault exists and the backup is not confirmed. With no vault (a second machine joining) it is allowed.
- D5: After a relaunch with the backup unconfirmed, the app unlocks and goes straight to the backup step. Setup has no way to finish without it.
- D6: The demo is static text in the page. It writes nothing and sends nothing.

## Consequences
- The gate takes the person's word; NorthKeep cannot see the copy. KNOWN-LIMITS says so.
- The gate guards setting a server in the app, not sync itself. A `sync.json` left from an earlier vault keeps auto-sync running, and `northkeep sync config` does not check. KNOWN-LIMITS says both.
- Removing `setup.json` by hand lifts the gate. It guards against forgetting, not against the owner.

## Rejected
- Storing the flag inside the vault: the sync-config check runs while the vault may be locked.
- Keeping backup before connect: safer by a margin of one test memory, at the cost of the first-run moment.

## What leaves the machine
Nothing new. The gate only refuses a sync server change; the connect step reuses the existing Connect, Desktop routes, which write local app config files.

## Review
One round against the code, CLEARED WITH WOUNDS:
- "Sync stays off" overstated: push, pull, wake and auto-sync never read the flag, so a leftover `sync.json` syncs. Claims narrowed to setting a server in the app (KNOWN-LIMITS, site).
- CLI `sync config` ignores the flag on an app-made vault. Stated, not gated.
- A stale `false` gated unrelated vaults. Fixed: the flag names its vault (D2), with a test.
- Clean: write order, 0600 temp-and-rename, damaged file, confirm-route refusals, relaunch routing, focus trap, no innerHTML, static demo, same full-access connect default, nothing new leaves the machine.

## Links
Mock: project files `app-review-2026-10/mocks/first-run.html`. ADR 0067 for the sync limit.
