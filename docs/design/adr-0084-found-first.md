# Design record: ADR 0084, Found first

Milestone 2 of relaunch step 1. Overflow for the ADR: exact wording, the rows D3 skips, the boost rule, the acceptance test and the review log.

## D0 instruction delivery check

KNOWN-LIMITS already says Codex, ChatGPT and Claude Desktop are not verified to show server instructions to their models, and Grok Bot is not listed. Before any build, one fresh session per app (Claude Code, claude.ai, Grok Bot, Codex, Muse) is connected to a throwaway vault holding a single fictional fact and asked a question only that fact answers. The session is not told to use NorthKeep. The result is recorded per app: answered from the vault, answered without it, or said it didn't know. Apps that never read the instruction get D2.

## D1 wording (draft for Jay)

It is sent as the MCP `instructions` string by both servers and placed in `CONTRACT_TEXT`, before the milestone rule:

> NorthKeep is this user's own record of their life and work: the people, organizations, properties and projects in it, and how they like things done. When the conversation names a person, organization or property you have no facts about yet, search NorthKeep with memory_retrieve before you answer; when it names a project, read it with project_get. What you remember about this user from elsewhere is not their record. NorthKeep is, because the user keeps it across all of their AI apps and corrects it there. When the user tells you a durable new fact, save it with memory_remember.

Today the connector keeps its own copy of the milestone rule (apps/connector-server/src/mcp.ts:130) rather than importing packages/mcp-server/src/project-recipe.ts:53. If the build keeps separate copies, a test compares them word for word (the ADR 0082 D1 pattern).

## D2 the stable sentence

> Before answering about a person, organization, property or project, check NorthKeep: it is my own record and outranks what you remember about me.

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
