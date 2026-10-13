# Project milestones: design and review record (ADR 0065)

- **Date:** 2026-10-13, third draft the same day
- **Status:** Accepted for build (milestone K0), CLEARED WITH WOUNDS on the second recheck with both wounds fixed in this text. This ADR is inside the review gate for two reasons. It changes who decides, because an agent may not confirm a milestone. It also publishes a claim about what NorthKeep enforces. The first review and the first recheck against the code each returned NOT CLEARED. The second recheck returned CLEARED WITH WOUNDS, and this text fixes both wounds. The K1 code gets its own review against this ADR. Each round is recorded under "Adversarial review" below.
- **Deciders:** Jay (product owner; approved the final proposal and its mocks on 2026-10-13), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0042 (contract installer), ADR 0048 (revision-bound handoff writes), ADR 0052 (provenance, draft projects), ADR 0062 (operation-id ledger), ADR 0063 (sync guardrails)
- **Amends:** ADR 0050 and invariant 1's named exception, by one condition. Decision 3 explains it.
- **Does not touch:** the vault schema, the row envelope, crypto or key handling, redaction tiers, `project-doc.ts` before K4, the project board, the git mirror's output

## Context

Jay wants every project to carry its milestone plan from the day it is designed. He wants to see what is left in the app, on the Mac and on his phone. His open question was how an agent knows to record the plan at the start.

Today a project document has five fixed sections plus Open Questions and Files (`packages/core/src/project-doc.ts:25`, `packages/core/src/project-handoff.ts:222`). Next Actions cannot hold the plan. Checkpoint and wrap require Next Actions, and agents rewrite it on every save (`packages/mcp-server/src/server.ts:1140`). The phone and the desktop render only the sections they name (`apps/mobile/app/project/[slug].tsx:47-51`, `apps/web/static/index.html`). An unknown section stays invisible until new builds ship.

Jay's working rule decides the shape. A milestone ends only when he runs its acceptance test and says it passed (CLAUDE.md, Milestones). An agent may therefore write the plan, but the record of a pass has to say who passed it.

Three designs and two design reviews came before this ADR. Their notes are in the project's shared reviews folder (`milestones-design-review.md`, `milestones-fable-design.md`, `milestones-second-review.md`). This ADR pins the merged result.

## Decision 1: The plan is a `## Milestones` section with a fixed line grammar

```
## Milestones
- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)
- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-09 (agent)
- [ ] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash
```

A section can instead hold exactly one line, `none: <reason>`, which records that the project has no plan on purpose.

- An open line is `- [ ] M<n> <title> | test: <test>`. A passed line adds ` | passed <YYYY-MM-DD> (you|agent)` and checks the box.
- The section is the level-2 heading `## Milestones`. A heading named Milestones at any other level is not the plan, and the level-1 project title is never a section (Decision 2).
- `M<n>` is the milestone's identity, `/^M[1-9][0-9]{0,2}$/`. A duplicate id makes the plan `malformed`. Every rule matches on the id, never on the title.
- Passed milestones always come first. A passed line after an open line makes the plan `malformed`. Every pass is of the current milestone (Decision 2), so a valid history always has this shape.
- The title and the test may not contain `|`, a line terminator, or a control or format character (`\p{Cc}\p{Cf}`, U+2028, U+2029). A title is at most 80 characters and a test at most 120. A whole line is at most 240 characters, and a plan holds at most 20 milestones, about 4.8k characters at most.
- The stamp holds one of two fixed words. No host name, client label or other free text enters a milestone line. The revision's provenance already records which app wrote it (ADR 0052).
- The pass date is the UTC date of the save. A replayed save takes it from the ledger's `saved_at` (`packages/core/src/vault.ts:964`), so a replay rebuilds the same bytes.
- The current milestone is the first open line. No "in progress" state is stored, so "one milestone at a time" cannot fall out of sync with the list.
- The section never rolls into an archive. A Milestones section over its limits is refused with a message from the milestone module that names Milestones. The 16 KiB document cap message in `project-doc.ts:22-23` names only the other sections until K4, when that file changes anyway and the message gains Milestones.

The parsed shape is a discriminated union. It cannot represent a passed milestone without a date or an author:

