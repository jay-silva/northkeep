# K4 acceptance: verification record (moved verbatim from docs/milestones-k4-acceptance.md)

## What was verified before this reached you

Claude ran these in a cloud container on 2026-10-14, on branch `claude/milestones-k4` rebased onto K3, which sits on K2 and the final K1 (4fe0c29), with throwaway folders only:

- Part 1 step 1: `pnpm install --frozen-lockfile` and `pnpm build` succeeded.
- Part 1 step 2: 4 files, 30 tests passed.
- Part 1 step 3: 6 tests passed, standalone and inside the full `pnpm test:e2e` (27 files, 161 tests passed).
- The full `npx vitest run`: 2854 passed, 10 failed. Nine are the known failures that happen only when tests run as root, as they do in the container; eight of them check that a file NorthKeep cannot read is reported, and root can read any file. The tenth needs to look up example.com, which the container cannot. None of them is in code K4 changes.

Part 2 was run by Jay on 2026-10-14 after K4 deployed. Steps 1 to 4 all passed: claude.ai proposed milestones and waited before creating the project, the plan showed on his Mac with nothing passed after he updated his CLI, and the connector refused the pass and the forget. Step 1 cannot separate the standing instructions from the `project_create` description, which also asks for an agreed plan; KNOWN-LIMITS says so.
