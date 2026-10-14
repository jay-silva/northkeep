# ADR 0065 (K3) acceptance: milestones on the phone

The phone shows each project's milestones. It never changes them. Run this only after you have
said K1 passed and the K3 branch has been rebased onto it.

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

## What was verified before this document was written

On 2026-10-14 the builder ran step 1 on a Linux test machine: 7 passed, and the whole phone test
set passed (324 tests). Steps 2 to 5 need your phone and were not run. There is no way in this
repository to draw the phone screens outside a real device, so no screenshot is attached.
