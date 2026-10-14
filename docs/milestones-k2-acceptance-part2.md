# Milestones K2 acceptance, part 2

Continue from [part 1](milestones-k2-acceptance.md) in the same app window, after step 5.

## 6. Restore warning

Open **Session history**, then **Restore this version** on the oldest version. The box says "This restore changes your milestones." Under "Changes 1 passed milestone": M2, now passed today, you confirmed; after the restore passed Oct 5, agent says you confirmed. Under "Undoes 1 passed milestone": M3. Click **Cancel**.

## 7. Repair

Open **K2 repair project**. The block says NorthKeep cannot read the section. Click **Repair milestones**: the M1 line is highlighted "Says passed". Change `(You)` to `(you)`, click **Check milestones**: M1 counts as passed. Click **Save repair**: "1 of 2 passed".

Open **Session history**, then **Restore this version** on the older version. The box says it undoes M1 Kickoff and NorthKeep cannot read the Milestones section in that version. Click **Cancel**.

## 8. Clean up

Stop the app with Ctrl+C, then:

```bash
rm -rf /tmp/nk-k2 /tmp/nk-k2-import
```

Tell Claude which steps passed; paste anything that looked wrong.

## Needs your Mac

The builder ran steps 1 to 7 headless on Linux; all checks passed. Only your Mac can show that `northkeep ui` opens Safari or your default browser by itself, how the app looks with your fonts, and that Tab behaves the same on a real keyboard. The full record is in [the verification record](evidence/project-milestones-k2/verification.md).
