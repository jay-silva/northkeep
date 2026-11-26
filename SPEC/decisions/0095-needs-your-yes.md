# ADR 0095: Needs your yes: one phone list for what NorthKeep accepted and what waits for you

Status: Accepted 2026-11-26 (Jay: "C yes", "Mock ok", "Build 95.") · Review: CLEARED WITH WOUNDS, revised; the revision was not re-reviewed, by Jay's choice

## Context
Cloud replaces and forgets wait for the Mac's sync review; milestones 5 and 8 accept some chat answers and hold others. Jay works from his phone, which applies only additions (ADR 0063); he looked for this list there on 2026-11-25. The phone and the Mac each hold the whole vault and the later push wins, so a decision on one can be undone by the other silently.

## Decision
- D1: One phone screen, two sections. "Needs your yes": cloud replaces and forgets, and, from milestones 5 and 8, waiting answers; each with Yes, No, Not now. "Accepted lately": every chat answer NorthKeep accepted and every Yes given on this phone, newest first, with Undo where one exists.
- D2: Text is read from the phone's vault, or the row this sync adds, flattened, inside labelled boxes. Two long texts open at their first difference. A reported answer reads "<app> reported you said".
- D3: Yes and Undo re-read everything, refuse if anything changed or the phone lags its sync server, apply one change, save and push the vault. The bulk sync stays additions only.
- D4: No drops the request: today's ack for a replace, a new `keep_forgets` for a forget. Not now hides an item until midnight.
- D5: `clearReplaced(id, expectedBy)` undoes a replace, built here. A forget has no undo.
- D6: A Mac or command line acknowledges a cloud replace only after the vault push carrying it has landed.
- D7: Notice: a Review tab with a red count, and an icon badge.
- D8: Decided (Jay: "C yes"): the phone tells Cloud Connect itself after a Yes or an Undo and reads it when the app opens. Accepting an everyday reported answer without a tap arrives with ADR 0092.

## Consequences
- Easier: nothing waits for a terminal; every accepted answer has a phone Undo.
- Harder: after a decision's push lands, a phone that saves while behind still wins the vault and can bring a retired memory back, unasked. KNOWN-LIMITS says so.
- Committed to: the phone reads pending version 3; no schema step; the connector ships `keep_forgets` before the phone build.

## Rejected
- A pull that refuses a copy missing a replaced mark: the phone's Undo looks the same.
- A push notification: Apple becomes a recipient.
- Bulk approve: ADR 0063's incident.

## What leaves the machine
To the connector: a pending read when the list opens and when the app opens (so it learns when), a No as ids, and already-shared content pushed after a Yes or Undo. Nothing reaches Apple.

## Links
Design and review log: docs/design/adr-0095-needs-your-yes.md · Depends on: ADRs 0063, 0084, 0085 · Shares decisions with 0092, 0094
