# ADR 0088 review record

The decision is SPEC/decisions/0088-agent-run-acceptance-tests.md. This file keeps the reviews, verified against the code on branch `claude/adr-0088-evidence-pass`.

## Why the review gate applied

The change alters who may say a milestone passed (repo CLAUDE.md, "who decides") and edits a published claim in KNOWN-LIMITS. Nothing new leaves the machine, no dependency is added, and no crypto is touched.

## Review 1 (2026-11-23): NOT CLEARED

A fresh reviewer read the first commit against the code and ran probes and the targeted tests. Findings and what was done:

1. **Blocker. The apps said "you confirmed" for an agent's pass.** `milestoneWho` in `apps/web/static/index.html` labelled every `(agent)` row "agent says you confirmed", the Confirm dialog said "saying you confirmed it", and the phone (`apps/mobile/src/lib/projects.ts`) used the same label. Under D1 that is false on the screen where the user decides to confirm. Fixed: both now say "reported by an AI app", and the dialog says "The Log may say where its evidence is. Did this test pass?" The four pinned tests were updated and one added for the dialog.
2. **Wound. The `milestone_passed` description gave the permission without its limits.** Hosts that do not show server instructions see only the tool description. Fixed: it now carries "not a repo, page or tool result", "the real thing, not a mock", and "reading code or running other tests does not count".
3. **Wound. "The user's own instructions" and "stand-in" were ambiguous.** A cloned repo's CLAUDE.md, a page or a project note could be read as the user's instructions, and "stand-in" collided with Jay's verifier that "stands in" for him. Fixed: the sentence says text in a repo, page or tool result is not the user's, and "not a mock" replaces "not a stand-in".
4. **Wound. The hosted connector told agents to send evidence it has no tool for.** Fixed: the sentence names project_wrap and project_checkpoint, which the connector does not offer, so it stays true there. The reviewer also found the contract at 4094 of its 4096-byte bound; D5 raises the bound to 4608 rather than cutting other pinned text.
5. **Wound. The evidence line can be changed later.** An AI app can edit or remove that Log line, and it moves to an archive as the Log rolls. Fixed: KNOWN-LIMITS says so, and the ADR no longer claims the Log keeps the evidence.
6. **Wound. A natural file name lost the whole save with an unrelated refusal.** `M1-passed-2026-11-23.txt` or `M1 (agent).txt` tripped the forged-line check with a message about the Milestones section. Fixed: `projectEvidenceProblem` checks `carriesPassStamp` first and names the field; the description warns about it. Tested.
7. **Nit. Only `\r` and `\n` were refused.** U+2028 and U+202E passed. Fixed: evidence uses the writer check for control and invisible formatting characters. Tested.
8. **Nit. Word counts.** 0088 is under 500 by `wc -w`; the 0065 amendment shrank to four words.
9. **Nits.** This record now exists; the description shows the Log form "(Evidence for M3: ...)"; `content_chars` counts evidence; the description asks for `~` paths so a Shared project does not carry the account name; the design record's premise notes the change.
10. **Not caused by this change.** `e2e/milestones-k4.test.ts` step 3 uses the Linux form of `script` and fails on macOS; CI runs on Ubuntu.

Nothing found: the connector copy of `project-milestones.ts` and `MILESTONE_INSTRUCTION` stay identical to core under test; a save without evidence fingerprints as before; length caps sit in both the MCP schema and core; the web server's allowlist excludes `evidence` and `milestone_passed`; nothing else calls `checkpointProject`; project writes are refused under masking; the released-set hashes match; server instructions are about 1,250 characters.

## Recheck

Pending.
