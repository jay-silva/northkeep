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
