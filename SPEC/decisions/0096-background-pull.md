# ADR 0096: Background pull: the Mac helper brings in what cloud apps wrote

Status: Withdrawn 2026-11-25, not built · One review, and why, in the record

## Context
A cloud app's memory reaches the vault only when a person pulls; the automatic engine only pushes (`connector-auto.ts:10-21`). No always-running process holds the vault key: the Keep Watch helper only re-enables sleep, and the Mac app's server quits with the app. What runs most is the NorthKeep server each local AI app starts.

## Decision
- D1: The automatic engine also pulls, in the local AI app server and the Mac app's server. Triggers: launch, unlock, each automatic vault push, pull or in-sync check. No timer. The `share auto` switch covers it.
- D2: It pulls only where it may push: this device holds exactly the newest vault, or has no vault sync.
- D3: It applies only new memories in collections Shared here, within the size cap, at most 50 per pull; the rest wait for the next trigger. Never a project document, new project, ADR 0050 fold, forget, replacement or cloud replace: those wait for a person, listed on the phone (ADR 0095). It acks forgets and replaces already settled here, so a phone yes leaves the queue. A change to an existing memory joins only through a later ADR under the shared trust rule.
- D4: No network call inside the vault lock: fetch; plan, apply and save under the lock; then ack. Until an ack lands the device keeps each saved memory's connector id, so a failed ack never re-adds a memory forgotten meanwhile.
- D5: A pull that added anything ends that run; the vault push it causes updates Cloud Connect without pulling again. A failed pull is logged and never fails an app's save or search.
- D6: The last pull's time and counts show in `northkeep share status` and the Cloud screen. No notification.

## Consequences
- Easier: cloud memories arrive with no tap while NorthKeep runs unlocked.
- Harder: nothing pulls while no NorthKeep process runs, the vault is locked, or this device is behind or diverged. A cloud-only customer running neither app gets nothing.
- Trusted: the connector service relays cloud writes honestly; with no person present it can add up to 50 memories per pull to Shared collections.
- Committed to: no schema step; reuses pending v3. Older Macs, the phone and older connectors see nothing new; an older server never pulls.

## Rejected
- The Keep Watch helper: root, no key, off-only (ADR 0080).
- A timer: ADR 0044 D4 promises none.
- A login item holding the key all day: a larger design.

## What leaves the machine
No new content or recipient. Each run adds one pending read and, when anything lands or settles, one ack. The connector learns when a local NorthKeep process is open and unlocked, and how soon cloud writes arrive.

## Links
Design: docs/design/adr-0096-background-pull.md · Depends on: ADRs 0044, 0050, 0063, 0085 · Works with: ADRs 0092, 0094, 0095
