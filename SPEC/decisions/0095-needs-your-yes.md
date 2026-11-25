# ADR 0095: Needs your yes: one list on the phone where the user confirms

Status: Proposed 2026-11-25 (prerequisite for milestones 5 and 8) · Draft: not reviewed, not accepted

## Context
Cloud replaces and forgets wait for a yes in the Mac's or command line's sync review; confirming needs a terminal. Milestones 5 and 8 add more. Jay rarely opens the Mac, never a terminal, and chose the phone, which applies only additions (ADR 0063) for want of a preview screen.

## Decision
- D1: One phone screen, "Needs your yes": waiting items, oldest first, each with Yes, No, Not now. This milestone lists cloud replaces and forgets; milestones 5 and 8 add their level 2 items, answered in chat.
- D2: Every line shown is read from the phone's own vault, or from the row this sync would add; ids come from the connector. Saved text is flattened to one line before control and direction characters go, inside a labelled box; app names "as the app reported".
- D3: The screen is ADR 0063's preview, one item at a time. The bulk sync stays additions only. Yes re-reads the queue and vault, refuses if anything changed or the phone lags its sync server, then applies that one change, saves and pushes the vault. With a sync server it never acks: the Mac's next pull settles the queue. Project changes stay with the Mac.
- D4: No changes no memory. A replace is dropped through today's ack. A forget is dropped through a new ack field, `keep_forgets`, which the connector ships first. Not now hides an item on this phone until midnight.
- D5: Undo: a phone replace can be undone (this milestone builds that half of milestone 5's undo, if Jay agrees); a forget cannot, and says so first.
- D6: Notice: a count line in the app and an icon badge from a small local module, no network. A push notification needs its own ADR.

## Consequences
- Easier: nothing waits for a terminal.
- Harder: two devices deciding at once hit whole-vault sync's existing limits.
- Committed to: the phone reads pending version 3, not 2; no new pending version, no schema step; KNOWN-LIMITS that the badge updates only while NorthKeep runs, forgets name no app, and a yes reaches cloud apps when the Mac next syncs. An adversarial review before build: this changes who decides and shows AI-written text for review.

## Rejected
- Pushing from the connector: Apple becomes a new recipient.
- The phone acking its yes: a forget would vanish from the Mac's queue.
- Bulk approve: the incident 0063 records.
- Open questions on the phone: chat asks them; the phone confirms answers.

## What leaves the machine
To the connector: a pending read when the phone opens (it learns when), a "No" as ids, and, if Jay agrees, already-shared content pushed after a yes. Nothing reaches Apple.

## Links
Design and review log: docs/design/adr-0095-needs-your-yes.md · Depends on: ADRs 0063, 0084, 0085 · Shares decisions with 0092, 0094, 0096
