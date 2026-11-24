# Design record: ADR 0094, Welcome as a real feature

Milestone 8 of relaunch step 1. Draft of 2026-11-24, written against the code on branch `claude/adr-0085-revised`. Design only: nothing here is built, and no adversarial review has been run. The number 0094 is the next free one (0087 to 0091 exist on other branches).

Every name in the examples is made up. The fictional person is Dana Whitlock.

## The short version

The interview is run by whatever agent the person is already talking to. NorthKeep gives that agent one tool. The agent calls it, gets up to six questions, asks them in its own voice, hands the answers back, and gets the next six or "that is the end of this chunk". NorthKeep keeps the place, so the person can stop in Claude on Monday and pick up in a Grok Bot on Thursday. Nothing is typed into a form and the Mac app is never needed for it.

## What the code looks like today (read, not run)

- No interview exists. The only first-run code is the Mac app's setup dialog (apps/web/static/index.html, steps welcome, passphrase, connect, try, backup, extras) and the phone's onboarding. Its last step already shows a starter line, "Want to try one? Send this to Claude Desktop:" (apps/web/test/first-run-ui.test.ts). The design reuses that pattern.
- The device server has about 14 tools and the connector has 10 (packages/mcp-server/src/server.ts, apps/connector-server/src/mcp.ts). Neither has anything named welcome.
- The connector's `memory_remember` writes only into a scope that is already Shared and already holds at least one row pushed from a device (mcp.ts, around line 480). A cloud app cannot create a scope.
- A cloud app connects by typing an 8-character pairing code that a device made. The code is single-use and lasts ten minutes (create-server.ts `/pair/start`, consent.ts). So one code per app, typed once.
- The vault schema is 0.4. The `memories` table has a free-form `metadata` column; `confirmed` and `archive` already live there. Rows sent to the connector carry `type`, `content`, and two optional flags, `confirmed` and `archive`, inside the encrypted envelope (crypto.ts `RowPlain`).
- ADR 0085's save check is not in the code on this branch (`memory_remember` still stamps plain `mcp`). Milestone 8 depends on it.

## 1. Who runs the interview, and how it starts

**The tool.** `welcome_interview`, the same name and shape on both servers:

- Called with nothing: returns where the person is ("chunk 2 of 7, 3 questions left") and the next questions.
- Called with answers: saves them, records progress, returns the next questions, or the chunk's closing summary when the chunk is done.
- Called with `stop: true`: records the stop and returns one line to say to the person.
- Called with `not_now: true`: holds any offer until tomorrow.

Each reply is complete on its own: the questions, how to phrase saved facts (one fact per item, full names, third person), what was saved, what was held and why, and what to do next. The agent never has to remember an earlier reply. That matters for Grok Bot and Muse, which have one continuing conversation and no fresh start: the state lives in NorthKeep, not in the chat.

One tool was chosen over two (one to fetch, one to submit) because every reply then carries the next step, and the tool list in apps like Grok Bot stays short. (Inferred: that a shorter list helps those apps. Not measured.)

**How it starts on a device agent (Claude Code, Codex, Cursor, Claude Desktop).**
1. The setup dialog's last step shows one line with a Copy button: "Start my NorthKeep welcome interview." The person sends it to the connected app.
2. If they skip that, NorthKeep adds one line to the end of a `memory_retrieve` result: "From NorthKeep, not from the user's memories: the Welcome interview is at chunk N of 7. When the current task is done, offer the next five minutes once. Call welcome_interview." It appears at most once a day and stops when the interview is finished.

**How it starts on a cloud app that only has the connector (claude.ai, Grok Bot, Muse, ChatGPT).**
1. The connect page already shows the look-first sentence. It gains one more line under it: "Then send the app this: Start my NorthKeep welcome interview."
2. The same one-line offer on a connector `memory_retrieve` or `search` result.

The offer rides on a tool result on purpose. Finding (b) says Grok Bot and Muse ignore the connect-time instruction. A line inside a result they asked for is more likely to be read. (Inferred. It needs the same kind of live check ADR 0084 D0 ran.)

