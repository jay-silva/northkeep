# Design record: ADR 0092, Asked, not guessed

Milestone 5 of relaunch step 1: "Conflict detection, the queue, the daily ration, two levels of confirmation." This is the long record behind the short ADR. It is a draft. Nothing here is built, and no review has been run. The ADR number 0092 is assumed (0090 is the highest in SPEC/decisions today).

## In one screen

- NorthKeep notices two live memories that look like they disagree, using words only.
- It never picks. It shows both, says so, and asks the user through whatever agent is in use, once per pair.
- The question rides on the search result the agent already reads. Grok Bot and Muse need nothing new pasted.
- The agent reports the answer with one new tool, `memory_resolve`. NorthKeep records the app, the date and the user's words.
- Everyday facts settle in chat (level 1). Ownership, money, accounts, legal matters and anything in the confirmed core wait for the user in NorthKeep itself (level 2).
- Cleanup questions are rationed: one sitting a day, three questions at most, counted once for all apps.

## The rules this relies on

Quoted from plan-rules.txt (the number is the interview question).

| Rule | Text relied on | Q |
|---|---|---|
| When memories disagree | "The agent asks the user at the moment of use, once, and the answer is saved as a resolution. NorthKeep does the noticing. 'Both are right' is an allowed answer. When nobody is there to ask, the more trusted or newer memory is used and the question is queued." | 10 |
| How much an answer in chat is trusted | "Two levels. Everyday facts count as confirmed in conversation, recorded with the app and date. Entity ownership, money and accounts, and anything acted on legally count only when confirmed in NorthKeep itself." | 11 |
| Where cleanup happens | "Through the agent already in use, from a short queue NorthKeep keeps with no model. NorthKeep itself handles only second-level confirmations, as a phone notification." | 12 |
| The ration | "At most once a day, at the start of a session or the end of a task, three questions at most. 'Not now' holds until tomorrow." | 12 |
| What NorthKeep may never change alone | "Forget or delete anything, choose between memories that state different facts, or change the confirmed core." | 19 |
| What NorthKeep may change alone | "...mark a memory replaced when the saving agent names it... Every such change is listed and reversible." | 19 |
| Grok Bot | "A first-class target beside Claude, and one of the biggest." | (last row) |

Not in plan-rules.txt, taken from elsewhere:
- "No local model may be required": ADR 0085 ("Words only on both surfaces", "the first customer has none"). The plan row says only "with no model".
- "The user rarely opens the Mac app": ADR 0084 D7 and ADR 0086 Context.
- O1 and O2: ADR 0085 D5 and its design record ("O1 , yes", "O2, no", Jay, 2026-11-21).
- Grok Bot and Muse reach NorthKeep only through the Cloud connector, and ignore connect-time instructions: the second half is in the ADR 0084 design record (Grok Bot "never searched" until the pasted sentence was added; Muse answered from its own memory). The first half comes from the brief for this draft. I did not verify it in the repo.
- Claude Code cutting server instructions past about 4,000 characters: from the brief. I found no record of it in the repo. Today's instructions are about 1,050 characters (measured: 789 plus 258).

## What the code looks like today (checked)

- `searchTerms`, `wordWeights`, `weightedMatch` and `isConfirmed` are in packages/core/src/search-rules.ts. The connector keeps a copy (apps/connector-server/src/search-rules.ts) and a test keeps them the same.
- `isConfirmed` is true only when `metadata.confirmed.by === "user"`. Only `confirmMemory` (vault.ts) and the CLI's `confirm` and `remember --confirmed` write it. An agent edit drops it (`supersedeEntry`, vault.ts around line 1667).
- Confirming writes a new row with the same content and marks the old row replaced. So a memory's id changes when it is confirmed.
- The vault schema is at 0.4. `migrate()` has three steps. `vault_meta` holds settings.
- The connector holds shared rows as ciphertext in `shared_entries`, plus `pending_forgets` (entry ids in the clear). Its `/client/*` routes rebuild the account key per request, so a new encrypted table is possible on the same pattern.
- The connector's `memory_retrieve` returns plain text. Its `search` returns `{results}` as structured content and as JSON text. The device's `memory_retrieve` returns a JSON payload with a `note` field.
- The connector has no `memory_edit`. A cloud `memory_forget` waits for the user on a device.
- Milestone 3 (ADR 0085) is not built on this checkout: `memory_remember` has no `replaces` or `distinct` yet. This design depends on it.
- The phone app (apps/mobile) has no notification code. I searched its package file and config for "notif" and found none.

