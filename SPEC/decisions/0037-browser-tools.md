# ADR 0037: Browser tools

Status: PARKED 2026-07-26 by Jay; not being built, kept as a decision record (drafted 2026-07-25) · Review: adversarial review 2026-07-25 found the engineering claims in Decisions 1, 2 and 5 do not hold; the case for not building the obvious thing stands

## Context
ADR 0027 named browser tools alongside filesystem tools. Unlike `web_fetch`, a browser tool can act as the signed-in user, its dangerous acts may carry no revealing argument, and the page is both attacker and authenticated surface. This ADR argues the obvious version should not be built.

## Decision
- D1: Parked. Revisit only if design partners ask for it more than once, starting from a local CONNECT proxy (NorthKeep resolves, refuses private answers, dials the pinned address; TLS end-to-end; no DNS inside the browser), not the interceptor design.
- The drafted design, kept as the record:
  - Read-only v1 (navigate, extract text, screenshot) in an ephemeral profile with no cookies, credentials or extensions, discarded at turn end.
  - Navigation and subresources under `web_fetch`'s SSRF guard, failing closed. JavaScript runs.
  - No click, type, submit or download without a separate ADR and review: "an approval prompt that cannot describe what it is approving is not a gate. That is the blocking problem, not effort."
  - Results fenced as untrusted; the proof names every URL landed on, redirects included.
  - Engine choice (drive the user's browser or bundle one) is an invariant #7 decision needing Jay's explicit OK.

## Consequences
The review shows why it is parked:
- A browser owns its sockets, so `net.ts`'s DNS pin cannot carry over (H6). WebSockets, WebRTC, workers and prefetch escape an interceptor (H7).
- A bundled Chromium roughly triples an 80 MB app, adds a permanent CVE obligation, and by default makes unrequested requests (updater, Safe Browsing, OCSP, DoH) against invariant #5 (H8).
- Driving the user's browser means `--remote-debugging-port`, an unauthenticated control channel over a signed-in profile (H9).
- An empty profile does not remove authority in the URL (magic links, presigned URLs), network position (IP allowlists), or consequences of a visit; read-only is unenforceable at the HTTP layer (H10).
- Screenshots have no wire format through the redaction pipeline; they would be the first unredactable content channel to a provider (M1). Without a scheme allowlist, `file://` could reach what ADR 0036 protects (M2).
- Prerequisites before any code: drop "removes the entire category"; proxy plus launch flags; "bundle or don't ship"; https-only; screenshots out of v1; name the invariant #5 problem.

## Rejected
- Driving the user's own browser: unauthenticated control channel over a credentialed profile.
- Building the proxy plus bundled engine now: a large, permanent cost for client-side rendering, which `web_fetch` already approximates.

## What leaves the machine
The original has no egress section, and the feature is parked, not built. Per the review, had it shipped, screenshots would have been a provider-bound channel the redaction pipeline cannot process (M1).

## Links
Parent: ADRs 0027, 0029, 0036 · Full record: docs/design/adr-0037-browser-tools.md