**The once-a-day limit.** The plan's ration (rule 12) belongs to milestone 5, which is not built. If milestone 8 is built first, the smallest version is: the device server keeps the date of its last offer in a small file beside the vault, so a search stays a read; the connector keeps one date per account. That is two counters, so a person using both a device app and a cloud app could see two offers in a day. Milestone 5's shared ration replaces both.

**The look-first sentence, without a paste.** When the app's self-reported name is one known to ignore instructions, the first reply adds: "Ask the person: may I add one line to my own instructions so I check NorthKeep first? If yes, add exactly this sentence." That turns a paste into a "yes". Not verified: whether Grok Bot or Muse will do this from a tool result. The connect page's copy-and-paste stays as the fallback.

**The stale instruction block (findings d and e).** The installed block for Claude Code and Codex goes stale after an upgrade until the Mac app is opened. Proposal: the device server, at start, checks the block. If it is one NorthKeep wrote in an earlier release and nobody edited it (the hash list in contract.ts already tells these apart), it rewrites it. An edited block is never touched. Not verified: I did not find the code that refreshes the block when the Mac app opens, so I am taking finding (d) from the brief.

## 2. The chunks

**How long is five minutes.** Proposed: at most six questions per chunk. A spoken answer plus a follow-up runs about 45 seconds, so six is close to five minutes. One question can yield several facts ("who lives with you" yields a partner, two children and a dog). Seven chunks, about 40 questions, about 35 minutes in all, taken whenever the person likes.

**Order.** The plan says the interview opens with the user: identity, roles, organizations, properties, key people. Chunk 1 is built so that it alone captures the roughly ten facts that moved the score on 2026-11-24.

| # | Chunk | Questions (short form) | Facts it must capture |
|---|---|---|---|
| 1 | You, in five minutes | What should I call you, and your full name. Where is home. Who lives with you, pets included, by name. Where do you work and what is your role (each job). What companies do you own or part-own, and with whom. How do you like answers and reports, and how do you sign. | Name. Home town. Each household member and pet. Each employer and role. Each company and its owners (second level, see section 3). Report style. Signature. |
| 2 | People | Who do you work with most. Family outside the house. Who looks after your money, law and property (accountant, lawyer, agent). Whose name do apps get wrong, and the right spelling. Anyone I should never contact without asking. | One memory per person: full name, relationship, organization. Spellings and nicknames. |
| 3 | Organizations | For each employer or company from chunk 1: what it does, who runs it, your part in it. Clients, vendors or agencies you deal with often. | One memory per organization. Who owns what is second level. |
| 4 | Properties | Each place you own, rent out or look after: where, what it is used for, who owns it, who manages it or lives there. | One memory per property. Ownership is second level. |
| 5 | Projects | What are you working on now. For each: one line, who else is in it, what done looks like. | One memory per project. The agent may then offer to create a tracked project the normal way, with its own agreed milestones. |
| 6 | How you like things done | Tone and length. Formats you want or hate. What an assistant must always ask before doing. Tools and apps you use. | Procedural memories, one preference each. |
| 7 | Often wrong, and wrap-up | What do people or apps often get wrong about you. Anything in dispute that an assistant should ask about, not guess. Then the read-back. | "This is disputed, ask" memories (the 2026-11-21 baseline found a trap is passed by a rule, not a fact). The list of answers still waiting for confirmation. |

The interview never asks about health, patients, passwords or account numbers. The reply text tells the agent not to record a patient's name or condition even if offered. NorthKeep cannot enforce that part; it is the agent's behaviour.

"Later" leaves a question open; it is asked once more at the end. "Skip" closes it. "None" is saved as a fact where it helps ("Dana Whitlock has no pets"), so an agent does not guess.

**The import chunks.** The plan's "then the import by topic, with three choices per group" applies to a vault that holds quiet imported memories. That is the owner's vault and milestone 4's work. For a new person there is nothing to import, so the seven chunks are the whole interview. When milestone 4 lands, its topic groups appear after chunk 7 through the same tool.