## 1. Noticing a conflict, with words only

### The rule

Take two live memories A and B. "Live" means not replaced, not forgotten, not project paperwork (`isProjectPaperwork`), and not one of the imported memories milestone 4 makes quiet (inferred: milestone 4 is not designed yet).

They are a possible conflict when all of these hold:

1. **Same subject.** They pass ADR 0085's revised hold rule: they share at least two words (`searchTerms`), and the shared words carry at least 60% of the rarity weight (`wordWeights`) of either one. This is reused, not reinvented.
2. **Not the same text.** After ADR 0085's normalizing they are not identical. Identical text is a duplicate, which milestone 3 already refuses.
3. **Something differs.** One of:
   - each holds at least one word or number the other lacks ("Pier 4" against "Pier 9"; "Leo Marsh" against "Priya Shah"); or
   - only one of them holds a negation, from a short named list checked on the raw text, because `searchTerms` throws away "not", "no" and similar words as stopwords. Proposed list: not, no, never, "n't", no longer, former, formerly, used to.

If B's words all sit inside A (and no negation differs), B adds nothing A lacks. That is a merge candidate for milestone 6, not a question.

### Where it runs

| Moment | Where | Compared against |
|---|---|---|
| Save | device and connector, inside milestone 3's save check | live memories in the same scope |
| Search | device and connector, in memory for that one request | the results being returned, any scope |
| Sweep | device only, after a sync brings rows in and once when this ships | live memories in the same scope |

At save, milestone 3 already stops and asks the agent to choose `replaces` or `distinct: true`. When the agent answers `distinct: true` and rule 3 holds, the save goes through and a question is opened. This is the backstop ADR 0085 names for an agent that wrongly says "distinct".

The connector already decrypts every shared row to rank a search (ADR 0090 D5). Comparing the handful it returns, in memory, derives nothing it stores.

### What it cannot detect

- **Conflicts that share no distinctive word.** "Leo does our taxes" against "the accountant is Priya Shah". ADR 0085 records the same gap.
- **Whether two facts truly disagree.** "Pat has a dog named Rex" and "Pat has a dog named Milo" may be two dogs. Words cannot tell. This is why "both are right" exists, and why NorthKeep asks instead of acting.
- **Different words for one thing.** "cleaner" and "cleans" do not match (ADR 0090 says so). Nicknames and misspellings do not match until milestone 7.
- **Conflicts across scopes, outside search.** The save check and the sweep look inside one scope. A personal memory and a project memory that disagree are caught only when one search returns both.
- **A conflict with a project document.** Documents are left out, as in ADR 0085.
- **Time.** "Rent was 1,800 in 2024" and "rent is 1,950" will be flagged though both are right.

### Not measured

ADR 0085 measured the 60% rule on the bench vault: 22 of 130 saves held. Rule 3 can only shrink that. I did not measure how much, or how many questions Jay's real vault would open. The build should run the rule over the bench vault first and report the count before anything ships.

## 2. The queue

### In the vault

One new schema step in `migrate()`, 0.4 to 0.5 (inferred: milestones 3 and 4 may take 0.5 first; this takes the next free step).

```
questions
  id            text, random
  kind          'conflict' | 'replace'
  pair_key      text, unique
  entry_a       text    memory id
  entry_b       text    memory id
  level         1 | 2
  state         'open' | 'answered_waiting' | 'resolved' | 'void'
  opened_at     text
  opened_by     'save' | 'search' | 'sweep' | 'cloud'
  shown_at_use  text or null    set the first time a search result carried it
  answer        'a' | 'b' | 'both' | 'neither' | null
  said          text or null    the user's words, as the agent quoted them
  answered_app  text or null    app name, self-reported, as ADR 0085 D1 labels it
  answered_at   text or null
  applied_at    text or null
```