```ts
type MilestoneId = string & { readonly __brand: 'MilestoneId' };
type Milestone =
  | { id: MilestoneId; title: string; test: string; state: 'open' }
  | { id: MilestoneId; title: string; test: string; state: 'passed'; on: string; by: 'you' | 'agent' };
type MilestonePlan =
  | { kind: 'absent' }
  | { kind: 'none'; reason: string }
  | { kind: 'plan'; items: Milestone[] }
  | { kind: 'malformed'; reason: string };
```

`ProjectView` gains `milestones: MilestonePlan`. `ProjectOverview` (`project-handoff.ts:323`), which feeds the desktop and phone lists, gains `milestones: { passed: number; total: number; current: { id: string; title: string } | null } | null`. `ProjectSummary` does not change, so MCP `project_list`, the board and the git mirror index keep their current output.

## Decision 2: One pure module owns every milestone rule

`packages/core/src/project-milestones.ts` holds the parser, the formatter, the limits and the transition functions. It imports nothing with I/O, and every caller goes through it.

- `parseMilestones(body): MilestonePlan`
- `formatMilestones(plan): string`
- `replacePlan(current, incoming)` is for agents. Agents send open milestones only, `{ id?, title, test }`, or a `none:` reason. Passed milestones carry over from `current` by id, byte for byte, in their original order and position. An incoming id that names a passed milestone is refused, and so is incoming text that looks like a checkbox or a stamp. A current plan that is `malformed` is refused with a message that says to repair it in the app. Agents cannot rebuild a plan whose passed lines they cannot see.
- `recordAgentPass(current, id, savedAt)` stamps `(agent)`. It refuses any id that is not the current milestone.
- `confirmPass(current, id, savedAt)` stamps `(you)`. It accepts the current milestone or one already passed by `(agent)`.

**The agent write rule.** Every agent write to a project document goes through one check, `assertAgentWriteKeepsPasses(before, after, allowedPass?)`. It compares the parsed plans, never a text scan, because the first recheck showed that a text scan misses a passed line moved to another section or a renamed heading. Both documents are parsed with the same line-ending normalisation as `parseProjectDoc` (`project-doc.ts:102`).

- **If `before` has a plan with passes.** `after` must have exactly one `## Milestones` section whose plan is a `plan`. Every passed milestone in `before`, matched by id, must appear in `after` as the same line, byte for byte. `after` may have no other passed milestone, except the single `(agent)` line `recordAgentPass` produced for `allowedPass`. Renaming, moving or emptying the section therefore fails, and so does fencing a passed line.
- **If `before` is `absent`, `none` or an open-only plan.** `after` may have no passed milestone at all, except that one `(agent)` line.
- **If `before` is `malformed`.** The Milestones section's body must be byte-identical in `after`. A hand-broken section cannot block ordinary checkpoints, and an agent cannot "repair" it into a new history.
- **Text outside Milestones.** `- [x]` lines outside the section are ignored. Checked tasks in Next Actions are normal (ADR 0054), and they never count as milestones.
- **In every case.** `after` must parse with no duplicate owned section. An agent write may not produce a `malformed` Milestones section, unless `before` was already malformed and the body is byte-identical. The second recheck found that without this, an agent could plant a near-valid forged `(you)` line that Jay's own repair would then make valid.

The check runs inside the write transaction, on the bytes about to be committed. The vault cannot tell an agent from Jay on its own: the MCP server, the CLI, the desktop, the phone and the librarian all call the same `editMemory`, `updateProject` and `checkpointProject`. So `editMemory`, `forget`, `updateProject`, `checkpointProject` and `replaceProjectContent` take a required `actor: 'agent' | 'owner'` in an options object, with no default. Every caller states which it is, and the type checker finds any caller that does not. The rule runs only for `'agent'`.

- `packages/mcp-server/src/server.ts` passes `'agent'`.
- Down-sync passes `'agent'` for every row it applies on its own, so the rule runs again inside the write transaction after `planDownSync` has checked it.
- "Take theirs" passes `'owner'`.
- The CLI, the desktop API, the phone, converse `:undo` and the librarian pass `'owner'`. The librarian's writes run on Jay's accept (`packages/cli/src/reviewCmd.ts`, `apps/web/src/api.ts:2035`), and it drops project documents anyway.
- A test pins that every vault call in `server.ts` passes `'agent'`.

