# ADR 0011 — M7: The model concierge (auto-routing over portable memory)

- **Date:** 2026-07-10 (updated 2026-07-11)
- **Status:** **Accepted** — M7a shipped v0.10.0-m7a; M7b (routing + ceiling) shipped v0.11.0-m7b; M7c (catalog phase: rules > catalog strengths/cost/speed > default, baseline in packages/converse/src/catalog.ts + user override at ~/.northkeep/catalog.json, remote feed still deferred) built 2026-07-11. M7d in progress.
- **Deciders:** Jay (product owner; this is his consumer-side vision; chose the `bounded-allowed` default ceiling 2026-07-11), Claude Code

## Context — the vision

Frontier and open models now ship faster than any power user can track; people
flip between ChatGPT, Claude, Fable, Kimi, GLM, Grok, Perplexity's router, and
local runtimes weekly, and the churn is the pain. A widely-shared July 2026 post
by Jason Calacanis captured the want: an app that integrates everything and
**"automatically swaps through these models"** (attributed, X.com). Jay sees this
as NorthKeep's consumer story.

The critical thing that post misses: **swapping models is worthless if your
context doesn't come with you.** Move from Claude to Kimi mid-project and you
normally restart from zero. NorthKeep already carries a portable, encrypted
memory vault into every model, and a redaction firewall that lets you fan out to
many providers safely. So we are not chasing a router; we are building the one
thing that makes routing *usable* — a **concierge**: it picks the model, and
your memory and privacy travel with the request.

## What already exists (M6 Converse — the substrate)

M7 is additive on top of shipped, tested code. Do not rebuild it.

- **Provider abstraction** (ADR 0008, `packages/converse/src/provider.ts`):
  `ModelProvider` with `chat()` + `listModels()`; a universal
  OpenAI-compatible provider reaches every local runtime and hosted open-model
  API; a native Anthropic provider covers Claude. Adding a model = adding an
  endpoint; nothing else changes.
- **Model discovery**: providers already enumerate available models
  (`/v1/models`, `/api/tags`) via `listModels()`.
- **The turn pipeline** (`turn.ts` `runTurn`): retrieve → compress → assemble →
  redact → call → restore → distill → audit. It is already provider- and
  model-parameterized (`TurnOptions.provider`, `.model`).
- **Privacy tiering** (`classifyEndpoint`): every endpoint is classified
  `private` (can't leave the machine/LAN) or `bounded` (someone else's computer,
  masked first), fail-closed, from *where it lives* — never from a config claim.
- **Endpoint config** (`settings.ts` `EndpointConfig`: `id, label, baseUrl,
  model, kind`); keys live in the Keychain, never in files.
- **The audit log** already records `endpoint_host`, `model`, `privacy`, and
  `redaction_tier` per turn — the raw material for a "which model answered this,
  and how private was it" UI.

So capability #1 (**one app, many models**) is done. M7 adds capability #2
(**automatic swapping**) and #3 (**a living catalog**), plus consumer polish.

## Decision 1 — Routing is a pre-step that chooses `(provider, model)`; `runTurn` is untouched

Introduce a `route()` function that runs **before** `runTurn` and returns the
`(provider, model, privacyCeiling)` for this turn. `runTurn` keeps its exact
contract — it still receives a concrete provider + model and still re-redacts the
whole prompt at the effective tier before the call. **The redaction invariant
(#1) and degrade-loudly (#6) are entirely preserved**: routing only *chooses*
the endpoint; it never touches the send path.

```
route(message, session, policy, catalog, endpoints) → RouteDecision
  RouteDecision = { endpointId, model, reason, privacyCeiling }
        ↓
runTurn({ provider: providerFor(endpointId), model, redactTier, ... })   // unchanged
```

Router inputs: the message, a **task classification** (code / reasoning /
quick-fact / creative / vision / long-context), the user's **policy** (rules +
preferences + the privacy ceiling), model **metadata** from the catalog, and the
set of **configured endpoints** (only models the user actually has access to are
selectable). Router phases (see Phasing) go from a static default, to
user-authored rules, to a local-classifier pick, to cost/quality-aware policy.

The task classifier reuses infrastructure we already run: the loopback Ollama
model (llama3.2:3b) that already does extraction and Tier-2 redaction. A routing
classifier is its sibling and, like it, must **degrade gracefully** — no Ollama
⇒ fall back to keyword heuristics ⇒ fall back to the user's default endpoint.
Routing must never block or fail a turn; the worst case is "used your default."

