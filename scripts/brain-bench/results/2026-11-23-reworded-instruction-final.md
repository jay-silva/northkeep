# Brain bench: 2026-11-23

Agent: Claude Code as a chat app, model `sonnet`, keyword search, one new session per question. Fictional data only.
Scored by a second model that sees the answer key; plain text rules mark every answer too.

The text measured is `PROPOSED_FOUND_FIRST` in `designs.mjs` as of this commit: "Before you answer a question or act on a request about this user, or about a person, organization, property or project in their life, search NorthKeep with memory_retrieve, even when your own saved notes or memories about the user seem to answer it: ...". The "Today's search" answers are the same 100 sessions as in `2026-11-23-reworded-instruction.md`; only the reworded design was run again.

| Design | What it adds | Correct | Likely range | Wrong | Incomplete | Said it did not know | Looked in NorthKeep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Today's search | NorthKeep as shipped | 81 of 100 | 72 to 87 | 7 | 5 | 7 | 90 of 100 |
| Reworded instruction | the connect-time text reworded to say look first | 89 of 100 | 81 to 94 | 4 | 4 | 3 | 100 of 100 |

"Wrong" matters most: a confident answer that is not right. "Likely range" is where the score would probably land if the same test were run again.

## What each step added

Each design adds one thing to the one above it. A step counts only if the split is unlikely to be chance.

| Step | Adds | Newly right | Newly not right | Could this be chance? |
| --- | --- | --- | --- | --- |
| Today's search to Reworded instruction | the connect-time text reworded to say look first | 10 | 2 | unlikely (3.9%) |

## Against today's search

One step can be too small to tell from chance while several together are not.

| Design | Newly right | Newly not right | Could this be chance? |
| --- | --- | --- | --- |
| Reworded instruction | 10 | 2 | unlikely (3.9%) |

## Where the misses came from

| Design | Missed without looking | Missed after looking | Repeated an out-of-date value | Answer changed between repeats |
| --- | --- | --- | --- | --- |
| Today's search | 6 | 13 | 6 | 0 |
| Reworded instruction | 0 | 11 | 2 | 0 |

## Correct answers by kind of question

These groups are small, so read them as hints, not results.

| Kind | Today's search | Reworded instruction |
| --- | --- | --- |
| Confirmed core facts | 13 of 14 | 13 of 14 |
| Plain facts | 15 of 16 | 15 of 16 |
| Different wording | 6 of 10 | 8 of 10 |
| Old note vs newer fact | 9 of 10 | 10 of 10 |
| Fact that changed | 7 of 8 | 7 of 8 |
| Answer in two places | 2 of 8 | 3 of 8 |
| Not recorded anywhere | 10 of 10 | 10 of 10 |
| Marked as disputed | 2 of 2 | 2 of 2 |
| Two records disagree | 2 of 2 | 2 of 2 |
| App's own notes out of date | 1 of 6 | 5 of 6 |
| Only in app's own notes | 4 of 4 | 4 of 4 |
| In a project | 6 of 6 | 6 of 6 |
| Two people, one first name | 4 of 4 | 4 of 4 |

## Cost and checks

| Design | Tool calls | Cost at list price | Sessions that failed to run | Graders disagreed |
| --- | --- | --- | --- | --- |
| Today's search | 122 | $1.34 | 0 | 1 |
| Reworded instruction | 137 | $1.42 | 0 | 2 |

## Answers the two graders marked differently

- Today's search `split-05`: rules said correct, second grader said incomplete: "Your vault lists one work credential: your **100-ton master license**, which expires **May 1, 2027**, about five months from now. A summary of an earlier chat mentions "licenses coming due" (plural) for the ferry, but it"
- Reworded instruction `split-06`: rules said incomplete, second grader said wrong: "Your records name two tenants: - **8 Alder Lane, downstairs:** Nell Park. As of an August note, she had asked about getting a cat, and Dana Okafor was going to answer her. - **8 Alder Lane, upstairs:** Colm Reddy, who to"
- Reworded instruction `split-08`: rules said abstained, second grader said wrong: "NorthKeep has two vendors on record for Heron Cabin: - **Summit Pools** services the hot tub. They replaced ClearSpa after ClearSpa closed. An older note still names ClearSpa, but it is out of date. - **Eastbrook Heating"

## Every answer that was not correct

### Today's search

