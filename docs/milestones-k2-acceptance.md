# Milestones K2 acceptance: the Mac app

Run this after K1 passed. It uses a throwaway vault in `/tmp/nk-k2`; your real vault is not touched.

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

The passphrase is `k2 test only`. Keep this window open.

## 2. The Milestones block

Open **K2 test project**. Between the summary and "Decisions and open questions" you should see:

- "Milestones" and "2 of 4 passed".
- M1 with a solid check: "Passed Oct 1 · you confirmed".
- M2 with an outlined check: "agent says you confirmed", and a **Confirm** button.
- M3 marked as current, its test shown, and a **Mark passed** button.

## 3. Mark passed

Click **Mark passed** on M3. A box asks "Did you run this test, and did it pass?" and shows the test. Tab stays inside the box. Click **Not yet**: nothing changes. Click **Mark passed** again, then **Yes, it passed**. M3 now has a solid check and the count reads "3 of 4 passed".

## 4. Confirm an agent pass

Click **Confirm** on M2, then **Yes, I confirm**. M2 now has a solid check and "you confirmed".

## 5. A stale page writes nothing

Leave the page open. In a second Terminal window:

```bash
NORTHKEEP_HOME=/tmp/nk-k2 pnpm --dir ~/northkeep northkeep projects update k2-test --status "Saved from Terminal."
```

Back in the app, without reloading, click **Mark passed** on M4, then **Yes, it passed**. You should see "Project changed after it was read. Nothing was marked passed." Click **Reload project**: the summary now says "Saved from Terminal." and M4 is still open.

## 6. Restore warning

Open **Session history**, then **Restore this version** on the oldest version. The box says "This undoes 2 passed milestones" and names M2 and M3. Click **Cancel**.

## 7. Repair

Open **K2 repair project**. The block says NorthKeep cannot read the section. Click **Repair milestones**. The M1 line is highlighted as "Says passed". Change `(You)` to `(you)` and click **Check milestones**. It lists M1 as counting as passed. Click **Save repair**: the block reads "1 of 2 passed".

## 8. Clean up

Stop the app with Ctrl+C, then:

```bash
rm -rf /tmp/nk-k2 /tmp/nk-k2-import
```

Tell Claude which steps passed and paste anything that looked wrong.

## What was verified before this document was written

On 2026-10-14, after K2 was rebased onto the finished K1, the builder ran step 1 exactly as
written on a Linux test machine (with the passphrase supplied from the environment for the
import), then started `northkeep ui --no-open` and drove steps 2 to 7 in a headless Chromium
browser, checking for the text each step names. Step 5 used the Terminal command above.
Every check passed: "2 of 4 passed", Tab stayed in the box, "Not yet" changed nothing,
"3 of 4 passed" after Mark passed, M2 "you confirmed" after Confirm, the stale refusal and
"Saved from Terminal." after reload with M4 still open, "This undoes 2 passed milestones"
naming M2 and M3, and "1 of 2 passed" after the repair. The page reported no script errors.
Screenshots at 390 px (light and dark, no sideways scroll) and 1280 px are in
`docs/evidence/project-milestones-k2/`.

Not verified here, so it needs your Mac: that `northkeep ui` opens Safari or your default
browser by itself, how the app looks in your browser with your fonts, and that keyboard
Tab behaves the same with a real keyboard.
