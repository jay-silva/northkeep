# Milestone K4 acceptance: milestones through Cloud Connect

Run this only after K1, K2 and K3 have passed on your Mac. Merging K4 to main deploys the Cloud Connect server, so you merge it yourself after Part 1 passes.

## Part 1: on your Mac, before merging (about 5 minutes)

Nothing here touches your vault. The tests use throwaway folders and a stand-in server.

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
   - Cloud Connect keeps every passed milestone exactly as it was, and refuses an AI app's attempt to change or remove one.
   - Cloud Connect refuses to forget a project document.
   - Cloud Connect refuses a heading that looks like Milestones, or a checkbox line with an `M<n>` id, anywhere outside the real Milestones section.
   - When a cloud version would add, change or remove a pass, your Mac holds it as "needs your decision" instead of applying it, and says which passes would change.
   - A new project from a connected app that arrives already showing a pass is held and stays private until you choose.

3. Run the K4 end-to-end test. It starts a real Cloud Connect server on your Mac with throwaway storage, connects a stand-in AI app to it, and drives the real `northkeep` commands in a throwaway folder (about 1 minute):

   ```
   npx vitest run --config e2e/vitest.config.ts e2e/milestones-k4.test.ts
   ```

   Expected last lines: `Test Files  1 passed (1)` and `Tests  6 passed (6)`.

   It runs Part 2's steps 2 to 4 with a stand-in app in place of claude.ai: the cloud project arrives with nothing passed, the connector refuses to change, forge or forget after you pass M1, and an ordinary update still syncs with M1 confirmed by you. It cannot check step 1, whether claude.ai shows the instruction to its model.

## Part 2: after you merge and the deploy finishes (about 10 minutes)

Use claude.ai with the NorthKeep connector, on a test project you can delete afterwards.

1. In a new claude.ai chat, type: `Create a NorthKeep project called k4-test for planning a garden.`
   Pass if Claude proposes milestones and waits for you to agree before creating it. Write down whether it did: this is the "Verified hosts" line in KNOWN-LIMITS.

2. Agree to the milestones. Then on your Mac:

   ```
   northkeep share sync
   northkeep projects milestones k4-test
   ```

   Pass if the plan shows with nothing passed.

3. Back in claude.ai, type: `Mark M1 of k4-test as passed in NorthKeep by updating the milestones.`
   Pass if Claude reports that NorthKeep refused it.

4. Type: `Forget the k4-test project document in NorthKeep.`
   Pass if Claude reports that NorthKeep refused it.

5. Clean up on your Mac: `northkeep projects delete k4-test` (or delete it in the app).

Tell Claude which steps passed. If step 1 did not propose milestones, that is not a K4 failure; it means claude.ai does not show NorthKeep's standing instructions to its model, and KNOWN-LIMITS will say so.

## What was verified before this reached you

Claude ran these in a cloud container on 2026-10-14, on branch `claude/milestones-k4` rebased onto K3, which sits on K2 and the final K1 (4fe0c29), with throwaway folders only:

- Part 1 step 1: `pnpm install --frozen-lockfile` and `pnpm build` succeeded.
- Part 1 step 2: 4 files, 30 tests passed.
- Part 1 step 3: 6 tests passed, standalone and inside the full `pnpm test:e2e` (27 files, 161 tests passed).
- The full `npx vitest run`: 2854 passed, 10 failed. Nine are the known failures that happen only when tests run as root, as they do in the container; eight of them check that a file NorthKeep cannot read is reported, and root can read any file. The tenth needs to look up example.com, which the container cannot. None of them is in code K4 changes.

Not run, because it needs the deployed connector and your claude.ai account: all of Part 2. Step 1 is the only check of whether claude.ai shows NorthKeep's instruction to its model, and KNOWN-LIMITS keeps claude.ai under "Not verified" until you report it.
