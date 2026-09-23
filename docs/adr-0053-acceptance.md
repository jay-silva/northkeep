# ADR 0053 (M-A1) acceptance: the local git mirror and import

Everything here runs on a throwaway vault and mirror under `/tmp/nk-0053-acceptance`.
Nothing opens `~/.northkeep`, and nothing pushes. Step 7 reads a copy of the command
repo and deletes the copy.

## Before you start

From the NorthKeep repository, on the branch, with a fresh build:

```bash
git -C ~/Claude/Projects/NorthKeep/northkeep checkout m-a1/finish
```

```bash
pnpm --dir ~/Claude/Projects/NorthKeep/northkeep -r build
```

Then run each step below from the repository folder. Each command is complete on its
own, so a fresh terminal per step is fine.

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && bash scripts/adr-0053-acceptance.sh setup
```

Expected: `Vault created`, then `Created project demo` and `Created project other`.

## Steps

Run `bash scripts/adr-0053-acceptance.sh <step>` from the repository folder for each.

| Step | What it checks | Passing looks like |
|---|---|---|
| 1 | First export into an empty git folder | `Wrote .northkeep-mirror`, the two projects and `INDEX.md`, `Committed <id>.`, `exit 0`, `commits: 1`; the second folder that already has a file is refused with `non-empty folder exit 1` |
| 2 | A second export with no vault change | `No changes; nothing to commit.`, `diff silent`, `commits: 1`, empty git status |
| 3 | Verify | four lines ending `matches`, `All 4 paths match.`, `exit 0` |
| 4 | A hand edit in the mirror | verify shows `projects/demo.md: hand edit` and `verify exit 1`; the export writes `other`, refuses `demo.md` by name, and the edit (`note`) is still in the file |
| 5 | Status after a vault write | `1 project changed since`, `Projects changed since: other`, `NorthKeep never pushes`; the export then commits |
| 6 | The canary (no configured program runs) | `canaries fired: (none)` above, controls listed, `result M-A1: PASS` |
| 7 | Import dry run on a copy of the command repo | `30 files would be imported ... 1 skipped`, largest row under 60,000 bytes, total under the 4 MB sync limit, `source files unchanged by the import` |
| 8 | A remote is never pushed | the export commits, status names the remote, `commits in the remote: 0` |
| 9 | A write killed mid-way heals | `crashed export exit 137` and one `demo.md.northkeep-tmp-...` file; the next export removes it, commits, and `All 4 paths match.` |
| 10 | Deleting a project removes its mirror file | `Deleted project gone`, then `Removed projects/gone.md` in the next commit |

When done:

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && bash scripts/adr-0053-acceptance.sh clean
```

## Optional: the schedule

`northkeep projects export --schedule hourly` installs a real macOS background job
(launchd) that runs the export for your default vault, `~/.northkeep`, not the
throwaway one above. Try it only when you want the real mirror running; `--schedule
off` removes it. It needs a stored key (`northkeep unlock`); with the vault locked it
records `vault_locked`, which `--status` shows.

## What was verified before this document was written

The lead ran every step above on 2026-09-23 against this branch with the results in the
table, and checked the Projects page line in the browser: dark and light, 375 px wide,
12 px text, contrast 5.10:1 in light mode, no horizontal scroll.