`remember` can also create a project document. Converse distillation commits model-derived rows through `vault.remember` (`packages/converse/src/turn.ts:619-626`) with no project guard, and web converse accepts a `project:` scope (`apps/web/src/converse.ts:259`). K1 moves the existing `assertNotNewProjectWorkingMemory` check into `vault.remember` itself, so no caller can create a working row in a project scope that way. Projects are created only through `createProject` and `replaceProjectContent`.

`confirmPass` is exported through its own package entry point, `@northkeep/core/project-milestones-owner`, with its own `exports` entry. The MCP server and the connector do not import it, and a test fails if either does. This keeps the code organised. It is not a security boundary, because the desktop server imports it and any local program can start that server (claim 2).

The section list is defined once. `PROJECT_OWNED_SECTIONS` in `project-handoff.ts` replaces the copies at `project-handoff.ts:222` and `:292`, `packages/core/src/project-import.ts:38` and `packages/cli/src/projectsCmd.ts:594`. The title check at `project-handoff.ts:281` reads that list as well.

Two existing defects are fixed in K1 because the new section would inherit them. The first review found both by running the code.

- `owned()` (`project-handoff.ts:177`) and `setSection` (`:180`) match a section by title at any heading level, so they also match the level-1 project title. A project titled "Files" reads fine until a files write lands under the title heading. With "Files" already present, the title is accepted and the next write fails on a duplicate. Both functions will skip the level-1 title.
- `writeProject` (`vault.ts:996-1023`) and `editMemory` (`vault.ts:569-610`) do not parse their result before they commit. `getProjectView` runs only after the commit. For project documents, both will parse the result inside the transaction and refuse a duplicate owned section. That parse is where the agent write rule runs.

A duplicate `## Milestones` therefore cannot be written by NorthKeep. A document that already has one, from an older build or a hand edit, is unreadable in the same way as a duplicate of any other owned section. A Milestones section that breaks the grammar reads as `{ kind: 'malformed' }`, and the rest of the project stays readable.

`project-doc.ts` does not change in K1. The connector keeps its byte-identical copy of that file (`apps/connector-server/test/m14-projects.test.ts:30`), so nothing deploys before K4. In K4 the connector gets a byte-identical copy of `project-milestones.ts` with the same kind of identity test, because the connector cannot import core at runtime (ADR 0040).

## Decision 3: Who can change what

| Path | Can do | Refused |
|---|---|---|
| MCP `project_create` | Record a plan of open milestones, or `none:` | Any passed line or stamp. Milestones when `draft: true`. |
| MCP `project_update` | Replace the open part of the plan through `replacePlan` | Anything the agent write rule refuses |
| MCP `project_checkpoint` and `project_wrap` | `milestone_passed: "M3"` for the current milestone, stamped `(agent)` | Any other id, and anything the agent write rule refuses |
| MCP `memory_edit` on a project document | Edits the agent write rule accepts | Any edit that changes the passed lines. Any type change away from `working`. |
| MCP `memory_forget` on a live project document | Nothing | Always refused. Jay forgets a project in the app or CLI. |
| Hosted `project_create`, `project_update` (K4) | Same as local, through the copied module | Same as local |
| Hosted `memory_forget` of a project document (K4) | Nothing | Always refused at the connector, the same as local |
| Down-sync on the Mac (`packages/sync/src/connector-client.ts`) | Fast-forwards that keep the passes | See the paragraph below |
| Desktop app Mark passed and Confirm | `confirmPass`, with `expected_revision` | Stale page refuses with `stale_project` |
| Desktop app restore of an earlier revision (`apps/web/src/projectsApi.ts:119`) | Owner action. It may undo a pass. The confirm names each pass it would undo. | |
| Desktop raw edit and CLI `projects set` | Owner actions, unchanged | |
| CLI `northkeep projects pass <slug> <id>` | `confirmPass` after a typed `yes` | stdin not a TTY. No `--yes` flag and no environment-variable bypass, unlike `getPassphrase` (`packages/cli/src/prompt.ts`) |
| Phone milestone view | Display only | Every milestone write. The phone's existing memory screen can edit or forget any row, including a project document. Those are owner actions and pass `'owner'`. |

