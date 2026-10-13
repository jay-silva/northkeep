# ADR 0065: Project milestones: agents record the plan, only Jay confirms a pass

Status: Accepted 2026-10-13 for build (K0) · Review: design CLEARED WITH WOUNDS on the second recheck, wounds fixed; the K1 code gets its own review

## Context
Jay wants each project's milestone plan recorded at kickoff and visible on the Mac and phone. Next Actions cannot hold it, because agents rewrite it on every save. Jay's rule is that a milestone passes only when he runs its test and says so.

## Decision
- D1: A level-2 `## Milestones` section holds the plan, one line per milestone: `- [ ] M3 Title | test: …`. A pass adds `| passed <UTC date> (you|agent)`. Ids are unique, passes come first, and an invalid section reads as malformed. The limits are 20 lines and 240 characters per line. `none: <reason>` means no plan on purpose.
- D2: One pure module, `project-milestones.ts`, owns the grammar and the transitions. `project-doc.ts` and the connector stay untouched until K4.
- D3: An agent write keeps every passed milestone byte-identical by id. It adds no pass except an `(agent)` pass of the current milestone at checkpoint or wrap, and it leaves the section valid. Vault writes take a required `actor`. MCP refuses forgetting a project document or changing its type. `remember` refuses new project documents.
- D4: Kickoff has four layers:
  1. MCP `project_create` requires milestones, except for drafts.
  2. Server instructions tell agents to propose and wait for Jay.
  3. Resume shows a once-per-session note asking Jay, never inventing a plan.
  4. One contract sentence.
- D5: The desktop shows Mark passed and Confirm, which stamp `(you)`. The CLI `pass` command needs a typed yes on a terminal. The phone is read-only.
- D6: Down-sync holds any cloud row that changes passes as a `milestones_changed` conflict. Every conflict dialog names the pass changes.

## Consequences
- Easier: progress is visible, and an AI app using NorthKeep's tools cannot fake Jay's confirmation.
- Harder: agents cannot repair a malformed section. Jay repairs it in the app.
- Limits: a program on the Mac with the vault unlocked can still change milestones. The claims hold only on K1 or later devices. Cloud forgets queued before K4 still apply.

## Rejected
- Next Actions convention: agents rewrite it.
- JSON block: harder to read in the mirror and on the phone.
- One memory per milestone: ordering and a second phone parser.
- A sixth fixed heading in `project-doc.ts`: it forces an early connector deploy.
- Owner-only passing: plans would go stale.

## What leaves the machine
Nothing new. Milestones travel inside the project document. That means sync ciphertext, Shared scopes on the connector, and the git mirror. Server instructions are static text with no vault content. Amends ADR 0050: a cloud create carrying a passed milestone is held, not marked Shared on arrival.

## Links
Design and review record: docs/design/project-milestones.md · Extends: ADRs 0039, 0042, 0048, 0050, 0052, 0062, 0063
