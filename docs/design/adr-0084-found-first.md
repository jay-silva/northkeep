# Design record: ADR 0084, Found first

Milestone 2 of relaunch step 1. Overflow for the ADR: exact wording, the rows D3 skips, the boost rule, the acceptance test and the review log.

## D0 instruction delivery check

KNOWN-LIMITS already says Codex, ChatGPT and Claude Desktop are not verified to show server instructions to their models, and Grok Bot is not listed. Before any build, one fresh session per app (Claude Code, claude.ai, Grok Bot, Codex, Muse) is connected to a throwaway vault holding a single fictional fact and asked a question only that fact answers. The session is not told to use NorthKeep. The result is recorded per app: answered from the vault, answered without it, or said it didn't know. Apps that never read the instruction get D2.

## D1 wording (draft for Jay)

This is the wording 0.29.0 shipped. It was reworded on 2026-11-23; see "D1 reworded: look first" at the end.

It is sent as the MCP `instructions` string by both servers and placed in `CONTRACT_TEXT`, before the milestone rule:

> NorthKeep is this user's own record of their life and work: the people, organizations, properties and projects in it, and how they like things done. When the conversation names a person, organization or property you have no facts about yet, search NorthKeep with memory_retrieve before you answer; when it names a project, read it with project_get. What you remember about this user from elsewhere is not their record. NorthKeep is, because the user keeps it across all of their AI apps and corrects it there. When the user tells you a durable new fact, or you find their record is missing or wrong, save it to NorthKeep with memory_remember rather than to your own memory or notes files.

Today the connector keeps its own copy of the milestone rule (apps/connector-server/src/mcp.ts:130) rather than importing packages/mcp-server/src/project-recipe.ts:53. If the build keeps separate copies, a test compares them word for word (the ADR 0082 D1 pattern).

## D2 the stable sentence

> Before you answer a question about me, or about a person, organization, property or project in my life, search NorthKeep first, even when your own notes seem to answer. It is my own record and it outranks what you remember about me.

Reworded and built on 2026-11-24. The first wording ("Before answering about a person, organization, property or project, check NorthKeep: it is my own record and outranks what you remember about me.") left out questions about the user and did not say the app's own notes may be wrong, the two things the D1 rewording added.

The check D0 asked for was run on Jay's own account on 2026-11-24, as part of the 25-question rerun on 0.30.0. Claude searched NorthKeep unprompted in 19 of 25 chats and scored 24. Grok Bot never searched and scored 17, its baseline; with this sentence in its instructions it searched every time and scored 24. Muse answered from what it remembered of earlier searches and scored 13, its baseline; with the sentence it scored 21. Codex searched on about half the questions.

Where it is shown (Jay approved the mock, "both is good", 2026-11-24):
- The page an app opens when it connects, above the Allow button, because that page closes on Allow. That page forbids scripts (`default-src 'none'`), and the build keeps it that way: the sentence selects whole on a tap (`user-select: all`) and the person copies it. The mock showed a Copy button there; a button needs a script, and loosening that page's policy is a separate decision.
- The Cloud page in the Mac app, with a Copy button.

## D3 rows skipped by search

| Row | How it is recognized | Served instead by |
|---|---|---|
| Project document | `isLiveProjectDocument` (vault.ts) | `project_get` |
| Log archive | `isProjectLogArchive`, project scope | `project_get --history` |

`project-handoff.ts:364` uses a bare `startsWith` instead of `isProjectLogArchive`. The build moves it onto the shared detector. An agent that can write a scope can make a row look like an archive and so hide it from search. `memory_edit` and `memory_forget` already let that agent do worse, so this is accepted.

## D5 boost rule

- Device: the boost applies only when the entry contains at least one query term that is not a stopword. In semantic mode it also requires the cosine floor.
- Connector: the same condition, with word-boundary matching instead of today's substring match. The boost never admits an entry that would otherwise be dropped.

