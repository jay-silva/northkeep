# ADR 0028: Web egress tools v1 (hardened web_fetch)

- **Date:** 2026-07-24
- **Status:** Accepted
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0027 (the agentic harness umbrella)

## Context

M10b gives the agent loop (runTask) its first real tool: fetching a public
web page. This is the first time the harness itself initiates a network
request to an arbitrary, model-chosen destination, which makes it the most
security-sensitive surface the product has grown so far. Three problems have
to be solved at once: the request must not be usable to reach private
infrastructure (SSRF), the fetched content must not be treated as
instructions (prompt injection), and whatever rides in the request must obey
the same redaction discipline as everything else that leaves the machine
(invariant #1).

## Decision 1: fetch first, search later

Tools v1 ships web_fetch alone. A fetch is the simplest possible egress: one
GET, one URL, no request body, and the URL is shown verbatim to the user at
the permission gate before anything moves. Web search (M10d) adds a
third-party API relationship (Brave Search is the planned provider) and will
ship under this ADR's framework: same hardened client, same egress tiering,
same gate, and per invariant #7 with no new npm dependency (the Brave API is
plain HTTPS + JSON, reachable with the same core-module client this ADR
describes). Nothing about search is decided beyond that framework here.

## Decision 2: the hardened client (tools/net.ts)

Every byte web_fetch moves goes through one file, with these guards:

1. **URL layer** (classifyFetchTarget): WHATWG parsing normalizes hostile
   spellings (0x7f.1, 2130706433, IPv4-mapped IPv6) before any check runs.
   Then: https only; no embedded credentials; ports 443 and 8443 only; and
   any IP-literal or name-based-local hostname (localhost, *.local) must
   classify PUBLIC. The IP classifier is the SAME code the privacy badge
   uses (classifyIpAddress, refactor-exported from provider.ts): loopback,
   RFC-1918, link-local (including 169.254.169.254), unique-local, ::1,
   0.0.0.0 and IPv4-mapped forms all refuse. One classifier, so the badge
   and the fetch guard can never disagree.
2. **DNS layer + pinned dial**: dns.lookup(host, all:true) runs first, and
   if ANY resolved address is private the fetch refuses (a mixed answer is
   what a rebinding or split-horizon attack looks like). The connection is
   then dialed TO THE EXACT VALIDATED ADDRESS via the custom `lookup`
   override that node:http/https requests support natively, while the Host
   header and TLS SNI carry the hostname. Node's global fetch offers no such
   hook without adding undici as a dependency, so the client is built on the
   core modules instead: zero new dependencies (invariant #7), and the
   classic TTL-0 DNS-rebinding race (validate address A, attacker re-answers
   B, client dials B) is closed rather than narrowed, because there is no
   second resolution to race. Honest residuals: only the first resolved
   address is dialed (no happy-eyeballs fallback), and a public server that
   proxies into someone's private network is that server's egress, not ours.
3. **Manual redirects**: every hop (five maximum) re-runs the URL guard, the
   DNS guard, and gets its own pinned dial. A public page redirecting to a
   metadata endpoint dies at the hop.
4. **Response hygiene**: content-type allowlist (text/html, text/plain,
   application/json, application/xhtml+xml, text/xml) checked before any
   body byte is read; a streamed 2 MB byte cap that destroys the socket
   mid-body and marks the result truncated; one 25 s deadline across all
   hops; a fixed User-Agent (NorthKeep/1.0); accept-encoding identity (no
   decompression bombs); and no cookie jar or Authorization path exists in
   the client at all.

Tests inject a resolver/classifier through a clearly marked TEST-ONLY seam
(NetTestOverrides), because the fixture servers live on loopback, which the
production guard categorically refuses. No production code path constructs
that object.

## Decision 3: zero-dependency HTML extraction (tools/extract-text.ts)

Fetched HTML is reduced to readable text by a ~200-line quote-aware lexer:
script/style/template/svg/head/noscript subtrees and comments are dropped,
links are kept as "text (url)", block tags become newlines, a small entity
set (named plus numeric) is decoded, whitespace is collapsed. Rationale: the
consumer is a language model, which tolerates imperfect extraction, while a
DOM/readability library would be a new dependency parsing the most
attacker-controlled input in the product (invariant #7: dependency count is
a metric to minimize). Upgrade path: the extractor sits behind one function
(extractText); if extraction quality ever matters more than the dependency,
a vetted readability library can replace the internals without touching the
tool or the loop.

## Decision 4: egress tiering, and the Tier-1 floor on tool arguments

ADR 0027 decision 1 applies: arguments bound for a tool are redacted at the
TOOL's egress tier, not the model's. Concretely, runTask restores the
model's argument JSON to plaintext locally (the gate must show real values,
the tool needs real values), classifies the tool's egress URL with the same
classifyEndpoint the chat path uses, and, for a bounded destination, applies
the deterministic Tier-1 pass (applyTier1) to every string leaf of the
arguments before execute. web_fetch's egress is always bounded (the URL
guard refused anything private), so in v1 the floor always applies. The full
policy engine over tool arguments (name screens, per-site memory) is ADR
0029 territory and lands in M10c; this milestone ships the floor, not the
engine.

## Decision 5: fetched content is fenced data, never instructions

Tool results enter the transcript wrapped in fence markers carrying a
per-task random nonce, with zero-width and bidi control characters stripped
and any fence-lookalike text inside the content collapsed, plus one system
prompt line stating that fenced content is data and instructions found there
must not be followed. This does not make prompt injection impossible (the
model still reads attacker text; KNOWN-LIMITS.md says so plainly), but it
makes the trust boundary explicit and unforgeable by content, and it is the
substrate the M10c/M10e hardening builds on.

## Decision 6: the fail-closed placeholder gate

Until the ADR 0029 permission engine lands in M10c, the gate implementation
is placeholderGate: every call, whatever the tool or risk class, answers
"ask", so nothing executes without the user seeing the exact restored
arguments and approving. An unanswered approval denies after five minutes.
Fail closed per invariant #6: the placeholder never auto-allows and never
silently denies, and the audit log writes one content-free row per call
(sha256 of URL and arguments, byte counts, decision), denials included.

## Consequences

- The harness can now reach the public web, read-only, behind a per-call
  human gate, with the strongest SSRF posture achievable without new
  dependencies.
- The registry (~/.northkeep/tools.json) ships everything disabled; enabling
  a tool is an explicit CLI act, and the CLI opt-in flag (converse --tools)
  is required on top of it.
- web_search (M10d) and the real permission engine (M10c) both slot into
  seams this ADR defines, not into new machinery.
