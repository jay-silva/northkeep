# ADR 0037: Browser tools

- **Date:** 2026-07-25
- **Status:** Proposed — **sound as a statement of restraint, not sound as a
  specification.** An adversarial review on 2026-07-25 found the engineering
  claims in Decisions 1, 2 and 5 do not hold. See "Adversarial review" at the
  end; the six listed corrections are prerequisites to any code.
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


## Adversarial review — 2026-07-25

Run under the CLAUDE.md review gate, against code at `5b6158b`. Recorded here
rather than in a commit message, and corrected rather than softened. **Verdict:
the argument for *not* building the obvious thing is excellent and should ship
largely as-is. The engineering claims are the weak part.**

### High

**H6 — "the same SSRF guard as `web_fetch`" is not achievable by a browser.**
`packages/converse/src/tools/net.ts:16-28` is explicit about why its guarantee
holds: the connection is *dialed to the exact validated address* via a custom
`lookup` override, "which is why this file uses the core modules" — Node's
global fetch cannot do it. A browser engine does its own DNS and dials its own
sockets; CDP's `Fetch.requestPaused` hands you a **URL, not a socket**. So
"resolve, refuse any private answer, pin" is two-thirds achievable and the
missing third is the one carrying the guarantee. Concretely: navigate to a
public host with a TTL-0 record, page script re-fetches the same host, it now
answers `127.0.0.1`, and the browser reaches Ollama on 11434 or any local dev
server. The NorthKeep GUI itself holds (`apps/web/src/server.ts:54` Host check,
`:76` constant-time token, `:122` loopback bind), but "one app on this machine
checks its Host header" is not a story this ADR gets to lean on for the whole
machine. Partial mitigation worth naming: Chrome's `--host-resolver-rules` pins
host→IP per launch, coarsely, and does not extend to hosts the page introduces.
*Adopt it and say what it does not cover, or drop the parity claim.*

**H7 — "must fail closed if the interceptor cannot attach" is not expressible
for several real request classes.** WebSockets do not fire `requestPaused` (you
get `Network.webSocketCreated`, an observation after the fact). WebRTC
negotiates over UDP/STUN entirely outside the HTTP stack and must be disabled at
launch, not intercepted. Service workers, dedicated workers, OOPIFs and popups
are new CDP targets that can issue requests before the interceptor attaches
unless `Target.setAutoAttach` is used with `waitForDebuggerOnStart` and
`flatten`. `navigator.sendBeacon` and `<a ping>` fire on unload. DNS prefetch,
`preconnect` and HTTP/3 racing contact the network before any interception — the
DNS query alone leaks the hostname. *Correction: change the architecture, not the
wording.* Launch the engine with its network surface disabled and route every
byte through a **NorthKeep-owned local proxy** running `net.ts`'s classifier. A
proxy is the only architecture in which Decision 2's title is literally true,
and it restores the pin from H6. Interception becomes a second layer, not the
first.

**H8 — a bundled engine phones home, and invariant #5 is never mentioned.**
Decision 5 names size and CVEs. The larger cost for this product is omitted:
Chromium in its default configuration makes requests NorthKeep never asked for —
component updater, Safe Browsing lists, OCSP/CRL, DoH probes, variations seed,
favicon fetches. That sits directly against invariant #5 ("No telemetry. None.")
and against a product position that privacy claims are verifiable. It is the
strongest argument available inside this ADR's own frame. Add it, and make H7's
flag set a stated precondition of the bundle option.

**H9 — Decision 5 option A opens an unauthenticated control channel; close it.**
"A local automation endpoint" means `--remote-debugging-port`, an
**unauthenticated** HTTP + WebSocket control channel on loopback. Any local
process can enumerate targets; `Page.navigate` plus `Runtime.evaluate` against a
signed-in profile is total account compromise, and it is the same loopback
surface H6 shows a rebound page can reach. This ADR notices the contradiction
and then leaves the option open, which a future implementer reads as permission.
*Narrow Decision 5 to "bundle or don't ship."*

**H10 — "removes the entire category" is too strong.** An empty profile removes
the cookie- and credential-authenticated category. It does not remove **authority
carried in the URL itself** (magic links, password resets, one-click
unsubscribe, calendar accept links, presigned S3/GCS URLs — navigating one
*consumes or acts on* it with no cookie at all), nor **authority derived from
network position** (a SaaS with an IP allowlist has a public IP and passes every
test in `classifyIpAddress`; it is authenticated by the fact that *this machine*
reached it), nor **consequence of the visit itself** (read receipts, tracking
pixels, view counters, lockout counters). This is also the answer to whether
"read-only" is enforceable: **it is not, at the HTTP layer.** A GET is a
state-change primitive on the open web; "safe method" is a convention servers are
free to ignore.