Fixtures are fictional. A confirmed answer must outrank an agent-written near-copy. A confirmed memory that shares only "the" with the query must not appear in keyword mode, in semantic mode or on the connector.

## Acceptance test (draft; the final commands land with the code)

On a throwaway vault and home, never Jay's:

```bash
export NORTHKEEP_HOME=$(mktemp -d) NORTHKEEP_PASSPHRASE=throwaway-pass
export NK=$NORTHKEEP_HOME/vault.nkv
northkeep --vault $NK init
northkeep --vault $NK remember "Pat Example started at the harbor office in 2019" --type semantic
northkeep --vault $NK remember "Pat Example is the harbor office director" --type semantic --confirmed
northkeep --vault $NK remember "Jay prefers the window seat on flights" --type procedural --confirmed
northkeep --vault $NK search "who runs the harbor office"
```

Success: the director line comes first and the window-seat line does not appear. A second step creates a project and checks that the device `memory_retrieve` (through an MCP client) does not return its document or log archive. Then the 25 questions are rerun.

## Review log

Review 1 (fresh eyes, 2026-11-20): CLEARED WITH WOUNDS. What changed:
- The boost floor was one shared word, stopwords included, and a substring on the connector. Fixed by D5's non-stopword, word-bounded rule.
- An agent edit kept the confirmed marker, because `supersedeEntry` copies metadata. D4 now names the strip.
- The instruction pointed project questions at a tool D3 empties. D1 now routes projects to `project_get`.
- `CONTRACT_TEXT` was an unmentioned third channel. It now gets the D1 wording.
- Instruction delivery was unverified for Codex, ChatGPT and Grok Bot. D0 adds the live check, with Muse included.
- The acceptance test set no `NORTHKEEP_HOME`. It does now.
- Recorded as accepted scar tissue: a shell-capable agent can run `northkeep confirm`, the same limit KNOWN-LIMITS accepts for milestones.

Recheck (2026-11-20): CLEARED WITH WOUNDS. All prior wounds closed except D5. The boost no longer flips rankings, but the stopword-only match was still admitted, so the fixture and the acceptance test asserted an exclusion the decision did not make. Fixed after the recheck: D5 now gates admission as well, so a keyword match needs a non-stopword word on both surfaces. Not yet rechecked. Build notes from the recheck:
- The connector keeps its own `isProjectLogArchive` (apps/connector-server/src/project-doc.ts:322). "One detector" therefore means one rule, with a test keeping the two copies identical.
- Changing `CONTRACT_TEXT` means appending the new render's hash to `RELEASED_CONTRACT_RENDER_SHA256`. Otherwise existing installs read as edited and are never offered the update.
- Instruction delivery stays unverified against reality until D0 runs.

Second recheck (2026-11-21, Jay asked for it): CLEARED WITH WOUNDS. The D5 fix is closed in keyword mode, semantic mode and on the connector, and the revised acceptance fixture passes in all three. The verdict stays capped only because instruction delivery is unverified until D0 runs.

Baseline finding (2026-11-21, from the planning thread): Claude scored 19 or 20 of 25 and never called NorthKeep. Two "Decisions archive" memories, saved by an agent on 2026-11-21 when the project record was trimmed, now rank first in `memory_retrieve` for unrelated personal questions ("names of Jay's dogs"). Changes:
- D3 now also skips rows marked `archive` in metadata. Only NorthKeep's own writers set that marker, the same rule as `confirmed`. The trim gets a proper path (a `project_update` option that moves old Decisions into a marked archive), and the two existing rows are re-saved with the marker when milestone 2 ships.
- Long rows win keyword overlap, because a several-KB row matches most query words. The build adds a fixture: a long unrelated row must not outrank a short exact answer, and the overlap score is normalized for length if that fixture fails.
- Several baseline misses (family and pet names, favorite food) are not in the vault at all. Those are capture failures for milestone 3 and the Welcome interview, not search failures.

