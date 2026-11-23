# ADR 0088: An agent that ran the acceptance test may report the pass

Status: Proposed 2026-11-23, awaiting Jay · Review 1: pending

## Context
ADR 0065 tells agents to report a milestone passed only when the user says its acceptance test passed. On 2026-11-23 Jay changed his own agent rules: an agent runs each milestone's acceptance test itself, locally, saves the evidence, and records the pass. His rules override NorthKeep's sentence today, so every agent has to settle the conflict. NorthKeep's sentence also reaches users who never asked for this.

## Decision
- D1: The pinned sentence (ADR 0065 D4, layers 2 and 4) becomes: "Report a milestone passed only when the user says its acceptance test passed, or, if the user's own instructions allow it, when you ran that exact acceptance test yourself on the real thing, not a stand-in, and send evidence naming where you saved what you saw. Never mark a milestone passed on your own judgment; reading code or running other tests does not count." Both servers and the contract send it. The contract's new renders join the released set, so installed copies report stale, not edited. The hosted connector has no checkpoint or wrap, so it still records no pass.
- D2: `project_checkpoint` and `project_wrap` take an optional `evidence`: one line, up to 300 characters, accepted only with `milestone_passed`. Core appends "(Evidence for M3: …)" to that save's Log entry. It is part of the operation fingerprint, so replaying an operation id with different evidence is refused.
- D3: Nothing else changes. An agent's pass is still stamped `(agent)`, only on the current milestone, at checkpoint or wrap. `(you)` still comes only from the Mac app, `northkeep projects pass`, or the user's own raw edit, and Confirm stays on `(agent)` lines.
- D4: The two milestone refusals say "after its acceptance test passed" instead of "after the user says", so they cannot contradict D1.

## Consequences
- Easier: Jay's agents follow NorthKeep and his rules at once, and a pass recorded this way names its evidence in the Log.
- Harder: an `(agent)` stamp no longer means the user spoke. KNOWN-LIMITS says so, and that NorthKeep checks neither the run nor the path.
- A user whose instructions say nothing about this keeps ADR 0065's rule.

## Rejected
- Unconditional wording, without "if the user's own instructions allow it": it loosens every user's default to settle one user's conflict. Dropping that clause is the whole change if Jay wants it.
- Evidence on the milestone line: it changes ADR 0065's line grammar, the connector copy and down-sync's pass comparison.
- Requiring evidence with every pass: a pass the user reported has no file to name.
- A new stamp such as `(verified)`: NorthKeep cannot check what it would claim.

## What leaves the machine
Nothing new. Evidence is text in the project document's Log and goes only where that document already goes. The instruction is static text.

## Links
Amends: ADR 0065 D4 · Review record: docs/design/adr-0088-agent-run-acceptance-tests.md
