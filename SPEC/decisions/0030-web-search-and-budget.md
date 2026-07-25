# ADR 0030: web_search (Brave) and the tool-spend budget

- **Date:** 2026-07-24
- **Status:** Accepted
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0028 (web egress tools), ADR 0029 (harness security model)

## Context

M10d adds the second egress tool, `web_search`, over the Brave Search API,
and the budget engine that bounds what tool use can cost. Two things are new
versus web_fetch: the call carries a CREDENTIAL (the Brave subscription
token) to a fixed trusted host, and a costed tool needs a spend guard. Both
sit behind the M10c gate and screens; this ADR records only what differs.

## Decision 1: credential on the one hardened client, not a second client

web_search reuses net.ts (invariant #7: one egress code path, one SSRF
story). net.ts's "no credential path by construction" is preserved for the
web_fetch case and relaxed for exactly one, auditable seam:

- A purpose-named option (`authToken` bound to an `authorizedHost`), NOT a
  generic `headers` map. A generic map would downgrade the guarantee to "no
  credentials unless a caller passes some," which every future caller must
  remember to avoid; a single named seam is greppable and hard to misuse.
- The token is attached ONLY while the request host equals `authorizedHost`.
- On the credentialed path, a redirect is REFUSED, not followed with the
  header stripped: a fixed trusted API that 302s is a signal, not something
  to chase. (web_fetch keeps its 5-hop manual redirect; the credentialed
  search path does not redirect at all.)
- web_fetch NEVER sets `authToken` — the model-chosen-URL path stays
  credential-free, exactly as before.

The token is injected inside the client only. It MUST NOT appear in the
tool's `egress()` URL, in `argsPlain`, in the gate prompt, in the exfil
screen input, or in the audit hash. The query rides in the URL; the token
rides in the header; they never mix.

## Decision 2: web_search screens for SECRETS only, not identity/memory

The M10c exfil screens exist because a hijacked model can paraphrase vault
content into a URL bound for an ATTACKER-chosen host (the web_fetch threat).
A search query goes to api.search.brave.com — a trusted third party the
attacker does not control — so the paraphrase-exfiltration rationale does not
transfer. Therefore, for a tool whose egress is a fixed trusted API
(`egressTrust: 'trusted-api'`):

- The catastrophic-secret hard-block still runs (SSN/card/IBAN/API-key): we
  do not want those in Brave's query logs even by accident, and the Tier-1
  egress floor already masks literal PII toward bounded egress as a second
  layer.
- Identity and memory (and warn-class secret) flags are DROPPED. "Search for
  my doctor Carol Mansfield" is the feature, and warning on every such query
  is exactly the permission fatigue ADR 0029 calls a security failure. The
  real downstream risk — a poisoned result URL the model then FETCHES — is
  caught at the web_fetch stage (its own SSRF guard, gate, and fence),
  regardless of how the URL was found.

With identity/memory screening off, grants for web_search are safe: the one
protection that must survive a grant — the secret hard-block — runs before
the gate regardless, so a silently granted search still cannot ship an SSN.
web_fetch is unchanged (`egressTrust: 'model-chosen'`, all classes screened).

## Decision 3: results are fenced untrusted data

Brave results are SEO-influenceable (a hostile page can rank for a term), so
the result list (title, url, description per hit) is fenced as external
content exactly like a fetched page (ADR 0028 decision 5) before the model
sees it. The model reading a result is not the model trusting it.

## Decision 4: the budget — a persisted daily call cap

Brave's free tier is 2,000 queries/month at 1 query/second ($0); paid tiers
bill per query. The genuinely uncovered risk is CUMULATIVE spend/quota across
many conversations — a single conversation is loosely bounded by the agent
loop's step limit (MAX_STEPS = 10), so a per-conversation dollar cap is
nearly redundant with it. (Precisely: MAX_STEPS bounds model round TRIPS, not
tool calls; one step may carry several calls, so the per-conversation cap below
is what actually bounds a costed tool within a conversation. A free tool has no
per-conversation call bound at all, only the step limit.) The budget is therefore a PERSISTED daily
call-count per costed tool (`~/.northkeep/budget.json`, same 0600 tolerant-
loader idiom as the grants file), plus a small per-conversation cap as a
fast local bound.

Enforcement lives in runTask, BEFORE a costed tool executes: if the day's
count for that tool has reached the cap, the call is denied with a structured
`{error: 'budget_exceeded'}` result the model sees, loud in the transcript
and audit (invariant #6 — never a silent stop). Free tools (no
`costPerCallUsd`) never touch the budget. The cap is configurable and
inspectable (`northkeep tools budget`). A count, not a dollar estimate, is
the honest unit for the free tier and still bounds spend on a paid tier; a
true dollar ledger is future work noted in KNOWN-LIMITS.

## Consequences

- The harness can search the public web behind the same gate and screens as
  fetch, with the subscription token confined to a single named seam and one
  host.
- Runaway or hostile tool loops are bounded in cost by a persisted daily cap,
  not just the per-conversation step limit.
- web_search's results feed the existing web_fetch path for any follow-up
  fetch, so no new SSRF surface is introduced by "search then open."