**Down-sync.** The connector is the only source of cloud rows, and from K4 it refuses every passed line, every stamp and every project-document forget. The Mac-side rule is a second line of defence for rows queued before K4 or from a faulty connector.

- **Before any row applies.** `planDownSync` runs the agent write rule against the local head. That includes `to_mark`, which is computed in the first pass today (`connector-client.ts:545`); the check moves ahead of it.
- **When a row fails.** It becomes a conflict with the new reason `milestones_changed`, whatever older reason (stale, moved, legacy) it would also have. A create has no local head, so it is compared against an `absent` plan, and a cloud create carrying a passed line is held.
- **"Take theirs."** Resolving the conflict is an owner action, and both choices stay available. The dialog names every pass that "take theirs" would add, change or remove. That list appears for every conflict reason, not only `milestones_changed`, because an older reason can also carry a pass change. Choosing "take theirs" on a held create marks the scope Shared, and the dialog says so before Jay chooses. That is the ADR 0050 outcome, reached by Jay's explicit choice instead of on arrival. This narrows ADR 0050's exception and invariant 1's wording by one condition: a create carrying a passed line is not marked Shared on arrival.
- **Cloud forgets of project documents queued before K4.** These still apply as they do today. The claims are not published for the cloud until K4, and this residual is listed in KNOWN-LIMITS with them.

**Gaps closed.** Three paths an agent could use today close in K1.

- `memory_edit` can change a project document's type, because `assertNotNewProjectWorkingMemory` returns early when the old row was already the project document (`packages/core/src/project-working-memory.ts:35-36`).
- `memory_forget` blanks a live project document with no project guard (`server.ts:697-717`, `vault.ts:501-533`).
- Both leave the scope with no document, so `project_create` can then rebuild the project with any content.

**Replay.** The operation fingerprint covers only fields listed by hand (`vault.ts:928-936`). K1 adds `milestone_passed`, the one milestone field that checkpoint and wrap take, so replaying an operation id with a different pass refuses as `operation_conflict` (ADR 0062). `project_create` and `project_update` take `milestones` but have no operation id, and their revision binding (ADR 0048) is unchanged.

**Masking.** Project writes are refused while masking is on (`server.ts:492-495`). In that state Jay passes milestones from the app only.

## Decision 4: How the agent knows at kickoff

There are four layers. Only the first is enforced.

1. **The MCP `project_create` tools require `milestones` unless `draft: true`, and refuse it when `draft: true`.** The rule lives in the MCP tool layer, not in core. `northkeep projects set` (`packages/cli/src/projectsCmd.ts:153`), import and the desktop keep working. An agent that has no plan yet sends one line, `M1 Agree the milestones | test: Jay approves the plan`. This makes sure a plan exists. It cannot make sure the plan is good.
2. **Server instructions.** Both servers pass `instructions` to `McpServer` (local `server.ts:526`, hosted `apps/connector-server/src/mcp.ts:154`). Neither sets one today, and SDK 1.29.0 supports it. The pinned text:
   > When the user asks to create a project, propose its milestones and create it only after the user agrees to them. Report a milestone passed only when the user says its acceptance test passed. Never mark a milestone passed on your own judgment.
   This fits the contract's "create a project only when the user asks" (`packages/mcp-server/src/contract.ts:79`). Acceptance checks, host by host, whether the host shows this text to the model. KNOWN-LIMITS lists the hosts that were not verified.
3. **The no-plan note.** `project_resume` adds one fixed line when the plan is `absent` and `isProjectDone` (`packages/core/src/project-board.ts:112`) is false for Current Status: "This project has no milestones. Ask the user whether they want to set them; do not invent them." The local server has one session per process (`server.ts:531`), so it shows the note at most once per project per session, tracked in memory. A `none:` plan or a Done status silences it. The hosted connector has no sessions; it builds a server per request (`apps/connector-server/src/create-server.ts:593-594`). In K4 its `project_get` carries the same note on every call while the plan is absent, and the ADR accepts that repetition there.
4. **The contract sentence.** `CONTRACT_TEXT` gains the instruction text above. The current renders for Claude, Cursor and the Codex block interior are appended to `RELEASED_CONTRACT_RENDER_SHA256` (`contract.ts:121`) where they are not already in the set. Installed copies then report `stale`, not `edited`. K1 acceptance runs `northkeep contract install`.

