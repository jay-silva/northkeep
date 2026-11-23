# Brain bench: 2026-11-23

Agent: Claude Code as a chat app, model `sonnet`, keyword search, one new session per question. Fictional data only.
Scored by a second model that sees the answer key; plain text rules mark every answer too.

| Design | What it adds | Correct | Likely range | Wrong | Incomplete | Said it did not know | Looked in NorthKeep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Today's search | NorthKeep as shipped | 81 of 100 | 72 to 87 | 7 | 5 | 7 | 90 of 100 |
| Reworded instruction | the connect-time text reworded to say look first | 87 of 100 | 79 to 92 | 3 | 4 | 6 | 99 of 100 |

"Wrong" matters most: a confident answer that is not right. "Likely range" is where the score would probably land if the same test were run again.

## What each step added

Each design adds one thing to the one above it. A step counts only if the split is unlikely to be chance.

| Step | Adds | Newly right | Newly not right | Could this be chance? |
| --- | --- | --- | --- | --- |
| Today's search to Reworded instruction | the connect-time text reworded to say look first | 7 | 1 | yes (7%) |

## Against today's search

One step can be too small to tell from chance while several together are not.

| Design | Newly right | Newly not right | Could this be chance? |
| --- | --- | --- | --- |
| Reworded instruction | 7 | 1 | yes (7%) |

## Where the misses came from

| Design | Missed without looking | Missed after looking | Repeated an out-of-date value | Answer changed between repeats |
| --- | --- | --- | --- | --- |
| Today's search | 6 | 13 | 6 | 0 |
| Reworded instruction | 1 | 12 | 2 | 0 |

## Correct answers by kind of question

These groups are small, so read them as hints, not results.

| Kind | Today's search | Reworded instruction |
| --- | --- | --- |
| Confirmed core facts | 13 of 14 | 12 of 14 |
| Plain facts | 15 of 16 | 16 of 16 |
| Different wording | 6 of 10 | 8 of 10 |
| Old note vs newer fact | 9 of 10 | 9 of 10 |
| Fact that changed | 7 of 8 | 7 of 8 |
| Answer in two places | 2 of 8 | 2 of 8 |
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
| Reworded instruction | 142 | $1.50 | 0 | 3 |

## Answers the two graders marked differently

- Today's search `split-05`: rules said correct, second grader said incomplete: "Your vault lists one work credential: your **100-ton master license**, which expires **May 1, 2027**, about five months from now. A summary of an earlier chat mentions "licenses coming due" (plural) for the ferry, but it"
- Reworded instruction `core-01`: rules said incomplete, second grader said abstained: "Your NorthKeep record doesn't list a job title for you. It does show these: - **Larkspur Works LLC** is your software company. - **Larkspur Holdings LLC** is your holding company. It owns Larkspur Works and Larkspur Cabi"
- Reworded instruction `split-05`: rules said correct, second grader said incomplete: "The only work credential I have on record is your **100-ton master license**, which expires **May 1, 2027**. That's about five months from now. Two older conversation summaries mention "licenses coming due" and "Coast Gu"
- Reworded instruction `split-08`: rules said wrong, second grader said abstained: "Your records don't name any vendors for Heron Cabin. The project note says only that "changeovers and vendors are running normally." The one vendor-like item is a to-do to book the chimney sweep, with no company listed. "

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

- `core-01` abstained: "Where do I work, and what's my title?" answered "Your NorthKeep record doesn't list a job title for you. It does show these: - **Larkspur Works LLC** is your software company. - **Larkspur Holdings LLC** is your holding company. It owns Larkspur Works and Larkspur Cabi"
- `core-07` wrong, did not look: "How do I sign a formal letter?" answered "Here's the standard format for signing a formal letter: **1. Closing phrase** Choose one that fits the tone: - **Yours sincerely,** (when you addressed the person by name, e.g. "Dear Ms. Alvarez") - **Yours faithfully,**"
- `para-04` abstained: "Who fixes the pipes at the cabin?" answered "I couldn't find a plumber for Heron Cabin. Your records don't name one, and the Heron Cabin project only mentions "vendors" in general. The one vendor it names is a chimney sweep, which is still to be booked. If you tell"
- `para-10` abstained: "Who handles snow removal at the cabin?" answered "I couldn't find who handles snow removal at Heron Cabin. Your records don't mention it. The Heron Cabin project only lists "vendors running normally", with no names. Do you want to tell me who it is, so I can save it for"
- `stale-06` abstained: "What does the Heron Cabin cleaner charge per changeover?" answered "I couldn't find a per-changeover charge anywhere in your records. The only thing saved about the cleaner is that Marisol Peña cleans Heron Cabin on changeover days. Nothing records what she charges. If you tell me the ra"
- `changed-03` wrong: "Who is the internet provider at Heron Cabin?" answered "Heron Cabin's internet provider is Pinecone Wireless. That record was imported from ChatGPT a year ago (Nov 2025), so check it if you've changed providers since."
- `split-01` incomplete: "What are my dogs' names?" answered "I only found one dog in your records: Biscuit, a corgi born in 2021. If you have other dogs, tell me their names and I'll save them."
- `split-03` incomplete: "What are my kids into after school?" answered "Here's what I have on your two kids: - **Juno** (age 14) is in the school orchestra. - **Felix** (age 11) plays soccer for the Eastbrook Comets. Practice is on Mondays and games are Saturday mornings. He started at Eastb"
- `split-05` incomplete: "Which work credentials do I have to keep current?" answered "The only work credential I have on record is your **100-ton master license**, which expires **May 1, 2027**. That's about five months from now. Two older conversation summaries mention "licenses coming due" and "Coast Gu"
- `split-06` incomplete: "Who are all the tenants in my rentals?" answered "Your records show these tenants: **8 Alder Lane** - Downstairs: Nell Park. She asked about getting a cat, and Dana Okafor is answering her. - Upstairs: Colm Reddy, who took over the lease in July 2026. **12 Quarry Road**"
- `split-07` abstained: "Which insurance companies do I have policies with?" answered "I don't have any record of which insurance companies you have policies with. Your saved memories only mention insurance in passing. One chat listed "insurance renewals" among a busy month's to-dos, and another had it as "
- `split-08` abstained: "Which vendors look after Heron Cabin?" answered "Your records don't name any vendors for Heron Cabin. The project note says only that "changeovers and vendors are running normally." The one vendor-like item is a to-do to book the chimney sweep, with no company listed. "
- `own-stale-06` wrong: "What's my coffee order?" answered "A black americano. That comes from my notes from earlier chats. I searched NorthKeep too, but it had nothing on coffee, so I couldn't check it there."

