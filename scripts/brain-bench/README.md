# Brain bench

A scoring test for how well an AI app answers from NorthKeep. It asks 100 questions about a fictional person and compares designs, so a design can be judged by a number before it is built.

Everything here is invented. The bench builds its own throwaway vault and refuses any other.

## The designs

Each adds one thing to the one before, so a change in score has one cause.

1. **Today's search**: NorthKeep as shipped.
2. **Brief**: adds the facts the user confirmed, and the project names, to the connect-time instructions.
3. **Look-first**: adds one sentence telling the app to look in NorthKeep before answering.
4. **Cleanup**: adds the result of a one-time tidy of the memories, searched the usual way.
5. **Pages**: serves that same tidy result as one page per person, organization and property.
6. **Pages with index**: adds the list of page names to the instructions.

Steps 2 to 6 are prototypes in this folder. Nothing in the product changes. One more design, `look`, runs only when named: the connect-time text reworded to say look first.

## Run it

Build first (`pnpm build`) and sign in to the `claude` command. Each question is one new Claude Code session on your subscription.

```bash
node scripts/brain-bench/run.mjs --sample 1
```

That is 78 sessions. The full run is 600:

```bash
node scripts/brain-bench/run.mjs
```

It prints a report and saves it in an `out` folder here, with a transcript per question. Reports worth keeping are copied into `results`.

The options are listed at the top of `run.mjs`.

## How it scores

Two graders mark every answer against the key in `world.mjs`: plain text rules, and a second model that sees the key but not which design answered. The second grader's verdict is the score.

- **Correct**: the right fact. For a fact that is nowhere, or one marked disputed, the right answer is to say so.
- **Incomplete**: part of a two-part answer.
- **Said it did not know**: an answer existed and the agent did not find it.
- **Wrong**: anything else. This number matters most.

The report gives each score a likely range and says whether each step's change could be chance.

## Ranking rules

`replay.mjs` reruns the searches agents made in a finished run against a ranking rule, with no model usage. `ranking-cases.mjs` holds eight hard cases a rule must also pass.

## Where the cleanup comes from

`build-pages.mjs` hands every memory to a model and asks for pages. It never sees the questions. Rebuild `pages.generated.json` after changing the memories.

## What it does not tell you

- Reading only. Whether agents keep the record tidy as facts change is not measured yet.
- The agent is a bare chat app whose only tools are NorthKeep's. A real app looks in NorthKeep less often. `--app coding` is a step closer.
- Claude Code showed only the first 4,000 or so characters of a server's instructions. A longer brief would be cut off.
- One agent, one model, one fictional life, and wording one author chose.