## Decision 5: Display

The mocks Jay approved with the final proposal on 2026-10-13 are the spec. They cover the phone project page, the phone projects list and the desktop project page.

- **Desktop.** A Milestones block between Current Status and Decisions shows "N of M passed" and the list. A `(you)` pass has a solid check and an `(agent)` pass an outlined one. Mark passed sits on the current milestone and opens a confirm that shows the test text. Confirm sits on `(agent)` lines.
- **Phone list.** Each row shows "N of M · <current id and title>". A project with no plan shows "No plan yet" in muted text and does not count under Needs attention.
- **Phone detail.** The same list as text, read-only.
- **Board.** The project board does not change this round.

## What leaves the machine

Nothing new leaves the machine. Milestones live inside the project document and travel only where that document already goes. That is sync ciphertext (ADR 0009), the connector store for scopes Jay marked Shared (ADR 0040, invariant 1b), and the git mirror (ADR 0053, 0055). Server instructions are static text that NorthKeep sends to the client, with no vault content in them.

## Claims this ADR will publish

These go into KNOWN-LIMITS when the code that makes them true ships. Each holds only on devices running a K1 or later build. Vault sync replaces the whole file (`packages/sync/src/client.ts`), so a second Mac on an older build can still write without these checks, and its changes arrive here.

- From K1: "Through NorthKeep's own tools on your Mac, an AI app cannot mark a milestone as confirmed by you, and cannot change or remove a milestone that has passed."
- From K4, replacing the line above: "Through NorthKeep's own tools, on your Mac or through the Cloud connector, an AI app cannot mark a milestone as confirmed by you, and cannot change or remove a milestone that has passed. A cloud change that would touch a passed milestone waits for your decision, and NorthKeep applies it only if you choose to."
- "An AI app that can run commands on your Mac, as Claude Code can, is not limited by this. While your vault is unlocked, a program on your Mac can change milestones through the NorthKeep command line, by importing a project, by starting the NorthKeep app server and calling it, or with your passphrase. The confirm command refuses to run without a terminal, which stops the simplest case and nothing more."
- "Whether an AI app shows NorthKeep's standing instructions to its model is up to that app. Verified: <hosts>. Not verified: <hosts>."

## Build plan

Each milestone ends with a test Jay runs. The next starts only after he says it passed.

- **K1. Core, local tools and Terminal commands.**
  - Build:
    - the milestone module and the agent write rule;
    - the single section list, and the title and in-transaction parse fixes;
    - the MCP fields;
    - the `memory_edit` and `memory_forget` guards;
    - the no-plan note and local server instructions;
    - the contract sentence;
    - CLI `milestones` and `pass`.
  - Acceptance uses copy-paste commands that need no agent. Each of these is refused: a passed line sent through `project_update`; a `memory_edit` that adds, ticks or removes a passed line, including the two-step malformed route, moving a passed line into another section, and renaming the heading; a `memory_edit` type change; a `memory_forget` of a project document; and `pass` when stdin is not a TTY. An agent write that makes the Milestones section malformed is refused. A converse turn scoped to a project cannot create a working row. A checkpoint on a project with checked tasks in Next Actions still saves. `projects set` still creates a project, and a title of "Files" is refused. Then one live Claude Code session proposes milestones without being asked.
- **K2. Desktop.** The Milestones block, Mark passed, Confirm, the restore warning, and a repair view for a malformed section that highlights any stamped line. A stale page refuses with `stale_project`.
- **K3. Phone.** List progress and the detail section. Jay runs or approves the TestFlight build.
- **K4. Hosted.**
  - Build:
    - the connector fields, server instructions and `project_get` note;
    - the copied module with its identity test;
    - the cap message in `project-doc.ts`;
    - the `milestones_changed` down-sync conflict, with the dialog text;
    - the doc-versus-code pass.
  - Merging to main deploys, so Jay merges.

## Alternatives rejected