## Decision 2 — The privacy ceiling: auto-routing must NEVER silently escalate a private conversation

This is the load-bearing privacy decision and the one genuinely new risk M7
introduces. Today the human picks the endpoint, so the human owns the
private→bounded choice. Once a router can pick, it could send a query the user
considered private to a bounded frontier model. Redaction still runs (invariant
#1 holds), but **choosing to leave the machine at all is a privacy act the user
must own.**

Rule: every conversation carries a **privacy ceiling** — `private-only` or
`bounded-allowed` — and the router may only select endpoints at or below it.
- Default ceiling is a user setting; the safe default is `bounded-allowed` with
  Tier-1 minimum (today's behavior), but a conversation can be pinned
  `private-only` (local models only) and the router is then **forbidden** from
  choosing any bounded endpoint, even if it would answer better.
- Escalation is **explicit and visible**: if the best model for a task is bounded
  but the ceiling is `private-only`, the concierge tells the user "this would be
  better on <hosted model>; you've pinned this chat to private" rather than
  silently escalating. Never auto-cross the tier boundary.
- The audit log already proves what happened (`privacy`, `endpoint_host`); the
  router's `reason` is added to the row so every automatic choice is
  after-the-fact inspectable.

## Decision 3 — The model catalog is versioned *data*, curated and user-editable, not code

Discovery gives us *which* models an endpoint offers; it cannot tell us *what
each is good at*. The catalog supplies that metadata so the router can choose
well and so new models surface without the user hunting.

- **Shape** (`SPEC/model-catalog.json`, shipped in-repo, versioned): per entry
  `{ id, aliases, providerKind, strengths: tag[], contextWindow, costTier,
  speedTier, privacyClass: 'local' | 'hosted', notes }`. `strengths` tags:
  `code, reasoning, vision, long-context, cheap, fast, creative`.
- **It is data, not code** — updatable without a release, and the user can edit
  or override it (add a model we haven't catalogued, retag one). Unknown models
  the user has configured still work; they're just routed by user rules /
  defaults until catalogued.
- **Staying current** is the ongoing-maintenance cost, phased:
  - *Phase A (default):* ship a curated static catalog; the user edits it. No
    network.
  - *Phase B (opt-in):* fetch catalog updates from a **signed, content-only**
    catalog URL. This is a **new networked dependency → invariant #7: its own
    ADR + Jay's explicit OK before building.** It must be opt-in, signature- or
    hash-verified, content-free (no telemetry, invariant #5), and never a
    condition for the app to function offline.
- The catalog carries **no secrets and no user data** — it is public model
  metadata, safe to ship in the OSS repo.

## Decision 4 — Consumer trust comes from transparency, not magic

"Headless / automatic" must not mean "opaque." The concierge picks, but the user
always sees **who answered and how private it was**, and can override:

- A per-reply badge: model name + privacy tier (we already compute and audit
  both). One tap to see *why* this model was chosen (the router `reason`) and to
  re-run on a different model.
- A visible **manual override** and a **pin** ("always use X for this chat").
  Automatic by default; never a cage.
- The existing audit view becomes the honest ledger of every automatic decision.

This is the differentiator over a black-box router: NorthKeep routes *and* shows
its work, with your memory and PII protection intact.

## Scope

**In (M7):** the `route()` pre-step and `RouteDecision`; a task classifier
(local-model + heuristic fallback); the privacy-ceiling setting and enforcement;
the static model catalog + user overrides; per-endpoint model selection from
discovery; the "who answered / why / override / pin" UX in the Converse tab and
CLI; audit `reason` field; phased rollout below.

**Out (M7):** the opt-in remote catalog fetch (deferred to its own ADR under
invariant #7); a NorthKeep-hosted routing service (routing stays 100% local — no
new server, no query ever transits us); multi-model "ask 3, merge" ensembles;
automatic *account/billing* provisioning for third-party providers; fine-tuned
or learned routing policies (start rule/heuristic, learn later).

## Phasing

- **M7a — Quick-switch.** Per-endpoint model dropdown populated from
  `listModels()`; fast manual model/endpoint switch mid-conversation; per-reply
  "who answered + privacy" badge. Pure UX over existing capability; no router
  yet. Ships value immediately and de-risks the UI.
- **M7b — Rule/classifier routing.** `route()` + `RouteDecision`; user-authored
  rules (task/tag → endpoint) first, then the local-model task classifier;
  privacy ceiling enforced; audit `reason`. This is the "automatically swaps"
  headline.
- **M7c — Living catalog + policy.** Static catalog with metadata; routing by
  strengths + cost/speed tier within the ceiling; surface newly-configured or
  newly-catalogued models. (Remote catalog fetch still deferred.)
- **M7d — Consumer polish.** Take the Tauri shell toward a real consumer app
  (onboarding, the concierge as the default surface). Product/design-led; the
  engine is done by M7c.

## Invariant interactions (must hold)

- **#1 (redaction before send):** untouched — routing is strictly upstream of
  `runTurn`, which still re-redacts the whole prompt at the effective tier.
- **#2 (server stores ciphertext only):** untouched — routing is local; no query
  transits any NorthKeep server.
- **#5 (no telemetry):** the task classifier, router, and catalog emit nothing;
  a future remote catalog fetch must be content-free.
- **#6 (degrade loudly):** no Ollama ⇒ heuristic routing, announced, never a
  silent quality drop; a private-ceiling chat that can't reach a bounded model
  is told, not escalated.
- **#7 (networked deps need an ADR + Jay's OK):** the Phase-B remote catalog is
  the only new network surface and is explicitly deferred to its own decision.

## Risks & open questions

- **Routing quality vs. simplicity.** A bad automatic pick erodes trust fast.
  Mitigation: rules/heuristics first (predictable), classifier second, always
  with a visible override. Start conservative — route only when confident, else
  default.
- **Task classification cost/latency.** Running a local classifier per turn adds
  latency. Mitigation: cheap heuristics for obvious cases (code fences → code
  tag), classifier only when ambiguous; cache per-conversation intent.
- **Catalog staleness** is inherent; Phase A leans on user edits, Phase B on an
  opt-in signed feed. Neither may break offline use.
- **Privacy-ceiling default.** Open question for Jay: ship the default ceiling as
  `bounded-allowed` (convenient, today's behavior) or `private-only`
  (maximally safe, but the concierge can't use frontier models until the user
  opts in)? Recommendation: `bounded-allowed` + Tier-1 minimum, with a prominent
  one-tap "make this chat private."

## Adversarial review — M7b (2026-07-11)

Focused on Decision 2 (the ceiling). **No CRITICAL/HIGH**: `classifyEndpoint`
on the actual `baseUrl` is the sole oracle on every path (never a label or
config claim); the web path double-enforces (route filter + a final check on
the re-fetched endpoint object before anything is sent); `runTurn`
independently re-classifies and clamps tier 0→1 toward bounded, so even a raw
API caller cannot get unredacted content off-machine. `route_reason` is
content-free by construction (task-kind enum + endpoint labels + fixed
strings; the classifier returns an enum, so message text cannot reach it).

**Fixed from the review:** (M-1) the CLI auto path now re-checks the ceiling
on the re-fetched endpoint object, mirroring the web path; (M-2) an
unrecognized `ceiling` value is a loud 400 instead of a silent fail-open to
bounded; (M-3) the ceiling now **ratchets server-side on the conversation** —
once pinned, an omitted field keeps the pin, and unpinning takes an explicit
`bounded-allowed` (the GUI always sends the ceiling explicitly); PUT
/api/routing validates with the loader's own `isRoutingRule` (a 200 means
every rule is live), normalizes to known fields, and caps at 100 rules; the
audit CSV now carries `route_reason`; a model override cannot ride
`endpoint_id: 'auto'`.

**Accepted (documented):** routing.json 0600 applies at creation (same
posture as providers.json; rules only, no secrets); dangling rules after an
endpoint removal are skipped and marked in `routing list`; duplicate labels
resolve to the first match on `:endpoint` (classification runs on the real
URL either way).

## Acceptance test (Jay-runnable, when M7 lands)

1. Configure ≥3 endpoints (e.g. local Ollama, Claude, one hosted open model).
2. Ask a coding question, a quick factual question, and a "summarize this long
   doc" — confirm the concierge routed each to a sensible model (the badge shows
   which), and the reply used your vault memory.
3. Pin a conversation to **private-only**; ask something the router would prefer
   a hosted model for — confirm it stays local and *tells you* it could do
   better hosted, rather than silently leaving the machine.
4. Override a pick mid-chat; confirm memory + context carried across the switch
   with no re-explaining.
5. Inspect the audit log: every turn shows model + privacy + the router's reason;
   no query ever went to a NorthKeep server.
