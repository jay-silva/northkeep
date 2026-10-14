# ADR 0065 (K3) acceptance: milestones on the phone

The phone shows each project's milestones. It never changes them. This branch is built on
finished K1 (e749593).

## Step 1: the automatic checks

In the NorthKeep repository, on branch `claude/milestones-k3`:

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm vitest run apps/mobile/test/project-milestones.test.ts
```

Passing: `7 passed`. These build projects in a throwaway vault and check what the phone would
show, including that the project screens contain no code that writes to the vault.

## Step 2: put the new app on your phone

Build and install the phone app from this branch the way you usually do for TestFlight. That
build is billed, so it is yours to start.

## Step 3: a project with three milestones

On your Mac, open a new Claude Code session and type:

`Create a NorthKeep project called k3-phone-check with three milestones: M1 Buy seeds (test: seeds in hand), M2 Plant (test: seeds in the ground), M3 First harvest (test: one tomato picked). I agree to this plan.`

Then, in Terminal:

```bash
northkeep projects pass k3-phone-check M1
```

Type `yes` when asked. Passing: `Confirmed M1 Buy seeds passed on <today>`.

## Step 4: look on the phone

Open NorthKeep on the phone, go to Memories and pull down to sync. Then open Projects.

Passing on the list:
- the k3-phone-check row reads `1 of 3 · M2 Plant`, with a short bar: one filled segment,
  one half filled, one empty;
- a project that has no milestones reads `No plan yet` in grey;
- `Needs attention` does not count projects only because they have no plan.

Tap k3-phone-check. Passing on the project page:
- a box at the top reads `1 of 3 passed` and `Now on M2`;
- under Milestones, M1 has a filled green check and `Passed <month day> · you confirmed`;
- M2 is highlighted and shows `Test: seeds in the ground`;
- M3 shows only its title;
- nothing on the page lets you tick, edit or remove a milestone.

## Step 5 (optional): a pass the agent recorded

Tell Claude Code: `I planted the seeds, M2 passed. Record it.` Sync the phone again. M2 now
has an outlined check and `agent says you confirmed`, and the list reads `2 of 3 · M3 First
harvest`.

## Clean up

```bash
northkeep projects delete k3-phone-check
```

Type `yes` when asked. Passing: `Deleted project k3-phone-check`.

## What was verified before this document was written

On 2026-10-14, after rebasing onto K1, the builder ran these on a Linux test machine:

- Step 1: 7 passed; the whole phone test set passed (324 tests); the phone app typechecks.
- Steps 3 to 5 and clean-up, against a throwaway vault under `/tmp` (never `~/.northkeep`). A
  test client played Claude Code over NorthKeep's real MCP server: it created k3-phone-check
  with the three milestones, and in step 5 recorded M2 with a checkpoint. `northkeep projects
  pass k3-phone-check M1` ran under a pseudo terminal with `yes` typed, and printed
  `Confirmed M1 Buy seeds passed on 2026-10-14`. Then the phone's own data code (the code the
  Projects list and project page draw from) read the vault's rows and gave, for step 4:
  list `1 of 3 · M2 Plant` with a 1-of-3 bar and a current segment; a project without a plan
  `No plan yet`; Needs attention empty; page `1 of 3 passed`, `Now on M2`, M1
  `Passed Oct 14 · you confirmed`, M2 current with `Test: seeds in the ground`, M3 title only.
  After step 5: list `2 of 3 · M3 First harvest`, M2 `Passed Oct 14 · agent says you
  confirmed`. Clean-up deleted the project's 3 entries.

Not run, and needing you: step 2 (the TestFlight build is billed and needs your Apple
account); step 3's live Claude Code session (the test client stood in for it); and step 4 on
the phone itself: sync between Mac and phone, how the screens look (the green check, the
outlined check, the highlight, the bar) and that nothing on the page can be tapped to change a
milestone. A test checks that the project screens contain no vault write, but only the device
shows what is drawn. No screenshot is attached: nothing in this repository draws the phone
screens outside a real device.