- `pair_key` is a hash of the two memories' normalized text, sorted. It is built from content, not ids, because confirming a memory changes its id (checked above). Without this, a settled pair would be asked again after either side was confirmed.
- "Once" is enforced by the unique `pair_key`: a resolved pair is never reopened while both texts stand. If either memory is edited, the text changes and a new pair may be noticed. That is intended.
- A question becomes `void` when either memory stops being live.
- `kind: 'replace'` is the waiting cloud replace of ADR 0085 D4 ("cloud replaces wait for Jay until milestone 5"). It joins this queue so there is one list, not two.
- The table is added to the export, so the vault stays complete as readable JSON (invariant 4).
- The questions table is bookkeeping and sits outside the hash chain. What an answer changes (a replaced row, a new confirmed row) is in the chain as always.

A schema step means a running older MCP server stops and asks to be updated (CLAUDE.md, "Ship safely"). That is the designed behaviour, but it will be seen in every open app at once.

### On the Cloud connector

A question is copied to the connector only when both memories are in scopes the user marked Shared. A question touching a private memory never leaves the device.

- New table `shared_questions`: account hash, a random question id, timestamps, and one ciphertext column. Inside the ciphertext: the two entry ids, kind, level, state, answer, the user's quoted words and the answering app.
- **No pair key and no memory text is stored there.** The connector builds the question's wording at request time from the two rows it already decrypts to serve the search. This is the point where invariant 2 bites: a hash of content in the clear would be "derived plaintext", so it stays inside the ciphertext or stays home.
- In the clear, the connector learns: that an account has N open questions, and when each was opened and answered. Entry ids stay inside the ciphertext, so it does not learn which memories disagree.
- The device sends and collects questions over the existing `/client/*` routes, gated by the `?v=` version pattern of ADR 0063 so the phone and older builds never see rows they cannot handle.
- The connector also opens questions itself, at search and at save, for rows it serves. Those are born on the connector and come down to the device on the next sync, like connector-born memories do. This matters for a person whose Mac is asleep: Grok Bot can save a fact and be told about the conflict in the same conversation.

Inferred, not verified: that the phone app can write to the vault and so could apply an answer. Whole-vault sync is last-writer-wins (KNOWN-LIMITS), so I assume answers are applied on the Mac until someone checks.

## 3. How a question reaches the agent

Three channels were possible.

| Channel | Verdict | Why |
|---|---|---|
| Connect-time instructions | No | Grok Bot and Muse ignore them. They are fixed at connect, so they cannot carry today's question. Memory text in instructions would be a new place for content to go. |
| A tool the agent must think to call | Not alone | An app that ignores instructions never calls a tool it was not told about. |
| Text appended to a result the agent already asked for | Yes | Every one of the four test apps reads search results. Grok Bot searched every time once the pasted sentence was in place (ADR 0084 record). |

So: **the question is a fixed block at the end of `memory_retrieve` and `search` results**, and the answer comes back through **one new tool, `memory_resolve`**. No change to the connect-time wording and no change to the one pasted sentence, which the plan says must stay stable.

### The block at the moment of use

When a search returns two memories with an open question between them, shown for the first time:

```
NORTHKEEP QUESTION q_7f3a (ask the user; do not answer for them)
These two saved memories disagree:
  A (mem_12, saved by Claude, 2026-03-02): The harbor office is at Pier 4.
  B (mem_48, saved by Grok Bot, 2026-11-20): The harbor office is at Pier 9.
If the user is here, ask which is right. They may say both are right, or neither.
Then call memory_resolve with question "q_7f3a", answer "a", "b", "both" or "neither", and said: the user's own words.
If the user is not here, use B (newer) for now and say the record is unsettled. Do not call memory_resolve.
```

- The wording is NorthKeep's and fixed. Only the two memory lines vary, and the agent could already read both.
- "Use B for now" follows the rule: "the more trusted or newer memory is used and the question is queued." More trusted means `by: "user"` over `by: "chat"` over unconfirmed; newer breaks a tie.
- After the first showing, later searches do not ask again. They list both memories in that order with a one-line note on the second: "disagrees with the memory above; the question is waiting for the user." The question then waits for a cleanup sitting.
- On the device the block goes in the JSON payload as a `questions` list, and the memory lines pass through return masking like any result.
- On the connector's `search`, which some apps read only as structured content (a lesson already recorded for project tools in mcp.ts), the block goes in both the structured content and the text. Not verified: that ChatGPT shows its model a field beyond `results`.

### The cleanup block