- `core-07` wrong, did not look: "How do I sign a formal letter?" answered "Sign a formal letter like this: **1. Closing:** Use a formal phrase on its own line, followed by a comma. - "Sincerely," (the default, when you know the recipient's name) - "Yours sincerely," (common in UK usage when you"
- `direct-02` abstained: "Who cleans Heron Cabin?" answered "I couldn't find who cleans Heron Cabin. Your notes and the Heron Cabin project don't name a cleaner. The project only says "changeovers and vendors are running normally." Who is it, if you want me to save it?"
- `para-04` abstained: "Who fixes the pipes at the cabin?" answered "I don't have a plumber for Heron Cabin on record. Your notes and the Heron Cabin project don't name one. The project only says vendors are "running normally" and lists a chimney sweep to book. If you tell me who it is, I"
- `para-05` abstained: "What do I teach on weekends?" answered "Your records show you're teaching on Saturdays, at least before noon. There's a note not to schedule calls before noon on Saturdays for that reason. They don't say what you teach, so I can't tell you the subject. If you "
- `para-06` abstained: "What does my spouse do for a living?" answered "Your spouse, Riley Vale, works at St. Brendan's Clinic. I don't have a specific job title for Riley."
- `para-10` abstained: "Who handles snow removal at the cabin?" answered "I couldn't find who handles snow removal at Heron Cabin. Your notes and the Heron Cabin project don't mention it. The project only says that "vendors are running normally" and lists a chimney sweep to book. If you tell m"
- `stale-06` abstained: "What does the Heron Cabin cleaner charge per changeover?" answered "I couldn't find a changeover fee in your records. The only related entry says Marisol Peña cleans Heron Cabin on changeover days, and it gives no price. If you tell me her rate, I'll save it."
- `changed-03` wrong: "Who is the internet provider at Heron Cabin?" answered "Heron Cabin's internet provider is Pinecone Wireless. That note was imported from ChatGPT a year ago, so check it if the provider may have changed."
- `split-01` incomplete: "What are my dogs' names?" answered "Your vault lists one dog: Biscuit, a corgi born in 2021. It doesn't mention any others. If you have more dogs, tell me their names and I'll save them."
- `split-03` incomplete: "What are my kids into after school?" answered "Here's what your NorthKeep record shows: - **Juno** (14) is in the school orchestra. - **Felix** (turned 11 on Nov 21) plays soccer for the Eastbrook Otters. He wants to try out for goalkeeper. He started at Eastbrook Mi"
- `split-05` incomplete: "Which work credentials do I have to keep current?" answered "Your vault lists one work credential: your **100-ton master license**, which expires **May 1, 2027**, about five months from now. A summary of an earlier chat mentions "licenses coming due" (plural) for the ferry, but it"
- `split-06` incomplete: "Who are all the tenants in my rentals?" answered "Your records show two long-term tenants, both at 8 Alder Lane: - **Nell Park** rents the downstairs. She asked about getting a cat in August, and Dana Okafor was going to answer her. - **Colm Reddy** took over the upstai"
- `split-07` incomplete: "Which insurance companies do I have policies with?" answered "Your records show one insurer: **Alder Mutual**. It insures Heron Cabin, and the policy renews January 15. There's an open issue on that policy. An Alder Mutual agent said by phone that the cabin's hot tub is covered, bu"
- `split-08` abstained: "Which vendors look after Heron Cabin?" answered "Your records don't name any vendors for Heron Cabin. I checked your memories and the Heron Cabin project document. The only vendor-related items are: - The project status says "changeovers and vendors are running normall"
- `own-stale-01` wrong, did not look: "Which gym do I go to?" answered "You go to IronWorks on Dock Street."
- `own-stale-02` wrong, did not look: "Where does Riley work?" answered "Riley works at St. Brendan's Clinic."
- `own-stale-04` wrong, did not look: "What team does Felix play for?" answered "Felix plays for the Eastbrook Comets."
- `own-stale-05` wrong, did not look: "When is the weekly ops meeting?" answered "Your weekly ops meeting is on Mondays at 8. Today is Monday, so that's today."
- `own-stale-06` wrong, did not look: "What's my coffee order?" answered "Your coffee order is a black americano."

### Reworded instruction

- `core-01` incomplete: "Where do I work, and what's my title?" answered "Your NorthKeep record and my earlier notes don't agree, and neither one gives a job title. - **NorthKeep:** You own Larkspur Holdings LLC, a holding company. It owns Larkspur Works LLC (your software company) and Larkspu"
- `direct-02` abstained: "Who cleans Heron Cabin?" answered "I couldn't find who cleans Heron Cabin. Your records don't name a cleaner or cleaning service. The project notes only say that changeovers and vendors are "running normally." If you tell me who it is, I'll save it so it'"
- `para-02` abstained: "Who's my doctor?" answered "I don't have your doctor's name on record. The only mention is from an August planning chat, which says a doctor's office called about a check-up. It doesn't say who the doctor is. If you tell me the name, I'll save it."
- `para-04` abstained: "Who fixes the pipes at the cabin?" answered "I couldn't find a plumber for Heron Cabin. Your NorthKeep records and the Heron Cabin project don't name one. The project only says vendors are "running normally" and lists a chimney sweep to book. If you tell me who it "
- `changed-03` wrong: "Who is the internet provider at Heron Cabin?" answered "Heron Cabin's internet provider is Pinecone Wireless. That comes from a note imported from ChatGPT in November 2025, so it's about a year old. Tell me if the provider has changed. Separately, my earlier notes list the ba"
- `split-01` incomplete: "What are my dogs' names?" answered "I only found one dog on record: Biscuit, a corgi born in 2021. If you have other dogs, I don't have them saved. Tell me their names and I'll add them."
- `split-03` incomplete: "What are my kids into after school?" answered "Here's what NorthKeep has on your kids: - **Juno** (14) is in the school orchestra. - **Felix** (turned 11 on Nov 21) plays soccer. Practice is Mondays and games are Saturday mornings. He wants to try out for goalkeeper."
- `split-06` wrong: "Who are all the tenants in my rentals?" answered "Your records name two tenants: - **8 Alder Lane, downstairs:** Nell Park. As of an August note, she had asked about getting a cat, and Dana Okafor was going to answer her. - **8 Alder Lane, upstairs:** Colm Reddy, who to"
- `split-07` incomplete: "Which insurance companies do I have policies with?" answered "Your records show one insurer: **Alder Mutual**, which insures Heron Cabin. That policy renews January 15. Two caveats: - Whether the policy covers the Heron Cabin hot tub is unresolved. The agent said yes by phone, but "
- `split-08` wrong: "Which vendors look after Heron Cabin?" answered "NorthKeep has two vendors on record for Heron Cabin: - **Summit Pools** services the hot tub. They replaced ClearSpa after ClearSpa closed. An older note still names ClearSpa, but it is out of date. - **Eastbrook Heating"
- `own-stale-06` wrong: "What's my coffee order?" answered "Your coffee order is a black americano. That comes from my earlier notes about you. NorthKeep has no record of it."