### Medium

**M1 — screenshots are not merely "hard to screen"; there is no wire format for
them.** `ChatMessage` is `{ role, content: string, toolCalls?, toolCallId? }`
(`provider.ts:42-49`) — no image part exists — and `task.ts:337-414` re-redacts
the *entire* prompt at the effective tier on every step. A screenshot cannot ride
that path. Shipping them means the **first content channel to a model provider
that the redaction pipeline cannot process**, which under invariant #1(a) and the
review gate is a decision, not a line in "Honest limits". KNOWN-LIMITS L243-245
already stakes out the opposite position ("Images and embedded resources from a
server show as `[image content omitted]`… another content channel we have not
screened"), and this ADR would reverse it without arguing it. *Recommendation:
screenshots out of v1.* Related and missed: extracted text and rendered pixels
can **disagree** — CSS `content:`, `visibility:hidden`, off-screen positioning,
`aria-label`, canvas glyphs, remapped web fonts — so the fenced text and the
image become two different documents and an injection can live in the one the
fence does not cover. And once, generally: **the exfil screens never inspect tool
results, only arguments** — true for `web_fetch` too, but this ADR's phrasing
implies otherwise.

**M2 — no scheme allowlist, and `file://` would hand back everything ADR 0036
protects.** This ADR never says the browser cannot navigate
`file:///…/vault.nkv`, nor `data:`, `blob:`, `about:`, `view-source:`,
`filesystem:`, `chrome://`, `devtools://`. `classifyFetchTarget` answers `file:`
only if the browser is actually forced through it, and answers none of the
internal schemes, which never leave the process. *State the allowlist (https
only) explicitly.* As written these two ADRs are one `page.goto('file://…')`
apart from contradicting each other.

**M4 — "every URL the browser landed on" under-reports by an order of
magnitude.** "Landed on" reads as top-level navigations; a page makes hundreds of
subresource requests to dozens of hosts. List every **host contacted**, deduped
with a count (content-free, audit-compatible), or rename the claim. Two mechanics
defeat a naive implementation: `history.pushState` changes the URL with no
request, and JS/`<meta refresh>` chains may not surface through `frameNavigated`.

**M6 — acceptance test 2 does not test the thing that matters.** "A page that
requires login shows a logged-out view" passes trivially in an empty profile and
proves nothing about the real risk, which is option A reaching the *real*
profile. Assert on the launch instead: fresh profile directory under a temp path,
deleted at turn end, no `--user-data-dir` under `~/Library/Application Support/`.
Then add a network-posture test — a fixture page that opens a WebSocket, starts
WebRTC and registers a service worker; assert all three are refused (H7).

### Low

**L2 — no KNOWN-LIMITS obligation, and this ADR would falsify live entries.**
L163-165 ("fetch is https-only, ports 443/8443, GET, no cookies, **ever**"),
L127-131 (the documented upgrade path from the lexer is "a vetted readability
library", explicitly *not* a browser engine), L243-245 (images omitted, see M1),
L300-305. ADR 0033:92 set the precedent for naming the obligation in the ADR.

### What survives, stated plainly

**Decision 1's core instinct** — ephemeral, credential-free, discarded at turn
end — is the right design; only the "removes the entire category" claim
overreaches. **Decision 3** survives intact, and its closing sentence is the best
paragraph in either ADR: *"an approval prompt that cannot describe what it is
approving is not a gate. That is the blocking problem, not effort."* Preserve it
verbatim; it is the sentence that generalizes. **Decision 5's framing** of the
engine as an invariant #7 decision needing Jay's explicit OK is correct.

### Prerequisites before any code

1. Drop "removes the entire category"; state what an empty profile does and does
   not remove, including that read-only is unenforceable at the HTTP layer (H10).
2. Replace the interceptor story with proxy-plus-launch-flags (H7), or accept the
   reduced claim and say the `net.ts` DNS pin is unachievable (H6).
3. Close Decision 5 to "bundle or don't ship" (H9).
4. Name the scheme allowlist and refuse `file:` (M2).
5. Move screenshots out of v1 pending the wire-format decision (M1).
6. Add the invariant #5 phone-home problem to Decision 5 (H8).
