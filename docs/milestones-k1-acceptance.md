# ADR 0065 (K1) acceptance: project milestones

Steps 1 to 7 use a throwaway vault under `/tmp/nk-k1-acceptance`, never `~/.northkeep`. A
test client plays the AI app. Step 8 is one live Claude Code check.

## Before you start

In the NorthKeep repository, on branch `claude/milestones-k1`:

```bash
pnpm -r build
```

```bash
bash scripts/milestones-k1-acceptance.sh setup
```

Expected: `Vault created`.

## Steps

Run `bash scripts/milestones-k1-acceptance.sh <step>` for each.

| Step | What it checks | Passing looks like |
|---|---|---|
| 1 | Terminal projects still work; a section name is not a title | `Created project plain`, then `Project title cannot be the name of a document section.` |
| 2 | An AI app must bring milestones | `refused  create without milestones: milestones is required...`, then `Created project rental with 2 milestones.` and the plan, `0 of 2` |
| 3 | An AI app reports a pass; a checkpoint with checked Next Actions saves | `Checkpoint saved.` with `- [x] Call the lender` in Next Actions, and `M1 passed, stamped (agent)`; the plan shows M1 `not confirmed by you` |
| 4 | Every AI app route to change a pass | twelve lines that each start `refused`, then `document unchanged: yes`. No line starts `ACCEPTED` |
| 5 | A chat turn cannot create a project document | `refused: A working memory in a project collection is the project document...` |
| 6 | Confirming needs you at a terminal | `This command asks you to type yes...`, then `unknown option '--yes'`, then M1 still `not confirmed by you` |

Step 4 includes the first half of the two-step route. Step 5 makes the vault call a chat
turn uses.

## Step 7: confirm a milestone yourself

```bash
bash scripts/milestones-k1-acceptance.sh 7
```

Type `yes` and press Enter when asked. Expected:
`Confirmed M1 Define the buy box passed on <today>`, then
`M1 Define the buy box  (passed <today>, confirmed by you)`. Then clean up:

```bash
bash scripts/milestones-k1-acceptance.sh clean
```

## Step 8: one live Claude Code session

This uses your real setup, which must run this build. Quit Claude Code, then:

```bash
node packages/cli/dist/index.js contract install claude
```

Open a new Claude Code session and type only: `Create a NorthKeep project called k1-garden for
planning a vegetable garden.` Do not mention milestones.

Passing: Claude proposes milestones, each with a test, and waits for your agreement before
creating the project. Tell me whether it did; KNOWN-LIMITS records the answer. Afterwards:

```bash
node packages/cli/dist/index.js projects delete k1-garden
```

## What was verified before this document was written

On 2026-10-14 the builder ran steps 1 to 7 on a Linux test machine and got the results
above (step 7 under a pseudo terminal). Step 8 ran in Claude Code from the command line against a throwaway vault and this build's server: in 3 of 3 fresh sessions it proposed milestones with tests and created the project only after agreement.