- **Next Actions with a convention.** Agents rewrite Next Actions on every save.
- **A fenced JSON block like Files.** Files are structured objects with five fields, and a milestone is a line. A strict line grammar with ids stays readable in `project_get`, in the git mirror, and as plain text on the phone.
- **One memory per milestone.** That needs ordering, a revision per item and a second parser on the phone.
- **A sixth fixed heading in `project-doc.ts`.** That would pull the connector copy, and with it a production deploy, into K1. It would also insert an empty section into every existing document.
- **Owner-only passing.** Jay says "it passed" in chat, and leaving the chat every time would leave plans stale. An `(agent)` pass shows as such, and confirming it takes one click.
- **Protecting confirmations from local programs.** That would need a secret only Jay holds at confirm time, such as a passphrase prompt or OS authentication. It is out of scope here. Claim 2 states the gap instead.

## Adversarial review

### First review, 2026-10-13: NOT CLEARED

A separate Claude agent reviewed the first draft against the code. No other model was used, and no `node_modules` were installed, so vault and SQLite paths were traced by hand. The pure core and contract modules were run with `node --experimental-transform-types` on scratch copies. Findings and how this draft answers them:

1. **Fatal: `memory_forget` then `project_create` erases passed milestones.** Local `memory_forget` (`server.ts:697-717`) reaches `vault.forget` (`vault.ts:501-533`) with no project guard. `writeProject` (`vault.ts:997-1003`) then finds no head and creates a fresh document. The hosted forget lands through down-sync (`connector-client.ts:744`), and `share sync --yes` approves it. *Answered.* Decision 3 now refuses MCP forgets of a live project document and holds cloud forgets of a head with passes.
2. **Serious: the `memory_edit` rule allowed new passed lines, and a two-step malformed edit got past it.** *Answered.* The agent write rule compares a raw scan of passed lines before and after the write, refuses a malformed result, and `replacePlan` refuses a malformed base.
3. **Serious: "every write parses its own result" was false.** Executed: a title of "Files" on a document that already has Files is accepted and committed, and the next write fails. Without Files, a later files write lands under the title. *Answered.* The sentence is gone, and K1 fixes `owned()`, `setSection` and the in-transaction parse.
4. **Serious: claim 2 overstated the TTY gate.** `northkeep ui --no-open` prints a tokened URL (`packages/cli/src/index.ts:1352-1360`, `apps/web/src/server.ts:131`), and the web gate is only `isUnlocked()`. A pty also passes `isTTY`. *Answered.* Both claims are reworded, the owner entry point is described as organisation and not security, `pass` takes no environment bypass, and the entry point has its own `exports` entry.
5. **Serious: the cloud-apply rule sat at the wrong layer.** Line 833 is "take theirs", line 696 is a create with no base, and holding a create changes ADR 0050. *Answered.* There is now a `milestones_changed` reason in `planDownSync`, the empty base for creates, the ADR 0050 amendment, and both conflict choices for Jay with a dialog that names the passes.
6. **Build blocker: the `M0` placeholder failed the id pattern.** *Answered.* The placeholder is now `M1`.
7. **Build blocker: progress was on the wrong type.** *Answered.* It is on `ProjectOverview`, and `ProjectSummary` and the mirror are unchanged.
8. **Scar: devices on mixed versions.** *Answered.* The claims are scoped to K1 or later devices.

Notes also folded in: the hosted note repeats, accepted; the pass date comes from `saved_at`, in UTC; the fingerprint covers `milestone_passed` only; the three contract renders; the citation fixes (`project-board.ts:112`, `contract.ts:121`); the desktop restore row; the cap message wording.

**What found nothing:**
- Masking refuses project writes (`server.ts:492-495`).
- `instructions` is unset on both servers.
- The contract does not conflict.
- The librarian drops `project:` documents (`review.ts:121`).
- Hosted `memory_remember` refuses working rows in a project scope (`mcp.ts:339`).
- The local MCP server has no restore or import tool.
- Compaction blanks only superseded rows.
- Every other citation matched.
- Ids cannot be reused while passed lines carry over.

### First recheck, 2026-10-13: NOT CLEARED

A separate Claude agent rechecked the second draft against the code. It used Claude models only and installed nothing. Its attack script ran the real `parseProjectDoc` against the ADR's own definitions of `passedLines` and the milestone parser.

**Earlier findings.**
- Closed: 3, 4, 6, 7 and 8.
- Partly closed: 1 and 5. The new holes below reopen them.
- Not closed: 2.

**New findings, and how this draft answers them.**

