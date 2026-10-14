# K3 acceptance: verification record (moved verbatim from docs/milestones-k3-acceptance.md)

## What was verified before this document was written

On 2026-10-14, after rebasing onto K1, the builder ran these on a Linux test machine:

- Step 1: 7 passed; the whole phone test set passed (324 tests); the phone app typechecks.
- Steps 3 to 5 and clean-up, against a throwaway vault under `/tmp` (never `~/.northkeep`). A
  test client played Claude Code over NorthKeep's real MCP server: it created k3-phone-check
  with the three milestones, and in step 5 recorded M2 with a checkpoint. `northkeep projects
  pass k3-phone-check M1` ran under a pseudo terminal with `yes` typed, and printed
  `Confirmed M1 Buy seeds passed on 2026-10-14`. Then the phone's own data code (the code the
  Projects list and project page draw from) read the vault's rows and gave, for step 4:
  list `1 of 3 · M2 Plant` with a 1-of-3 bar and a current segment; a project without a plan
  `No plan yet`; Needs attention empty; page `1 of 3 passed`, `Now on M2`, M1
  `Passed Oct 14 · you confirmed`, M2 current with `Test: seeds in the ground`, M3 title only.
  After step 5: list `2 of 3 · M3 First harvest`, M2 `Passed Oct 14 · agent says you
  confirmed`. Clean-up deleted the project's 3 entries.

On 2026-10-14, after K3 was rebased onto K2, the builder ran step 1 and steps 3 to 5 and
clean-up again the same way, on a fresh throwaway vault under `/tmp`. Step 1: 7 passed, and the
whole phone test set passed (324 tests). Every list and page result above matched, and
clean-up again deleted 3 entries.

Not run, and needing you: step 2 (the TestFlight build is billed and needs your Apple
account); step 3's live Claude Code session (the test client stood in for it); and step 4 on
the phone itself: sync between Mac and phone, how the screens look (the green check, the
outlined check, the highlight, the bar) and that nothing on the page can be tapped to change a
milestone. A test checks that the project screens contain no vault write, but only the device
shows what is drawn. No screenshot is attached: nothing in this repository draws the phone
screens outside a real device.
