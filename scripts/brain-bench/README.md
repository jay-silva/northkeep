# Brain bench

A scoring test for how well an AI app answers from NorthKeep. It asks 100 questions about a fictional person, Morgan Vale, and compares designs, so a design can be judged by a number before it is built into the product.

Everything here is invented. The bench never opens a real vault: it builds its own throwaway one, and its server refuses any folder the bench did not create.

## The designs

They form a ladder. Each adds one thing to the one before, so a change in score has one cause.

1. **Today's search**: NorthKeep as shipped.
2. **Brief**: adds the facts the user confirmed, and the project names, to the connect-time instructions.
3. **Look-first**: adds one sentence telling the app to look in NorthKeep before answering.
4. **Cleanup**: adds the result of a one-time tidy of the memories, searched the usual way.
5. **Pages**: serves that same tidy result as one page per person, organization and property.
6. **Pages with index**: adds the list of page names to the instructions.

Steps 2 to 6 are prototypes that live only in this folder. Nothing in the product changes.

## Run it

Build first (`pnpm build`), and have the `claude` command signed in. Each question is one new Claude Code session on your Claude subscription.

```bash
node scripts/brain-bench/run.mjs --sample 1
```

That asks one question of each kind: 78 sessions, a few minutes. The full run is 600 sessions:

```bash
node scripts/brain-bench/run.mjs
```

It prints a report and saves it under `scripts/brain-bench/out/`, with one transcript per question: the question, the answer, every lookup, and the verdict.

Options: `--arms search,brief`, `--only stale,changed`, `--model opus`, `--repeats 3`, `--concurrency 6`, `--app coding`, `--search meaning`, `--out <folder>` to continue a stopped run.

## How it scores

Two graders mark every answer against the key in `world.mjs`: plain text rules, and a second model that sees the key but not which design answered. The second grader's verdict is the score. Every answer the two marked differently is listed in the report for a person to check.

- **Correct**: the right fact. For a fact that is nowhere, the right answer is to say so. For a disputed fact, the right answer is to say it is disputed.
- **Incomplete**: part of a two-part answer.
- **Said it did not know**: an answer existed and the agent did not find it.
- **Wrong**: anything else. This number matters most.

The report gives each score a likely range and says, for each step of the ladder, whether the change could be chance.

## Where the cleanup comes from

`build-pages.mjs` hands the whole pile of memories to a model, with rules for which record wins, and asks for pages. It never sees the questions. The result is saved in `pages.generated.json`. Run it again after changing the memories in `world.mjs`.

## What it does not tell you

- Reading only. Whether agents keep the record tidy as facts change is not measured yet.
- The agent is a bare chat app whose only tools are NorthKeep's. A real app with more tools and memory of its own looks in NorthKeep less often. `--app coding` is a step closer.
- Claude Code showed only the first 4,000 or so characters of a server's instructions (measured 2026-11-23). A longer brief would be cut off.
- Search runs by words, as it does with no local model.
- One agent, one model, one fictional life, and wording one author chose.
