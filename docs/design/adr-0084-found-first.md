# Design record: ADR 0084, Found first

Milestone 2 of relaunch step 1. Overflow for the ADR: exact wording, the rows D3 skips, the boost, and the draft acceptance test.

## D1 wording (draft for Jay)

Sent as the MCP `instructions` string by both servers, before the milestone rule:

> NorthKeep is this user's own record of their life and work: the people, organizations, properties and projects in it, and how they like things done. When the conversation names a person, organization, property or project you have no facts about yet, search NorthKeep with memory_retrieve before you answer. What you remember about this user from elsewhere is not their record; NorthKeep is, because the user keeps it across all of their AI apps and corrects it there. When the user tells you a durable new fact, save it with memory_remember.

The trigger is named, the agent's own memory is demoted, and the reason is given (grill questions 8 and 9). Text that refers to `replaces` lands with ADR 0085, not before.

Today the connector keeps its own copy of the milestone rule (apps/connector-server/src/mcp.ts:130) rather than importing packages/mcp-server/src/project-recipe.ts:53. The build keeps two copies if the connector cannot import the package, and a test compares them word for word (the ADR 0082 D1 pattern).

## D2 the stable sentence

> Before answering about a person, organization, property or project, check NorthKeep: it is my own record and outranks what you remember about me.

It never changes with a release (grill question 9). Placement needs a mock Jay approves (his rule for every new screen).

## D3 rows skipped by search

| Row | How it is recognized | Why skipped |
|---|---|---|
| Project document | live, type `working`, scope `project:<slug>` (`isLiveProjectDocument`) | paperwork; `project_get` serves it |
| Log archive | project scope, content starts with `PROJECT_LOG_ARCHIVE_HEADING` | history; `project_get --history` serves it |

Recognizing an archive by its heading means a memory that starts with that heading is also hidden. Only someone who can write to that scope can do that, and it only hides their own row. Accepted; the review should try to break this.

## D5 the boost

The ranker adds a fixed amount to a confirmed entry's score after the relevance gate. An entry that fails the gate is never lifted. Fixtures are fictional: two memories that answer one question, one confirmed, one written by an agent with slightly better keyword overlap. The confirmed one must rank first. A confirmed memory unrelated to the query must not appear.

## Acceptance test (draft; final commands land with the code)

On a throwaway vault, never Jay's:

```bash
export NK=/tmp/nk-m2/vault.nkv NORTHKEEP_PASSPHRASE=throwaway-pass
mkdir -p /tmp/nk-m2 && northkeep --vault $NK init
northkeep --vault $NK remember "Pat Example runs the harbor office" --type semantic
northkeep --vault $NK remember "Pat Example is the harbor office director" --type semantic --confirmed
northkeep --vault $NK search "who runs the harbor office"
```

Success: the confirmed line is listed first. A further step creates a project and checks that `search` does not return its document or log archive. Then the 25 questions are rerun.
