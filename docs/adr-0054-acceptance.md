# ADR 0054 (M-D1) acceptance: the project board

Everything here runs on a throwaway vault under `/tmp/nk-0054-acceptance`. Nothing opens
`~/.northkeep`, nothing writes to your real call log, and no model or network call is made.
Step 1 reads a copy of the command repo's projects and deletes the copy. Steps 6 and 7 use a
small test client that plays the part of an AI app; it refuses to open any vault except the
throwaway one.

## Before you start

The branch `m-d1/build` is checked out in a separate worktree while it is being built, so git
will refuse to check it out a second time in your main checkout. Once that worktree is removed
(or the branch is merged), from the NorthKeep repository:

```bash
git -C ~/Claude/Projects/NorthKeep/northkeep checkout m-d1/build
```

```bash
pnpm --dir ~/Claude/Projects/NorthKeep/northkeep -r build
```

Then run each step from the repository folder. Each command is complete on its own.

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && bash scripts/adr-0054-acceptance.sh setup
```

Expected: `Vault created`, then `Created project demo` and `Created project other`.

## Steps

Run `bash scripts/adr-0054-acceptance.sh <step>` from the repository folder for each.

| Step | What it checks | Passing looks like |
|---|---|---|
| 1 | The board, default, over the imported command repo | the import reports its projects; then `Project board`, the `Done rule` line, and the five headings `Stale`, `Dated items`, `Open sessions`, `Drafts`, `Needs repair`; the Ollama process count is the same before and after |
| 2 | Size | `board --json bytes:` a figure under 131072; write it down |
| 3 | The stale window | `--stale-days 1` lists nearly every imported project, the shown rows marked `last log entry`; `--stale-days 3650` shows `Stale (0)` and `None.` |
| 4 | Zero writes | `vault unchanged:` followed by one hash |
| 5 | Dated items | two rows in date order: `2026-10-03  other` then `2026-10-15  demo  - 2026-10-15 renew the Dartmouth listing` |
| 6 | Open sessions | `before: 0`, then `after the read: 1` with a `demo  acceptance-app` row, then `after the MCP board: 1` (reading the board opened no session) |
| 7 | Drafts | `Drafts: 1 row(s) for drafty`, then `Drafts after the wrap: 0 row(s) for drafty` |
| 8 | Hostile text | the `hostile` row reads `Red [31mALERT[0m here` in your normal terminal colour, with `escape bytes in the row: 0` and `line separators in the row: 0` |
| 9 | Needs repair | `broken  unreadable`, and all five headings still print |
| 10 | Month dates | the `expected date:` line, then a Dated items row with that same date for `other  - <Mon> <D> file the renewal` |

Step 1 uses `~/Claude/Projects/Command Repo/projects` by default. To use a different folder of
`<slug>.md` files, put `NK_0054_SOURCE=/path/to/folder` in front of the command.

When done:

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && bash scripts/adr-0054-acceptance.sh clean
```

## Seeing the board on your real projects

The board only reads. Once you have accepted the steps above, `northkeep projects board` on your
own vault shows the same five sections, and `northkeep projects board --stale-days 30` widens the
window. From an AI app, ask it to call `project_board`.

## What was verified before this document was written

On 2026-09-23 the builder ran `setup` and steps 1 to 10 against this branch with a synthetic
three-project folder in place of the command repo (the real command repo was not read), and got
the results in the table: step 2 printed 1,571 bytes for that small vault, step 10 resolved
`Sep 20` to 2026-09-20. The command repo import in step 1, and its step 2 figure, are yours to
run.
