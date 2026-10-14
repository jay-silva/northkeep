# ADR 0030: web_search (Brave) and the tool-spend budget

Status: Accepted 2026-07-24 · Review: none recorded · Deciders: Jay (product owner), Claude Code

## Context
M10d adds a second egress tool, `web_search`, over the Brave Search API, and a budget that bounds what tool use costs. Unlike `web_fetch`, it carries a credential (the Brave token) to a fixed trusted host. Both sit behind the M10c gate and screens; this ADR records only what differs.

## Decision
- D1: `web_search` reuses the one hardened client, net.ts, via a purpose-named `authToken` bound to an `authorizedHost`, not a generic `headers` map. The token is attached only while the host equals `authorizedHost`, and any redirect on that path is refused. `web_fetch` never sets `authToken` and keeps its 5-hop manual redirect. The token never appears in the `egress()` URL, `argsPlain`, the gate prompt, the exfil screen input or the audit hash.
- D2: For `egressTrust: 'trusted-api'` tools, the catastrophic-secret hard-block (SSN/card/IBAN/API-key) still runs and the Tier-1 egress floor still masks literal PII; identity, memory and warn-class secret flags are dropped. Grants for `web_search` are allowed because the hard-block runs before the gate regardless. `web_fetch` is unchanged (`egressTrust: 'model-chosen'`, all classes screened).
- D3: Results (title, url, description) are fenced as untrusted external content, as a fetched page is (ADR 0028 decision 5).
- D4: A persisted daily call count per costed tool in `~/.northkeep/budget.json` (0600, tolerant loader), plus a small per-conversation cap. runTask checks it before a costed tool runs; over the cap the call is denied with `{error: 'budget_exceeded'}`, loud in transcript and audit. Tools without `costPerCallUsd` never touch it. Configurable and inspectable via `northkeep tools budget`.

## Consequences
- Easier: web search behind the same gate and screens as fetch; runaway loops bounded daily.
- Harder: identity and memory content in a query is not warned on; that is the feature.
- Limits: `MAX_STEPS = 10` bounds round trips, not tool calls, so the per-conversation cap is what bounds a costed tool; a free tool has only the step limit. The budget counts calls, not dollars; a dollar ledger is future work in KNOWN-LIMITS.

## Rejected
- A second HTTP client, or a generic `headers` map: weaker, harder-to-audit credential story.
- Following redirects with the header stripped: a trusted API that redirects is a signal.
- Identity/memory screening on search: Brave is not attacker-chosen, and constant warnings are permission fatigue (ADR 0029). A poisoned result URL is caught at `web_fetch`.
- A per-conversation dollar cap alone: cumulative spend is the uncovered risk.

## What leaves the machine
The original has no egress section. It states the query rides in the URL to api.search.brave.com after the secret hard-block, with the Tier-1 floor as a second layer, and the token rides in a header attached only for `authorizedHost`. Identity and memory content in a query is not screened. Following a result goes through `web_fetch`.

## Links
Parent: ADR 0028, ADR 0029 · Full record: docs/design/adr-0030-web-search-and-budget.md