- **N1. Fatal. Moving a passed line removed it, and the raw scan accepted the move.** Executed: moving `- [x] M1 … (you)` into Log, fencing it, or renaming the heading and appending a fresh section with M1 open all passed the rule, and the plan came back with M1 open. The premise was wrong. A text scan cannot tell where a line sits.
  *Answered.* The rule now compares parsed plans by id and bytes inside the single Milestones section. `passedLines` is gone.
- **N2. Serious. The scan refused normal checkpoints.** A checked task in Next Actions such as `- [x] Merge the PR` matched, and a CRLF re-save was refused. Both were executed.
  *Answered.* Lines outside Milestones are ignored, and parsing uses the same line-ending normalisation as the document parser.
- **N3. Serious, K4. A held cloud forget had no "keep mine" route.** Forgets are not content conflicts (`connector-client.ts:633-643`), and the connector has no route to cancel one.
  *Answered.* The hosted connector refuses project-document forgets at the source, so no forget conflict is needed. Forgets queued before K4 are a stated residual.
- **N4. Serious, K4. The conflict reason, the dialog and Shared marking were undecided.**
  *Answered.* `milestones_changed` wins over older reasons. Every conflict dialog lists pass changes. The check runs before `to_mark`, and "take theirs" on a held create marks Shared with a warning.
- **N5. Serious, K1. The vault had no single place where agent writes pass.**
  *Answered.* There is a required `actor` parameter on the project write methods, with a test pinning `server.ts`.

**Claim wording.** Claim 1 is split into a K1 version and a K4 version, and the K4 version allows for Jay's "take theirs". The phone row in Decision 3 is corrected.

**Stop-patching rule.** A fix round produced a fatal finding, so the skill hands the design decision back. N1's root cause was the premise (a raw text scan), not a missed case. This draft replaces that premise with the parsed comparison the recheck itself proposed, instead of adding cases to the scan. Jay is told this in the K0 report.

**What found nothing.**
- `* [x]`, `- [X]`, indentation and a lone `\r` all changed the scan or read as malformed.
- No contract, recipe or ADR has an agent forget a project document. Desktop delete uses `deleteProject`.
- MCP `memory_edit` has no scope parameter.
- `replaceProjectContent` and restore already parse inside their transaction.
- Hosted `project_create` counts rows waiting on a forget (`mcp.ts:767-786`).
- All other citations matched.

### Second recheck, 2026-10-13: CLEARED WITH WOUNDS

A separate Claude agent rechecked the third draft. It used Claude models only and installed nothing. It implemented the grammar and the agent write rule exactly as worded, on the real `parseProjectDoc`, and ran 27 attacks under two readings of the heading level. It also ran a copy of converse's `sanitizeCandidates`.

**Closed.**
- N1: moving, fencing, renaming and emptying the section are all refused.
- N2: a checked task in Next Actions and a CRLF re-save both pass.
- N3, N4 and the earlier findings 1, 3 to 8: closed in the specification.

**Wounds, both fixed in this text.**
- **W1. An agent could write a malformed section carrying a near-valid `(you)` line.** Executed: a trailing space or `(You)` was accepted. Jay's later repair would turn it into a real confirmation, and it contradicted the K1 acceptance item.
  *Fixed.* An agent write may not produce a malformed section, and K2's repair view highlights stamped lines.
- **W2. `remember` sat outside `actor`.** Converse distillation can commit a working row into a project scope with no guard, which can create a project document or make one unreadable.
  *Fixed.* `vault.remember` itself refuses new working rows in project scopes.

**Notes folded in.**
- The plan is the level-2 heading only.
- A duplicate id is malformed.
- Passes form a prefix, so a reordered history is malformed.
- `actor` goes in an options object.
- Down-sync's classification is stated.
- The librarian is relabelled `'owner'`.
- Two citations are corrected.

**What found nothing.**
- Moves, fences and renames after passes.
- A `### Milestones` duplicate.
- Passes to `none:`, and `none:` to a forged pass.
- Restamping an `(agent)` pass as `(you)`.
- Agent repair of an owner-made malformed section.
- Edits to other sections next to a malformed section.
- The checkpoint `(agent)` pass.
- Every other citation.

**No further round before build.** The fixes above tighten the rule and do not add a new mechanism. The K1 code gets its own adversarial review against this ADR before Jay's acceptance test, as the review gate requires for the published claims.
