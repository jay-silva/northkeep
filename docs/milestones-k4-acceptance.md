# Milestone K4 acceptance: milestones through Cloud Connect

Run this only after K1, K2 and K3 pass on your Mac. Merging K4 to main deploys the Cloud Connect server, so you merge it yourself after Part 1 passes. Part 2, after the deploy, is in [part 2](milestones-k4-acceptance-part2.md).

## Part 1: on your Mac, before merging (about 5 minutes)

Nothing here touches your vault: the tests use throwaway folders and a stand-in server.

1. Get the K4 code and build it:

   ```
   cd ~/northkeep
   git fetch && git checkout claude/milestones-k4
   pnpm install --frozen-lockfile && pnpm build
   ```

2. Run the K4 tests:

   ```
   npx vitest run apps/connector-server/test/adr0065-milestones.test.ts packages/sync/test/adr0065-downsync.test.ts packages/cli/test/adr0065-share.test.ts apps/web/test/adr0065-conflict-ui.test.ts
   ```

   Expected last lines: `Test Files  4 passed (4)` and `Tests  30 passed (30)`.

   What they prove, in plain words:
   - Cloud Connect refuses to create a project without milestones, and refuses any milestone sent as already passed.
   - Cloud Connect keeps every passed milestone as it was, and refuses an AI app's attempt to change or remove one.
   - Cloud Connect refuses to forget a project document.
   - Cloud Connect refuses a heading that looks like Milestones, or a checkbox line with an `M<n>` id, anywhere outside the real Milestones section.
   - When a cloud version would add, change or remove a pass, your Mac holds it as "needs your decision" instead of applying it, and says which passes would change.
   - A new project from a connected app that arrives already showing a pass is held and stays private until you choose.

3. Run the K4 end-to-end test (about 1 minute). It starts a real Cloud Connect server on your Mac with throwaway storage, connects a stand-in AI app, and drives the real `northkeep` commands in a throwaway folder:

   ```
   npx vitest run --config e2e/vitest.config.ts e2e/milestones-k4.test.ts
   ```

   Expected last lines: `Test Files  1 passed (1)` and `Tests  6 passed (6)`.

   It runs Part 2's steps 2 to 4 with a stand-in for claude.ai: the cloud project arrives with nothing passed, the connector refuses to change, forge or forget after you pass M1, and an ordinary update still syncs with M1 confirmed by you. It cannot check step 1, whether claude.ai shows the instruction to its model.

If Part 1 passed, merge K4, wait for the deploy, then continue with [part 2](milestones-k4-acceptance-part2.md).
