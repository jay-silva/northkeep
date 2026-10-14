# Milestones K2 acceptance: the Mac app

Run after K1 passes. It uses a throwaway vault in `/tmp/nk-k2`, not your real vault. Steps 1 to 8 need your Mac. Steps 6 to 8 are in [part 2](milestones-k2-acceptance-part2.md).

## 1. Build and make a test vault

```bash
cd ~/northkeep && pnpm install --frozen-lockfile && pnpm build
export NORTHKEEP_HOME=/tmp/nk-k2
NORTHKEEP_DEMO_PASSPHRASE='k2 test only' pnpm demo:seed
mkdir -p /tmp/nk-k2-import
printf '# K2 test project\n\n## Current Status\n\nTesting milestones in the app.\n\n## Milestones\n\n- [x] M1 Agree the plan | test: Jay approves the plan | passed 2026-10-01 (you)\n- [x] M2 Draft the outline | test: outline reviewed | passed 2026-10-05 (agent)\n- [ ] M3 Write the draft | test: draft reads well start to finish\n- [ ] M4 Publish | test: page is live\n' > /tmp/nk-k2-import/k2-test.md
printf '# K2 repair project\n\n## Current Status\n\nThis plan was edited by hand.\n\n## Milestones\n\n- [x] M1 Kickoff | test: plan agreed | passed 2026-10-01 (You)\n- [ ] M2 Draft | test: draft reviewed\n' > /tmp/nk-k2-import/k2-repair.md
pnpm northkeep projects import --from /tmp/nk-k2-import --write
pnpm northkeep ui
```

Passphrase: `k2 test only`. Keep this window open.

## 2. The Milestones block

Open **K2 test project**. Between the summary and "Decisions and open questions":

- "Milestones" and "2 of 4 passed".
- M1 with a solid check: "Passed Oct 1 · you confirmed".
- M2 with an outlined check: "agent says you confirmed", and a **Confirm** button.
- M3 marked as current, its test shown, and a **Mark passed** button.

## 3. Mark passed

Click **Mark passed** on M3. A box shows the test and asks "Did you run this test, and did it pass?" Tab stays inside it. **Not yet** changes nothing. Click **Mark passed** again, then **Yes, it passed**: M3 gets a solid check and "3 of 4 passed".

## 4. Confirm an agent pass

Click **Confirm** on M2, then **Yes, I confirm**: M2 gets a solid check and "you confirmed".

## 5. A stale page writes nothing

Leave the page open. In a second Terminal:

```bash
NORTHKEEP_HOME=/tmp/nk-k2 pnpm --dir ~/northkeep northkeep projects update k2-test --status "Saved from Terminal."
```

Without reloading, click **Mark passed** on M4, then **Yes, it passed**. Expect "Project changed after it was read. Nothing was marked passed." Click **Reload project**: the summary says "Saved from Terminal." and M4 is still open.

Keep the app open and continue with [part 2](milestones-k2-acceptance-part2.md).
