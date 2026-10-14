# K2 acceptance: verification record (moved verbatim from docs/milestones-k2-acceptance.md)

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

After the K2 code review fixes, on 2026-10-14, steps 1 to 7 were run again the same way on a
fresh temporary `NORTHKEEP_HOME`, with the new step 6 and step 7 text. Every check passed. The
run also held a Mark passed save open and pressed Tab five times (focus stayed in the box) and
Escape (the box closed and the page worked again), and sent a repair save with a changed M1
line straight to the app server (refused). `restore-warning-1280.png` was retaken and
`restore-adds-1280.png` added.

On 2026-10-14, after K2 was rebased again onto the final K1 (4fe0c29), steps 1 to 7 were run
once more the same way on a fresh temporary `NORTHKEEP_HOME`, with the same checks. All 22
checks passed and the page reported no script errors. The screenshots were not retaken.

Not verified here, so it needs your Mac: that `northkeep ui` opens Safari or your default
browser by itself, how the app looks in your browser with your fonts, and that keyboard
Tab behaves the same with a real keyboard.
