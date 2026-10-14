# ADR 0028: Web egress tools v1 (hardened web_fetch)

Status: Accepted 2026-07-24 · Superseded in part 2026-07-25 (M10d) by ADR 0030 Decision 1 (opt-in `AuthToken` header path) · Review: none recorded

## Context
M10b gives runTask its first tool: a fetch to a model-chosen destination. It must block SSRF, treat fetched content as data not instructions, and redact per invariant #1.

## Decision
- D1: Tools v1 ships `web_fetch` only; `web_search` (M10d, Brave) follows under this framework, no new npm dependency.
- D2: One hardened client, `tools/net.ts`. URL layer (`classifyFetchTarget`): WHATWG parsing; https only; no embedded credentials; ports 443 and 8443 only; IP literals and local names must classify PUBLIC via `classifyIpAddress` (shared with the privacy badge): loopback, RFC-1918, link-local incl. 169.254.169.254, unique-local, ::1, 0.0.0.0, IPv4-mapped all refuse.
- D3: DNS layer: `dns.lookup(host, all:true)`; any private address refuses. The dial is pinned to the validated address via the node:http/https `lookup` override, closing the TTL-0 rebinding race.
- D4: Manual redirects, max five, each hop re-checked and re-pinned.
- D5: Response hygiene: content-type allowlist (text/html, text/plain, application/json, application/xhtml+xml, text/xml) before any body byte; streamed 2 MB cap (marked truncated); one 25 s deadline across hops; User-Agent `NorthKeep/1.0`; accept-encoding identity; no cookie jar. ADR 0030 later added a credential path, `AuthToken` (header only, set by a registered tool never the model, never logged or shown).
- D6: A zero-dependency lexer (`tools/extract-text.ts`) reduces HTML to text.
- D7: Arguments are redacted at the tool's egress tier (ADR 0027): runTask restores them to plaintext locally, classifies the egress URL with `classifyEndpoint`, and for a bounded destination applies `applyTier1` to every string leaf. For `web_fetch` the floor always applies. The full policy engine is ADR 0029 (M10c).
- D8: Results are fenced with a per-task random nonce (zero-width/bidi stripped, lookalike fences collapsed) and a system line saying fenced content is data.
- D9: Until ADR 0029's engine lands (M10c), `placeholderGate` answers "ask" for every call; unanswered approvals deny after five minutes. The audit log writes one content-free row per call (sha256 of URL and arguments, byte counts, decision).

## Consequences
- Committed to: `~/.northkeep/tools.json` ships all tools disabled; enabling is an explicit CLI act plus `converse --tools`.
- Limits: fencing does not make prompt injection impossible (stated in KNOWN-LIMITS). Only the first resolved address is dialed. A public server proxying into a private network is that server's egress. A TEST-ONLY seam (`NetTestOverrides`) exists; no production path constructs it.

## Rejected
- Node global fetch: no pinned dial without undici.
- A readability library: a dependency parsing the most attacker-controlled input.

## What leaves the machine
The original has no egress section. It describes a fetch as "one GET, one URL, no request body", the URL shown verbatim at the gate, up to five redirect hops, string arguments through the Tier-1 floor, and no cookie jar. Its 2026-07-25 note adds that `web_search` may send a provider token in a header (ADR 0030).

## Links
Parent: ADR 0027 · Engine: ADR 0029 · Amended by: ADR 0030 · Full record: docs/design/adr-0028-web-egress-tools.md