**How progress is stored.** No schema change. Each call that changes anything adds one small row, a "Welcome record", in the interview's scope. Example content: "Welcome record, 2026-12-02, Grok Bot. Chunk 1. Answered: name, home, household, work. Skipped: none. Stopped by the person." Its metadata lists the question keys and the ids of the memories saved for them, and marks the row so search skips it, the way ADR 0084 D3 skips project paperwork. Where the person stands is worked out by reading these rows.

Why rows and not a table or a settings key:
- The connector can only see rows in Shared scopes. A table or a `vault_meta` key never reaches it, so a cloud app could not resume.
- Rows are added and never rewritten. A cloud app's rewrite of an existing row would wait for the person's confirmation (ADR 0085 D4). An added row arrives through the path that already works.
- No new step in `migrate()`. The repo's CLAUDE.md warns that an older build refuses a newer vault and that orphaned old servers once broke writes in three apps.
- The export stays complete and readable (invariant 4): the rows are plain text.

Cost: a full interview leaves perhaps 20 to 40 record rows. They are hidden from search but visible in the export and the memory list. Milestone 6 (tidies itself) could fold them into one.

If the owner prefers a table anyway, it would be schema 0.5 with a new step in `migrate()`, and the connector would need its own copy of the state. I recommend against it.

**Which scope.** Answers go into one scope, proposed `personal`. For a cloud app to save there, the scope must be Shared and hold one device-pushed row. So setup gains one loud confirmation, "Let your connected AI apps read and add to your basics", which marks `personal` Shared and writes the first Welcome record. This is the person's own explicit choice, so invariant 1 stands. If it was never shared, the cloud tool says so in plain words and tells the person where to turn it on.

## 3. How answers are saved

**Trust.** Plan rule 11 sets two levels. ADR 0084 D4 says only the app and the command line can mark a memory confirmed. Those two do not fit together yet: milestone 5 was meant to build the two levels. This design adds the smallest piece needed:

- Everyday answers (names, family, pets, home town, roles, preferences) are saved with `confirmed: {by: "user", via: "conversation", app, at}`. Search treats them as confirmed.
- Answers about who owns an entity, money and accounts, and anything acted on legally are saved without the mark, tagged "waiting for confirmation in NorthKeep". The chunk's closing reply tells the person how many are waiting. They are confirmed the way ADR 0084 already allows: the Mac app, `northkeep confirm`, or the phone once milestone 5 ships its notification.
- The question key decides the level, not the agent. The key lives in NorthKeep's script.
- Only `welcome_interview` sets the conversation mark. `memory_remember` still cannot.
- An interview answer never replaces a memory the person confirmed in NorthKeep itself. It is held and listed instead.

The honest weakness: an app can call the tool with an answer the person never gave, and it will be stored as confirmed in conversation. The plan accepts that for everyday facts. The defences are the read-back at the end of each chunk, the Welcome record naming the app and date, and the fact that every such memory can be found and undone. This is a change to who decides, so the review gate applies.

**Duplicates.** Each fact goes through ADR 0085's save check before it is written:
- Identical to a live memory: nothing is written; the existing id is recorded against the question.
- Near match: nothing is written; the reply lists up to three existing memories and the agent asks the person "is this the same as, or different from". The agent answers with `replaces` or `distinct`. NorthKeep never picks.
- On the connector, a `replaces` lands as a new memory and the replace waits for the person, as ADR 0085 D4 says. Until then both show.

Every saved fact carries the app's name as ADR 0085 D1 stamps it.

**On the connector.** A cloud answer is written like any connector save, with two more fields inside the encrypted row: the conversation mark and the question key. The device applies them when it pulls. The connector learns nothing new in the clear.

## 4. Past chats and mailboxes

