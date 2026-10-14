# ADR 0065: Project milestones: agents record the plan, only Jay confirms a pass

Status: Accepted 2026-10-13 (K0) · Reviews (design doc): design review CLEARED WITH WOUNDS; K1 code review CLEARED WITH WOUNDS; K2 review CLEARED WITH WOUNDS; K4 review CLEARED WITH WOUNDS, with F1 narrowing the claim; final recheck CLEARED WITH WOUNDS, wounds fixed. Every wound is fixed.

## Context
Jay wants each project's milestone plan recorded at kickoff and visible on Mac and phone. A milestone passes only when Jay runs its test and says so.

## Decision
- D1: A level-2 `## Milestones` section holds the plan, one line per milestone: `- [ ] M3 Title | test: …`. A pass adds `| passed <UTC date> (you|agent)`. Ids are unique and passes come first. Limits: 20 lines of 240 characters. `none: <reason>` means no plan on purpose.
- D2: One pure module, `project-milestones.ts`, owns the grammar and transitions. The connector is untouched until K4.
- D3: An agent write keeps every passed milestone byte-identical by id. It adds no pass except an `(agent)` pass of the current milestone at checkpoint or wrap, and it leaves the section valid. Vault writes take a required `actor`. MCP cannot forget or retype a project document. `remember` refuses new project documents.
- D4: Kickoff has four layers:
  1. Creating a project through MCP (`project_create`, or `project_update` with no revision) requires milestones, except for drafts.
  2. Server instructions tell agents to propose and wait for Jay.
  3. Resume shows a once-per-session note asking Jay, never inventing a plan.
  4. One contract sentence.
- D5: The desktop shows Mark passed and Confirm, which stamp `(you)`. The CLI `pass` command needs a typed yes on a terminal; this stops a plain pipe, not a program that fakes a terminal. The phone is read-only.
- D6: Down-sync holds any cloud row that changes passes as a `milestones_changed` conflict. When this device has one current version, the conflict views list each pass change; with more than one, no list is shown and take-theirs is refused.

## Consequences
- Easier: visible progress, and NorthKeep's tools cannot fake Jay's confirmation.
- Harder: only Jay can repair a malformed section.
- Limits: local programs with the vault unlocked can still change milestones; claims hold on K1+ devices only; a cloud forget queued before K4 still applies once Jay approves it in the sync review, which names the passes it would remove.

## Rejected
- Next Actions convention: agents rewrite it.
- JSON block, or one memory per milestone: harder to read and order.
- A sixth fixed heading in `project-doc.ts`: it forces an early connector deploy.
- Owner-only passing: plans would go stale.

## What leaves the machine
Nothing new. Milestones travel inside the project document. Server instructions are static text. Amends ADR 0050: a cloud create carrying a passed milestone is held, not marked Shared on arrival.

## Links
Design and review record: docs/design/project-milestones.md · Extends: ADRs 0039, 0042, 0048, 0050, 0052, 0062, 0063
