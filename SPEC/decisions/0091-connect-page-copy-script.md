# ADR 0091: The connect page may run one script, pinned by its hash

Status: Accepted 2026-11-24 (Jay: "We can loosen that security policy.") · Review: CLEARED WITH WOUNDS, fixed

## Context
The page an app opens to connect takes the pairing code and grants access. Its policy forbids every script (`default-src 'none'`). ADR 0084 D2 put a sentence on that page for people to paste into apps that ignore NorthKeep's instruction. Without a script they must select it by hand. Jay approved a mock with a Copy button.

## Decision
- D1: The page carries one inline script, a constant in `consent.ts`. It unhides the Copy button, and on a click copies the sentence, or selects it when the browser refuses.
- D2: The policy adds `script-src 'sha256-…'`, the hash of that constant, computed where the header is built. Nothing else is added: no `unsafe-inline`, no `unsafe-eval`, no `unsafe-hashes`, no host.
- D3: The script reads no form field, makes no request and writes no HTML. A test pins its hash as a literal, so any edit to the script fails until a person changes the test.
- D4: The page has no inline event handlers, which the policy would block anyway.
- D5: The button is hidden until the script runs. If it never runs, the page works as before: a tap still selects the sentence.

## Consequences
- Easier: one tap copies the sentence on the page where a new person connects their first app.
- Harder: changing the script changes its hash; the header and the page are built from the same constant, so they cannot drift, and a test compares them.
- What an attacker gains: nothing we can find. A script injected through the app's name is escaped, and if it were not, it would not match the hash. The page still cannot fetch, load an image or open a frame (`default-src 'none'`). It can post its form and navigate, as before.
- Not changed: `form-action` stays unset, as before. Restricting it would break the redirect back to the app in some browsers.

## Rejected
- `script-src 'unsafe-inline'`: lets any injected script run.
- A script file on our own host: adds a route and lets `'self'` scripts run.
- No button (PR 92 as first built): works, but is the step a new person is likeliest to skip.

## What leaves the machine
Nothing new. The script copies text already on the page to the person's own clipboard.

## Links
Review record: docs/design/adr-0091-connect-page-copy-script.md · Builds on: ADR 0084 D2 (PR 92) · Extends: ADR 0019 (hosted connector, connect page)
