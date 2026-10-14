# Milestone K4 acceptance, part 2: claude.ai

Run this after [part 1](milestones-k4-acceptance.md) passed, you merged K4 and the deploy finished.

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

Tell Claude which steps passed. If step 1 did not propose milestones, that is not a K4 failure: claude.ai does not show NorthKeep's standing instructions to its model, and KNOWN-LIMITS will say so.

## Needs you

Claude ran all of Part 1 in a cloud container; it passed. None of Part 2 was run: it needs the
deployed connector and your claude.ai account. Step 1 is the only check of whether claude.ai
shows NorthKeep's instruction to its model, and KNOWN-LIMITS keeps claude.ai under "Not
verified" until you report it. Full record:
[verification record](evidence/project-milestones-k4/verification.md).