**In this milestone.**
- "What you already know about me." At the end of any chunk the person may ask the agent to suggest from what that app already remembers. The agent proposes one item at a time, the person says accept or skip, and accepted items go through the same tool under the same two levels. Nothing new leaves the machine: the app already held that text. The script never does this unasked.

**Out of this milestone, and why.**
- Reading mail. NorthKeep has no mail reader. Building one puts untrusted text in front of a model and adds a new thing NorthKeep reads, so it needs its own decision record and review.
- The To, From and Cc tool for mailboxes that can carry patient information. Rule 15 says that until that tool exists, those people are entered by hand. Chunk 2 is that "by hand".
- Reading exported chat histories. Same reason as mail, and it is milestone 4's ground.

One guard is included now: if the person asks the agent to go through a mailbox with the agent's own mail connector, the tool's reply states the plan's rule (people and organizations only, never what a message says, never attachments, each person shown to accept or skip, and never a mailbox that may hold patient information). NorthKeep cannot enforce that on another app's connector. KNOWN-LIMITS must say it is advice.

## 5. The first outside customer's ten minutes

Two things first. The install test asks his apps to answer "from the shared JSRC brain". Sharing a brain between two people's accounts is step 3 and is not designed. And milestone 8 only makes his own brain fillable. So milestone 8 alone cannot pass the install test; it removes one blocker.

Assuming a Mac, counted against the code as it is, plus this design's two additions (marked NEW):

| Step | What he does | Paste | Code | Approval |
|---|---|---|---|---|
| 1 | Taps the link, downloads NorthKeep, opens it | | | 1 (macOS "Open") |
| 2 | Makes a passphrase (typed twice, once to confirm) | | | |
| 3 | Backup step: saves the recovery file, ticks the box (mandatory, ADR 0070) | | | |
| 4 | NEW: confirms "let your connected apps read and add to your basics" | | | 1 |
| 5 | Claude: adds NorthKeep as a connector with the address | 1 | | |
| 6 | Claude: types the pairing code on the connect page, taps Allow | | 1 | 1 |
| 7 | Grok Bot: adds the connector with the address | 1 | | |
| 8 | Grok Bot: second pairing code, Allow | | 1 | 1 |
| 9 | Grok Bot: the look-first sentence (a paste today; NEW: a "yes" if the bot adds it itself) | 1 or 0 | | 0 or 1 |
| 10 | Sends "Start my NorthKeep welcome interview" in either app; chunk 1 takes five minutes | 1 | | |

Totals: 3 or 4 pastes, 2 codes (one per app, each typed once), 4 or 5 approvals, no terminal, no hand-copied file. Against the test's four failure rules it passes on paper. Not verified by anyone: the timing, and steps 5 and 7, which depend on screens inside Claude and Grok Bot that I did not open.

What can still fail it:
- **Free access.** The connector needs a subscription or an allowlisted account, and the allowlist is keyed to an account that exists only after step 2 (apps/sync-server handler.ts; inferred, not traced end to end). The one link has no way to carry "free for this person" yet.
- **A forced restart.** Connecting Claude Desktop the local way tells the person "Restart Claude Desktop to load it" (index.html line 7500). The table uses the Cloud connector for Claude to avoid that.
- **Phone only.** The iPhone app is a TestFlight beta (README). That is a second link and an invitation.
- **Time.** Steps 1 to 9 must fit in about five minutes if chunk 1 is to fit in ten.

## 6. Acceptance test (an agent can run it)

A scripted MCP session, on a throwaway vault, with a fictional person. No model is needed: the script plays the agent. Tool arguments are this draft's proposal and will be fixed when the code lands.

Setup: a temporary `NORTHKEEP_HOME`, a new vault, ADR 0085's save check present. Two MCP clients start the device server against that vault and announce different names, "client-a" and "client-b".