The first search of the day that wins the ration (section 5) gets up to three waiting questions in the same format, under one line: "NorthKeep has up to 3 short questions for the user today. Ask them now if it is a good moment. If the user says not now, call memory_resolve with answer 'not_now'."

On the device, `project_wrap` results carry it too, because that is literally "the end of a task". Inferred: that appending to `project_wrap` is welcome. It can be dropped without harm.

Cleanup questions are about memories the current search did not return, so they put memory text in front of the agent that it did not ask for. On the connector both memories are in Shared scopes, which the app may read anyway. On the device they are limited to scopes that session was granted (`NORTHKEEP_SCOPES`).

### `memory_resolve`

```
memory_resolve
  question  the id from the block
  answer    'a' | 'b' | 'both' | 'neither' | 'not_now'
  said      the user's words, short (required unless not_now)
  correct   the right fact, only with 'neither'
```

It accepts only ids of questions NorthKeep opened and showed to that app. An agent cannot use it to confirm or replace an arbitrary memory.

This puts a new instruction-shaped text in front of models and adds a tool that changes memories. Both are named in the review gate ("who decides", "untrusted input in front of the model"), so the adversarial review must run before any build.

## 4. Applying and recording the answer

### Two levels, in data

| Level | Plain meaning | In data | Who can write it |
|---|---|---|---|
| none | saved, never checked | no `confirmed` key | any writer |
| 1 | the user said so in a conversation | `metadata.confirmed = {by: "chat", app, at, question}` | NorthKeep only, when `memory_resolve` settles a level 1 question |
| 2 | the user confirmed it in NorthKeep itself | `metadata.confirmed = {by: "user", at}` (today's marker, unchanged) | the Mac app, the CLI, later the phone |

- `isConfirmed` keeps its meaning: level 2 only. Everything that protects "the confirmed core" today keeps working untouched: the ranking boost, the long-row exemption, the old-note exemption.
- A new helper, `confirmationLevel(metadata)`, returns 0, 1 or 2. Search uses it so level 1 ranks above unconfirmed and below level 2. The size of the level 1 boost is a proposal (see Decisions).
- The marker travels to the connector inside the row's ciphertext, as `confirmed` does today (ADR 0084 D6), with one more value.
- An agent edit drops either marker, as today.

### Which level a question needs

A question is level 2 when any of these is true. Otherwise it is level 1.

1. Either memory is confirmed `by: "user"`. This is the confirmed core, which NorthKeep may never change alone, and a chat answer relayed by an agent is not the user acting in NorthKeep.
2. Either memory's text hits a named word list for the three classes in the rule: entity ownership, money and accounts, legal matters. Proposed starting list: own, owner, owns, ownership, member, shareholder, percent, %, LLC, Inc, trust, bank, account, routing, loan, mortgage, deed, title, lien, tax, EIN, lease, contract, a currency sign followed by a number. The list is a constant with a test, like the stopword list.
3. It is a waiting cloud replace (`kind: 'replace'`). ADR 0085 says these wait for Jay.

The word list will be wrong in both directions. "Title" also means a book title; an ownership fact phrased without any listed word slips to level 1. When it hits wrongly, the cost is one extra confirmation. When it misses, a chat answer settles something the rule wanted confirmed in NorthKeep. KNOWN-LIMITS must say so.

### What each answer does

Level 1, the user said "B is right":
1. B is re-saved with the same text plus the level 1 marker (the same move `confirmMemory` makes today).
2. A is marked replaced by that new row. A is not forgotten. It stays in the vault and the export.
3. The question is `resolved`, with app, date and the user's words.
4. The change appears in the list of changes that can be undone (the list itself is milestone 6; until then `northkeep questions --resolved` shows them and `northkeep restore` reverses one). Inferred: that `restore` can reverse a replace of this shape. Step 2 needs a primitive that does not exist today, "mark an existing row replaced by another existing row"; ADR 0085 D4 already calls for it.

"Both are right": no memory changes. Only the resolution is stored, so the pair is never asked about again.

"Neither", with the right fact: a new memory is saved with the level 1 marker and both old ones are marked replaced by it.

"Not now": nothing changes. Cleanup questions stop for every app until tomorrow.

Level 2, the user answers in chat: the answer is recorded and the state becomes `answered_waiting`. No memory changes. The agent is told: "Recorded. This one touches ownership, money or a confirmed fact, so it takes effect when the user confirms it in NorthKeep." Search keeps showing both, with the note. The user then confirms in NorthKeep itself:
- `northkeep questions` lists what is waiting; `northkeep answer <id> <a|b|both|neither>` settles it and writes `by: "user"`. It needs an interactive terminal and ignores `--yes` and `NORTHKEEP_ASSUME_YES`, the pattern ADR 0086 D1 set, because an agent with a shell could otherwise run it.
- The Mac app lists the same queue beside connector forgets.
- The phone: the rule says "as a phone notification". The phone app has no notifications today. See Decisions.

### How an answer given in chat is trusted

NorthKeep cannot hear the user. It hears an agent saying what the user said. The design does not pretend otherwise; it limits what a false report can do.

1. The agent can only answer a question NorthKeep opened, about a pair NorthKeep chose.
2. A chat answer never writes `by: "user"` and never touches a memory that has it.
3. The loser is marked replaced, not forgotten, and the change is listed and reversible.
4. The three sensitive classes wait for NorthKeep itself.
5. The record keeps the app's name, the date and the words quoted. That is the "chain of evidence" the plan names as how NorthKeep wins.
6. A cloud app cannot settle a question in favour of a memory that same app wrote. The connector knows which sign-in wrote a connector-born row and which sign-in is answering; this does not rely on the self-reported app name. Such an answer becomes `answered_waiting` until a different app, a device agent, or NorthKeep itself agrees. Without this guard, one cloud app could save a new fact as "distinct", wait for the question, answer it for itself, and so replace a memory with no owner in the loop, which is what "O2, no" forbids.
7. Device agents are not held to item 6, because "O1, yes" already lets a device agent replace any memory, the result being unconfirmed.

### The tension with "O2, no", stated plainly

"O2, no" says cloud apps may not replace memories without the owner's confirmation. Rule 11 says everyday facts "count as confirmed in conversation". Ryan, the first customer, works only in cloud apps. If every cloud answer waited for a device, rule 11 would never be true for him.

This design reads the two together: a chat answer to a question NorthKeep asked **is** the owner's confirmation at level 1, for everyday facts, with guard 6. "O2, no" keeps governing replaces a cloud app proposes on its own, which stay level 2.

That reading is mine, not Jay's. It is decision 1 below. If he says no, the fallback is already in the design: every cloud answer becomes `answered_waiting`, nothing else changes, and cloud users settle nothing until a device or the phone confirms.

## 5. The ration

The rule: "At most once a day, at the start of a session or the end of a task, three questions at most. 'Not now' holds until tomorrow."

- **What it covers.** Cleanup questions only. A question shown at the moment of use, about memories the user just asked about, is rule 10 and is not counted. (Inferred from the two rules being separate rows. See Decisions.)
- **One sitting.** The first app to ask for cleanup questions on a given day takes the day's sitting and gets up to three. After that no app is offered any until tomorrow, whether the user answered, said "not now", or the agent never asked. An agent that takes the sitting and stays silent wastes the day. That errs toward fewer questions, which is the side the rule protects.
- **Where the count lives.**
  - With the Cloud connector on: one small record per account on the connector: the day, and whether the sitting is taken. Cloud apps read it directly. The device's MCP server asks the connector before offering cleanup questions; it already talks to the connector for sync (auto-sync.ts). **If it cannot reach the connector, it offers none.** A promise of "at most" should fail toward silence.
  - With no connector: two keys in `vault_meta`, `ration_day` and `ration_taken`. Every local app shares one vault file, so they share the count.
- **How it resets.** The day is the user's calendar day. The connector does not know the user's time zone, so the device sends its UTC offset (for example "-05:00") when it syncs, and the connector uses the last one it was given, or UTC if none. The offset is new data leaving the machine; it is content-free and is named in the ADR.
- **Several apps at once.** Taking the sitting is a single "set if not already set" write on the connector, or a write under the vault lock on the device. Two apps asking in the same second cannot both win.
- **Which three.** Level 2 questions already answered in chat and waiting are not re-asked. Among open questions: oldest first. (A proposal; see Decisions.)

Rejected: counting on the device and the connector separately and reconciling at sync. Simpler, but a day could bring two sittings and six questions.

## 6. Acceptance test (draft; final commands land with the code)

Everything below is fictional and runs on a throwaway vault and home, never a real one. The commands `questions` and `answer`, the tool `memory_resolve` and the `distinct` argument do not exist yet; steps marked (M3) need milestone 3 built first. `northkeep serve`, the three environment variables and the SDK client are as the repo's own tests use them today (e2e/m4.test.ts).

### Part A: scripted MCP session on the device

```bash
export NORTHKEEP_HOME=$(mktemp -d) NORTHKEEP_PASSPHRASE=throwaway-pass NORTHKEEP_NO_KEYCHAIN=1
export NK=$NORTHKEEP_HOME/vault.nkv
northkeep --vault $NK init
northkeep --vault $NK remember "The harbor office is at Pier 4" --type semantic
northkeep --vault $NK remember "The harbor office is at Pier 9" --type semantic
northkeep --vault $NK remember "Pat Example owns 40 percent of Tidewater Example LLC" --type semantic
northkeep --vault $NK remember "Pat Example owns 55 percent of Tidewater Example LLC" --type semantic
northkeep --vault $NK remember "Dana Example likes the window seat" --type procedural
northkeep --vault $NK questions
```

Expect: two open questions. The Pier pair is level 1. The Tidewater pair is level 2 ("owns", "percent", "LLC"). The window-seat memory is in neither.

Then a script, run from the repo root after a build (`node m5-accept.mjs`):

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const env = { PATH: process.env.PATH, NORTHKEEP_HOME: process.env.NORTHKEEP_HOME,
  NORTHKEEP_PASSPHRASE: process.env.NORTHKEEP_PASSPHRASE, NORTHKEEP_NO_KEYCHAIN: '1' };
const open = async (name) => { const c = new Client({ name, version: '1.0' });
  await c.connect(new StdioClientTransport({ command: process.execPath,
    args: ['packages/cli/dist/index.js', 'serve'], env, stderr: 'ignore' })); return c; };
const call = async (c, name, args) => (await c.callTool({ name, arguments: args })).content[0].text;

const a = await open('app-one');
const r1 = await call(a, 'memory_retrieve', { query: 'where is the harbor office' });
console.log('1', r1.includes('NORTHKEEP QUESTION') && r1.includes('Pier 4') && r1.includes('Pier 9'));
const q = r1.match(/q_[a-z0-9]+/)[0];

const b = await open('app-two');
const r2 = await call(b, 'memory_retrieve', { query: 'where is the harbor office' });
console.log('2', !r2.includes('ask the user') && r2.includes('waiting for the user'));

console.log('3', (await call(b, 'memory_resolve',
  { question: q, answer: 'b', said: 'It moved to Pier 9 in the fall.' })).includes('Recorded'));
const r3 = await call(a, 'memory_retrieve', { query: 'where is the harbor office' });
console.log('4', r3.includes('Pier 9') && !r3.includes('Pier 4') && !r3.includes('NORTHKEEP QUESTION'));

const r4 = await call(a, 'memory_retrieve', { query: 'who owns Tidewater Example' });
const q2 = r4.match(/q_[a-z0-9]+/)[0];
const r5 = await call(a, 'memory_resolve', { question: q2, answer: 'b', said: 'Fifty-five.' });
console.log('5', r5.includes('confirms it in NorthKeep'));
const r6 = await call(a, 'memory_retrieve', { query: 'who owns Tidewater Example' });
console.log('6', r6.includes('40 percent') && r6.includes('55 percent'));

console.log('7', (await call(a, 'memory_resolve',
  { question: 'q_madeup', answer: 'a', said: 'x' })).includes('No open question'));
await a.close(); await b.close();
```

Success is seven lines ending `true`:
1. The first search carries the question with both memories.
2. A second app is not asked again; it sees the "waiting" note. (Asked once.)
3. The answer is accepted.
4. Search now returns Pier 9 alone.
5. The ownership answer is recorded but not applied.
6. Both ownership memories are still served.
7. A made-up question id is refused.

Then:

```bash
northkeep --vault $NK export | grep -n "Pier\|confirmed\|superseded_by"
northkeep --vault $NK answer <the Tidewater question id> b
northkeep --vault $NK search "who owns Tidewater Example"
```

Expect: the Pier 4 row has `superseded_by` set and is not forgotten; the live Pier 9 row carries `confirmed` with `by: "chat"`, `app: "app-two"` and a date; the export's `questions` list shows the user's words. After `answer`, which must refuse to run without an interactive terminal, the search returns the 55 percent memory alone, marked confirmed.

### Part B: the ration, device only

Add eight more fictional conflicting pairs with `remember`, none of them searched for. Open three fresh clients in the script and search for the window seat in each.

Expect: exactly one of the three results carries a cleanup block, with exactly three questions. Answer one with `not_now`. A fourth client gets none. Set the clock forward a day (the build provides a test-only clock variable; not designed here) and one client gets the next sitting.

### Part C: the connector, on a local connector with in-memory storage

The repo's connector tests run a local server with in-memory storage (storage.ts). Share a scope, push the Pier pair, and connect two cloud clients with separate sign-ins.

Expect: the stored question row holds no memory text and no entry ids in the clear (read the stored row and search it for "Pier" and for both ids). Client one's search carries the question. Client one saves "The harbor office is at Pier 12" as distinct (M3), then tries to settle the new question in favour of its own memory: recorded, not applied. Client two gives the same answer: applied. A device sync then shows the same result in the vault export.

I did not run any of this. None of it can run until the code exists.

## What I did not verify

- Any threshold or count. Nothing was measured for this draft; the only numbers are ADR 0085's.
- That Claude Code cuts instructions near 4,000 characters, and that Grok Bot and Muse have no path to NorthKeep except the connector. Both are from the brief.
- That Grok Bot and Muse will relay a block at the end of a tool result as a question to the user. The ADR 0084 record shows they read results once they search. Whether they act on an instruction inside a result is untested, and it is the assumption this whole design leans on hardest. A cheap live check before building: hand-place the block's text in a fictional memory on a throwaway shared scope and see what each app does.
- How ChatGPT treats extra fields in `search` results.
- Whether the phone app can apply an answer to the vault.
- Whether `northkeep restore` can undo a replace of the shape in section 4.
- How milestones 3 and 4 will land. Neither is built; milestone 4 is not designed.
- The connector's cost of comparing results on every search. It should be small (a handful of rows), but it is unmeasured.
- I read the working tree as checked out, on branch claude/adr-0085-revised. I did not compare it with main.

## Decisions for the owner

1. **Does a chat answer through a cloud app count as your confirmation for everyday facts?** Recommended yes, with the guard that a cloud app cannot settle in favour of its own memory. It narrows "O2, no" to replaces a cloud app proposes itself. If no, cloud answers all wait for a device or the phone.
2. **Second-level confirmations on the phone.** The rule says "as a phone notification". The phone app has no notifications. Sending one needs a new networked service, which invariant 7 reserves for you, and its own decision record. Choose: (a) milestone 5 ships level 2 through the CLI and Mac app, with the agent telling you a confirmation is waiting, and the notification follows in its own ADR; or (b) milestone 5 waits for the notification.
3. **The sensitive word list.** The proposed list is in section 4. You know which words mark ownership, money and legal facts in your world better than a list I made up.
4. **How far a level 1 confirmation lifts a memory in search.** Level 2 multiplies by 1.5 on the connector and adds 0.5 on the device today. Proposed: half of that for level 1. No rule states a number.
5. **Do moment-of-use questions count against the ration?** Proposed no: the ration covers cleanup only. If yes, a busy day could silence real conflicts.
6. **What a day is.** Proposed: your calendar day, with the device sending its UTC offset to the connector. The alternative sends nothing and resets at midnight UTC, which is early evening in New England.
7. **Which three questions come first.** Proposed: oldest first.
8. **The negation list** in section 1, and whether the 60% threshold from ADR 0085 is reused as is. Both should be settled by a measured run on the bench vault, which needs your go-ahead as it is build work.
9. **How long the user's quoted words may be.** A cap is needed so the field cannot carry a document. Proposed: 200 characters.
10. **Whether an unanswered sitting should cost the day.** Proposed yes (fewer questions). The alternative lets another app try again the same day, and risks more than one sitting.
11. **Cloud forgets.** They already wait for you on a device (connector-client.ts). They could join this queue as a third kind, level 2 only. Not included here; say if you want it.
