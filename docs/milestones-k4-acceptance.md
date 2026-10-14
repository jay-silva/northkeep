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

   Expected last lines: `Test Files  4 passed (4)` and `Tests  23 passed (23)`.

   What they prove, in plain words:
   - Cloud Connect refuses to create a project without milestones, and refuses any milestone sent as already passed.
   - Cloud Connect keeps every passed milestone exactly as it was, and refuses an AI app's attempt to change or remove one.
   - Cloud Connect refuses to forget a project document.
   - When a cloud version would add, change or remove a pass, your Mac holds it as "needs your decision" instead of applying it, and says which passes would change.
   - A new project from a connected app that arrives already showing a pass is held and stays private until you choose.

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
