# ADR 0091 design record: one hash-pinned script on the connect page

The decision is in SPEC/decisions/0091-connect-page-copy-script.md. This file holds its review.

## Review (2026-11-24, fresh eyes, against the code, with a local server and headless Chrome): CLEARED WITH WOUNDS
No exploitable hole. Hostile values in every field left one script and one sentence element; an injected inline script, an `onerror` handler and a `data:` script did not run; the hash matched the bytes sent on every path that renders the page. Wounds, all fixed: the test that guarded the script was a word list a one-line edit could pass, so the hash is now pinned as a literal; the one-script test missed tags with attributes; escaping was tested for the app name only; three sentences overstated the policy. Left as found, not made worse: the error re-render sends no `Cache-Control: no-store`, and `/register` accepts markup in an app name, which is escaped on the page.

## Checked in a browser
The page was served locally with its real headers. The Copy button appeared, which means the script ran under the policy, and the console showed no policy error. Where the browser refused clipboard access, the script selected the sentence and said so. A 390px screenshot is saved with the evidence for this change.
