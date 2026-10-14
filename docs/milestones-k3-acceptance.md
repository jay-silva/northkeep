# ADR 0065 (K3) acceptance: milestones on the phone

The phone shows each project's milestones and never changes them. This branch sits on K2
(the Mac app), which sits on finished K1 (4fe0c29).

## Step 1: the automatic checks

In the repository, on branch `claude/milestones-k3`:

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm vitest run apps/mobile/test/project-milestones.test.ts
```

Passing: `7 passed`. These check, in a throwaway vault, what the phone would show, and that
the project screens contain no code that writes to the vault.

## Step 2: put the new app on your phone

Build and install the phone app from this branch as you usually do for TestFlight. The build
is billed and needs your Apple account, so it is yours to start.

## Step 3: a project with three milestones

On your Mac, in a new Claude Code session, type:

`Create a NorthKeep project called k3-phone-check with three milestones: M1 Buy seeds (test: seeds in hand), M2 Plant (test: seeds in the ground), M3 First harvest (test: one tomato picked). I agree to this plan.`

Then in Terminal:

```bash
northkeep projects pass k3-phone-check M1
```

Type `yes` when asked. Passing: `Confirmed M1 Buy seeds passed on <today>`.

## Step 4: look on the phone

On the phone, open NorthKeep, go to Memories, pull down to sync, then open Projects.

Passing on the list:
- k3-phone-check reads `1 of 3 · M2 Plant`, with a bar: one segment filled, one half filled,
  one empty;
- a project with no milestones reads `No plan yet` in grey;
- `Needs attention` does not count projects just for having no plan.

Tap k3-phone-check. Passing on the page:
- a top box reads `1 of 3 passed` and `Now on M2`;
- under Milestones, M1 has a filled green check and `Passed <month day> · you confirmed`;
- M2 is highlighted and shows `Test: seeds in the ground`;
- M3 shows only its title;
- nothing lets you tick, edit or remove a milestone.

## Step 5 (optional): a pass the agent recorded

Tell Claude Code: `I planted the seeds, M2 passed. Record it.` Sync the phone again. M2 now
has an outlined check and `agent says you confirmed`, and the list reads `2 of 3 · M3 First
harvest`.

## Clean up

```bash
northkeep projects delete k3-phone-check
```

Type `yes` when asked. Passing: `Deleted project k3-phone-check`.

## Needs you

The builder ran steps 1 and 3 to 5 on Linux, a test client standing in for Claude Code; all
matched. Only you can run step 2 (billed, your Apple account), step 3 live on your Mac, and step
4 on the phone: sync, how the screens look (green check, outlined check, highlight, bar) and that
nothing can be tapped to change a milestone. No screenshot: nothing here draws phone screens off
a device. Full record: [verification record](evidence/project-milestones-k3/verification.md).