1. Client A calls `welcome_interview` with nothing. Expect: chunk 1 of 7, six questions, the first asking for a name.
2. Client A answers three: "The user's full name is Dana Whitlock and she goes by Dana." "Dana Whitlock lives in Port Alder." "Dana Whitlock's dog is named Biscuit." Then `stop: true`. Expect: three memories in `personal`, each with the conversation mark naming client-a; one Welcome record; the reply says three questions remain.
3. Client B calls with nothing. Expect: chunk 1, the same three remaining questions, none of the answered ones.
4. Client B answers work: "Dana Whitlock is the harbor master at the Port Alder Harbor Office." And companies: "Dana Whitlock owns half of Tidewater Boats LLC; Sam Okafor owns the other half." Expect: the work memory has the conversation mark naming client-b. The ownership memory has no mark and the reply says one answer is waiting for confirmation in NorthKeep.
5. Client B sends "Dana Whitlock's dog is named Biscuit." again. Expect: nothing written; the existing id returned.
6. Client B sends "Dana Whitlock's dog Biscuit is a spaniel." Expect: held, the Biscuit memory listed, nothing written. Client B resends with `distinct: true`. Expect: saved.
7. Client B answers the last question. Expect: the reply is the chunk 1 summary and says chunk 2 (People) is next.
8. Client A calls `memory_retrieve` for "what is the dog called". Expect: the Biscuit memory comes back and no Welcome record does.
9. Client A calls `memory_remember` with a made-up fact and tries to pass a confirmed mark. Expect: the save has no mark.
10. Export the vault. Expect: every memory and every Welcome record is there as readable text, and the schema version is still 0.4.
11. Connector half, against a local connector server with test storage (inferred from the e2e tests; not confirmed that this harness covers a new tool): share `personal`, push, connect a test client, call `welcome_interview`. Expect: it returns chunk 2. Answer one People question, pull on the device. Expect: the memory arrives with the conversation mark and the test client's name.
12. Offer limit: two searches on the same day return the offer line once.

Pass: all twelve as stated. The 25 questions are then rerun, as after every milestone.

## What I did not verify

- Nothing was run. Every statement about the code comes from reading it on one branch.
- Whether Grok Bot, Muse or ChatGPT will call a tool because a tool result suggests it, or add a sentence to their own instructions when asked.
- The screens and steps inside Claude and Grok Bot for adding a connector.
- How the Mac app refreshes the instruction block today.
- Whether ADR 0085 will be built as its revised draft says; this design leans on its hold rule and its app stamp.
- The connector's storage change for the once-a-day date, and how the device applies the two new row fields on a pull. Both are sketched, not traced.
- The entitlement path for a free customer.

## Decisions for the owner

1. **Six questions per chunk, seven chunks.** Proposed as "five minutes". Yours to set.
2. **Everyday interview answers count as confirmed in conversation**, set by this tool alone, changing ADR 0084 D4. Yes or no. If no, every answer waits for you in the app.
3. **Do conversation-confirmed answers rank the same as ones confirmed in NorthKeep?** Proposed: yes for now.
4. **Which topics are second level in the interview.** Proposed: who owns a company or property, money and accounts, anything legal. Everything else is everyday.
5. **The interview's scope and sharing it at setup.** Proposed: `personal`, shared after one loud confirmation in setup. The alternative is a new scope just for the basics.
6. **Build order.** Milestone 8 leans on 3 (save check) and borrows from 5 (two levels, the ration). If 8 is pulled ahead of 5, it ships the small versions described here and milestone 5 takes them over. OK?
7. **The offer inside search results**, at most once a day per surface. Yes or no; and whether "per surface" (up to two a day) is acceptable until milestone 5.
8. **The bot adding the look-first sentence to its own instructions** after the person says yes, in place of a paste. Worth a live test first.
9. **The device server rewriting its own unedited instruction block at start**, with no prompt. It writes to a file agents read, so I am asking, not assuming.
10. **The starter line's wording**: "Start my NorthKeep welcome interview."
11. **Mail stays out of milestone 8**, with only the advisory sentence. Confirm.
12. **Gaps for the install test that this milestone does not close**: free access carried by the link, the shared brain between two accounts, and whether the first customer is on a Mac or phone only. Each needs its own decision before that test can run.
