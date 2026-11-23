# Brain bench

A scoring test for how well an AI app answers questions from NorthKeep. It asks 100 questions about a fictional person, Morgan Vale, and compares three designs. It exists so a design can be judged by a number before it is built into the product.

Everything here is invented. The bench never opens a real vault: it builds its own throwaway one, and its server refuses any folder the bench did not create.

## The three designs

- **Today's search** is NorthKeep as shipped: the real server and the real connect-time instructions.
- **Search plus brief** adds the facts the user confirmed, and the project names, to those instructions.
- **Pages plus brief** also adds one page per person, organization, property and pet, with two tools to read them.

The brief and the pages are prototypes that live only in this folder. Nothing in the product changes.

## Run it

Build first (`pnpm build`), and have the `claude` command signed in. Each question is one new Claude Code session on your Claude subscription.

```bash
node scripts/brain-bench/run.mjs --sample 1
```

That asks one question of each kind, 39 sessions, in about two minutes. The full run is 300 sessions:

```bash
node scripts/brain-bench/run.mjs
```

It prints a one-page report and saves it, with one transcript per question, under `scripts/brain-bench/out/`. Each transcript shows the question, the answer, every lookup the agent made, and the verdict.

Other options: `--arms search,brief`, `--only stale,changed` (kinds or question ids), `--model opus`, `--concurrency 6`, `--out <folder>` to continue a run that stopped.

## How it scores

Each question has an answer key in `world.mjs`. An answer is graded by plain text rules, not by a model:

- **Correct**: it gives the right fact. For a fact that is nowhere, the right answer is to say so. For a fact the record marks as disputed, the right answer is to say it is disputed.
- **Incomplete**: part of a two-part answer.
- **Said it did not know**: an answer existed and the agent did not find it.
- **Wrong**: anything else. This is the number that matters most.

The report also shows whether the agent looked in NorthKeep at all, and whether a wrong answer repeated an out-of-date value.

## Where the pages come from

`build-pages.mjs` hands the whole pile of memories to an agent and asks it to write the pages, with rules for which record wins. It never sees the questions. The result is saved in `pages.generated.json` so every run uses the same pages. Run it again after changing the memories in `world.mjs`.

## What it does not tell you

- It tests reading only. Whether agents keep pages tidy as new facts arrive is not measured yet.
- The agent is Claude Code with no other tools and a short list of its own notes. A real app with more of its own memory will look in NorthKeep less often than this one does.
- Claude Code showed only the first 4,000 or so characters of a server's instructions (measured 2026-11-23). The brief here fits. A bigger one would be cut off.
- Search runs by words, as it does with no local model. Add `--search meaning` to use the local search model.
- One agent and one fictional person. Other apps and other lives may score differently.
- The pages were written by one model in one pass, from a tidy list. A real vault is larger and messier.
