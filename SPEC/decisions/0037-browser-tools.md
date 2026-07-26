# ADR 0037: Browser tools

- **Date:** 2026-07-25
- **Status:** Proposed
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0027 (harness umbrella), ADR 0029 (harness security model), ADR 0036 (filesystem tools)

## Context

ADR 0027 named browser tools alongside filesystem tools. The public roadmap lists
them as Exploring. This ADR exists to say what they would have to be — and to
argue that the obvious version should not be built.

### Why this is not "web_fetch with a renderer"

`web_fetch` retrieves a document as an anonymous client. A browser tool drives a
**browser**, and the whole value people want from it comes from the thing that
makes it dangerous: **it acts as the signed-in user.** Your session cookies, your
saved cards, your authenticated admin panels, your bank.

That difference is categorical, not incremental:

- `web_fetch` can read what anyone can read. A browser tool can read what *you*
  can read.
- `web_fetch` cannot change anything. A browser tool can click Send, Confirm,
  Delete, Transfer.
- The exfiltration screens inspect an argument. A browser tool's dangerous act
  may take **no revealing argument at all**: "click the button at (412, 380)"
  discloses nothing to a screen and could be Delete Account.
- Prompt injection stops being about content the model *reads* and becomes about
  content that tells the model what to *do* while holding the user's session. The
  page is both the attacker and the authenticated surface.

Nothing in the M10/M11 machinery addresses that last point, because nothing built
so far could take an action on the user's behalf.

## Decision 1: read-only, in a profile with no credentials

v1 is a **reading** tool: navigate, extract text, screenshot. No clicking, no
typing, no form submission, no file upload, no downloads.

It runs in a **dedicated, ephemeral browser profile with no cookies, no saved
credentials, no extensions, and no access to the user's real profile**, discarded
at the end of the turn. In other words: it is deliberately *not* signed in as the
user, which removes the entire category above.

This is a smaller feature than people ask for, and it is the only version whose
risk this codebase can currently argue about honestly. It buys the genuine
majority use case — "read this page properly, including the parts `web_fetch`
cannot see because they render client-side" — at roughly `web_fetch`'s risk
profile rather than at a new one.

## Decision 2: everything the network layer already refuses, it still refuses

A browser makes many requests, not one, and it follows redirects, loads
subresources and runs scripts that fetch more. So:

- Navigation targets go through the **same SSRF guard** as `web_fetch`: resolve,
  refuse any private answer, pin. A browser that can reach `192.168.1.1` or
  `169.254.169.254` is an internal-network proxy with a scripting engine.
- **Subresource loading is constrained** to the same rules. This is the hard
  part: enforcing it means a request interceptor, not a URL check at navigation
  time, and it must fail closed if the interceptor cannot attach.
- **JavaScript runs**, because that is the point of using a browser at all. That
  is a real concession and it is why the profile is empty and ephemeral: the
  blast radius of a hostile page is a throwaway context, not the user's session.

## Decision 3: no action tools until there is a separate ADR and review

Clicking, typing, submitting and downloading are **out of scope**, and adding
them later requires:

- its own ADR arguing the gate for an action whose arguments do not describe its
  effect;
- an adversarial review specifically of the injection path, because approving
  "click (412, 380)" is not informed consent;
- a decision about whether the user's real profile is ever usable, which this ADR
  recommends against and which would need to answer what "approval" means when
  the model is authenticated as the user.

Recording the reason here so a future implementer does not read the omission as
an oversight: **an approval prompt that cannot describe what it is approving is
not a gate.** That is the blocking problem, not effort.

## Decision 4: results carry provenance, and are fenced

- Extracted text and screenshots are **fenced as untrusted**, like any tool
  result.
- The proof names **every URL the browser landed on**, including redirects, not
  just the one requested. A page that bounces you somewhere else must be visible.
- Screenshots are treated as content: they may contain anything the page showed,
  and they go to whichever model answers.

## Decision 5: dependency posture

A browser engine is a very large dependency with its own update cadence and CVE
stream, which strains the standing rule to prefer boring, audited dependencies
and minimize their count. Two options, and this ADR does not pick:

- **Drive a browser the user already has** (a local automation endpoint). No new
  engine shipped, but the connection surface needs its own trust story, and the
  user's real browser is exactly the credentialed context Decision 1 avoids.
- **Bundle an engine.** Clean isolation, at the cost of a large binary in a
  currently 80 MB app and an ongoing patch obligation.

Whichever is chosen is an invariant #7 decision requiring Jay's explicit OK,
because it is a new networked dependency of substantial size.

## Honest limits

- A read-only browser still executes hostile JavaScript in a sandbox we do not
  own. The profile is empty, but the process is real.
- Client-side rendering means the tool sees what a script chose to show it; a
  page can serve different content to an automated client, and often does.
- Screenshots are expensive in tokens and hard to screen: an exfiltration screen
  cannot read an image, so a page could render text as pixels and the screens
  would see nothing. **This is unmitigated** and is the strongest argument for
  keeping text extraction the default and screenshots explicit.
- Without action tools this will not do what many people mean by "browse for me".
  That is intentional and should be said plainly in the UI rather than implied
  away.

## Acceptance test (when built)

1. Navigating to a private address, a `.internal` host, or a public name that
   resolves private is refused, exactly as `web_fetch` is.
2. The browser has no access to the user's cookies: a page that requires login
   shows a logged-out view.
3. Extracted text is fenced, and the proof lists every URL landed on, redirects
   included.
4. No tool exists that clicks, types, submits or downloads.
5. A page that redirects mid-navigation shows both URLs in the proof.
