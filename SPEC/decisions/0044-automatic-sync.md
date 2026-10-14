# ADR 0044: Automatic sync: push after write, fast-forward pull on wake

Status: Accepted by Jay 2026-09-03 · Review: eleven adversarial rounds; 1 to 7 NOT CLEARED, 8 to 11 CLEARED WITH WOUNDS · Shipped in 0.21.0; torn-record repair in 0.22.0 · Amended by ADR 0063

## Context
The Mac never synced on its own; the phone pulled only on install or tap. The hosted sync server failed unnoticed for six days. Devices should sync themselves; conflict handling stays.

## Decision
- D1, the one rule: automatic pull replaces only what the user did not write. The desktop auto-pulls only when its vault is byte-identical to what it last synced and the server is ahead. The phone sets a dirty flag before every user write; moved bytes with nothing dirty are a torn baseline, repaired by fast-forwarding to any differing server copy. Every automatic install keeps the displaced file as `vault.nkv.auto-pull.bak`. ADR 0063: it also refuses any copy that would remove or undo something.
- D2: The Mac pushes after every vault write, debounced 5 s (30 s max), backing off to hourly. A 402/403 pause ends only on a user action; no timer lifts it, but after 10 minutes the next wake or write gets one attempt. Only the default vault syncs automatically (`isAutoSyncVault`). The CLI pushes once on exit, waiting at most 2 s for the sync lock.
- D3: On wake (launch, unlock, foreground) each device calls `GET /api/status`. Server ahead, local unchanged: pull, verify with the key, reload. Local changed or baseline unknown: `diverged`, nothing automatic; no indicator asserts this machine changed.
- D4: Both apps show sync age and errors. Conflict rules unchanged: phone last-writer-wins, generation `max(local, remote) + 1`; desktop 409 says pull then push. No background timers.
- D5: network calls run outside the vault lock; one generation bump per logical push; phone import asks first and keeps `vault.nkv.pre-import.bak`.

## Consequences
- Automatic paths never pull over a user write; the manual pull keeps its warning.
- Limits: ADR 0038 residual N2 stays: a phone conflict can push a newer Mac write off the server (kept in `.conflict.bak` and `.auto-pull.bak`). `sync.json` is unauthenticated; a perfect forgery can pull over an edit. After a fresh machine's first pull, replay checking is inert until the next sync. A CLI write after a torn record, before any wake, reads as diverged. Live push and pull ran on Jay's account 2026-09-04; a real 409 and the phone's new client on a device have no recorded run.

## Rejected
- Automating desktop conflict resolution: the human is there.
- Pushing on changed bytes alone: a torn baseline would roll another device's write off the server.

## What leaves the machine
No separate section in the original; it changes when sync runs, not the wire protocol. The same encrypted vault goes to the same sync server, plus a small status request per wake. ADR 0063 adds Cloud Connect updates.

## Links
Full record: docs/design/adr-0044-automatic-sync.md · Extends: ADRs 0009, 0038 · Amended by: ADR 0063