Third baseline (2026-11-21, likely Muse, scored 12 to 14): it checked NorthKeep unprompted for about 10 answers and scored lowest, with four confident wrong or incomplete answers traced to what NorthKeep served. Personal details stay out of the repo; the patterns:
- A months-old agent session note answered an ownership question wrongly and contradicted a newer fact. Session notes need to rank below confirmed facts, which D4 gives only once the fact is confirmed.
- A project document was served as the description of a company. D3 covers this on `memory_retrieve` and `search`.
- Two answers left out facts that exist as memories (a second property, a second pet). Recall, not ranking: the build adds a fixture where the answer is split across two short memories and both must come back within the default limit.
- Conclusion: getting agents to look is necessary but not enough. Whether agent-written session notes should rank below other agent facts by default is an open question for the next review round, which needs Jay's ask.

Full baseline (2026-11-21, provisional until Jay rules on his answer key): no agent passes. Cursor scored 16 to 17 and passed the trap through Jay's rules file, not memory. Findings for the build:
- Agents default to their own store. Asked about gaps, Cursor offered to write to its own notes file and Claude to its own memory; neither offered NorthKeep. The D1 draft above now names saving to NorthKeep instead of the agent's own store.
- A trap is passed by a rule, not a fact. A confirmed entry that says a fact is disputed and to ask the user would let every agent pass; the Welcome interview should offer that kind of entry.
- A search for a pet returned only a project whose name contains the word, and missed a personal-scope memory. Another retrieval miss; the split-answer fixture gains a case where a project name matches the query and the personal memory must still come back.
- One agent-written memory conflicts with Jay's key. It is left alone until Jay confirms which is right.

## Build notes (2026-11-21, branch claude/m2-found-first)

What was built, and where it departs from the decisions above:
- D0: Claude Code passes server instructions to its model (seen in a live session's own instructions). Codex could not be tested from the build session: its configured model is refused on Jay's ChatGPT account. claude.ai, Codex, Grok Bot and Muse wait for a run with Jay.
- D1: `FOUND_FIRST_INSTRUCTION` in packages/mcp-server/src/project-recipe.ts, a copy in apps/connector-server/src/mcp.ts, a test that the copies and both handshakes match, and the contract gains the sentence (three new render hashes).
- D2 was built on 2026-11-24; see "D2 the stable sentence" above.
- D3: `isProjectPaperwork` (core and connector copies) behind `skipProjectPaperwork`, which `memory_retrieve` and CLI search pass. Other callers, such as Converse, are unchanged. The archive marker needs a writer, so the CLI gains `mark-archive <id>`; the `project_update` option that moves Decisions out is not built yet.
- D5 plus two additions the baseline asked for: a plain trailing "s" is folded ("dogs" finds "dog"), and a row with more than 64 distinct words loses up to 0.3 of keyword score. The long-row fixture fails without that cut. On the connector a word found only in a row's scope or type counts half.
- D6 carries a second flag, `archive`, beside `confirmed`, so the connector skips marked archives too.
- Session notes ranking below other memories is not built; it waits for Jay.

Acceptance test as run on throwaway data (keyword mode, no local model): the confirmed director line ranked first, the 2019 line second, the window-seat line absent.
- D8 (Jay, 2026-11-21, "Old agent session notes rank below other memories"): `isOldAgentNote` and `compareSearchResults` in core search-rules. An episodic row whose source is `mcp`, `mcp:<host>` or `connector:<host>`, older than 30 days and unconfirmed, sorts after every other match on both the keyword and meaning paths. It is a sort tier, not a score cut, so a note that is the only match still comes back. Rows imported from an app's own memory (`import:*`) are not notes and are unaffected. The connector does not apply D8: pushed rows carry no source, and their timestamp is the push time.

Build recheck (2026-11-21, fresh eyes on the code): CLEARED WITH WOUNDS. No path lets an AI app set or keep `confirmed` or `archive`, and the flags stay inside the ciphertext. Wound, fixed after the recheck: the connector drift test compared too little and failed once D8 landed; it now compares the shared word rules verbatim and checks the boost and the paperwork rule by running both copies on the same rows. Also fixed: a long row's keyword score is floored at zero, so a weak keyword hit never ranks below no hit. Accepted and recorded:
- Plural folding admits some false matches ("news" matches "new").
- An agent edit keeps an `archive` marker, so a rewritten archive stays out of search.
- An edit resets a row's age, so an agent's edit of an old note restarts the 30 days.
- The verdict stays capped until D0 shows which apps pass the instruction.

## D1 reworded: look first (2026-11-23)

Jay, 2026-11-23: "Okay, the wording." A review then changed two phrases (below), so the final text needs his word again at merge. The first paragraph of the instruction now reads:

> NorthKeep is this user's own record of their life and work: the people, organizations, properties and projects in it, and how they like things done. Before you answer a question or act on a request about this user, or about a person, organization, property or project in their life, search NorthKeep with memory_retrieve, even when your own saved notes or memories about the user seem to answer it: they may be out of date, and NorthKeep is where the user corrects things across all of their AI apps. When the conversation names a project, read it with project_get. When the user tells you a durable new fact, or you find their record is missing or wrong, save it to NorthKeep with memory_remember rather than to your own memory or notes files.

What changed from 0.29.0:
- The trigger was "a person, organization or property you have no facts about yet". An agent that had its own, out-of-date note about the user had facts, so it did not look. The trigger is now any question or request about the user or the people, organizations, properties and projects in their life, with "even when your own saved notes or memories about the user seem to answer it".
- The two sentences "What you remember about this user from elsewhere is not their record. NorthKeep is, because the user keeps it across all of their AI apps and corrects it there." are folded into that sentence's reason.
- Reading a named project with project_get is its own sentence. The save sentence and the milestone rule are unchanged.

Why: the brain bench (PR 84), 100 questions on a fictional vault, Claude Code with Sonnet, word search. The 0.29.0 wording scored 81 and this wording 89. The agent looked in NorthKeep in 90 sessions with the old wording and in all 100 with the new. Confident wrong answers fell from 7 to 4. Ten answers became right and two became wrong; a split that uneven would come from two equal wordings about 4% of the time. The new wording cost about an eighth more tool calls (122 with the old wording, 137 with the new).

Not measured: any app other than Claude Code, a real vault, and requests that are not questions (every bench item is a question).

Review (2026-11-23, fresh eyes, against code): CLEARED WITH WOUNDS.
1. "Not yet in a release" was half true: merging redeploys the connector, so cloud apps get the text at merge. Fixed in KNOWN-LIMITS.
2. The first draft said "Before you answer a question about", which read literally leaves out a task such as "email Carol about the lease". Fixed: "answer a question or act on a request about". The first draft had scored 87 against 81.
3. "Your own notes or memory" could be read in Claude Code as the user's instruction files. Fixed: "your own saved notes or memories about the user".
4. Not changed, and older than this rewording: the contract's standing instruction says to start a named project with project_resume, and this paragraph says project_get. The connector has no project_resume. A question about a project now also triggers a memory search, which skips project documents (D3), so it costs two calls.
5. Not changed: a coding session about a tracked project will search more often than the bench's questions did.
6. The test covered only the 0.29.0 Claude file. Fixed: the Cursor rule and the Codex block are checked against their 0.29.0 hashes too.

Clean: the three appended hashes are the three current renders; every 0.29.0 render still reads as an earlier release and is replaced without a backup; the local text, the connector's copy and the contract's copy are identical and a test enforces it; nothing else in the repo quotes the old wording as current; nothing new leaves the machine.

The contract text changes with the wording, so three new render hashes are appended to `RELEASED_CONTRACT_RENDER_SHA256`.
