# ADR 0011: M7: The model concierge (auto-routing over portable memory)

Status: Accepted 2026-07-10 (updated 2026-07-11) · M7a shipped v0.10.0-m7a; M7b (routing and ceiling) shipped v0.11.0-m7b; M7c (catalog phase) built 2026-07-11, remote feed still deferred; M7d in progress · Review: M7b adversarial review 2026-07-11, no CRITICAL/HIGH, medium findings fixed

## Context
People switch models weekly, and switching is worthless without their context. M6 Converse already provides many providers, `listModels()`, the `runTurn` pipeline, fail-closed `classifyEndpoint` and per-turn audit. M7 adds a concierge that picks the model while memory and privacy travel with the request.

## Decision
- D1: `route()` runs before `runTurn` and returns `RouteDecision = { endpointId, model, reason, privacyCeiling }`. `runTurn` is unchanged and still re-redacts the whole prompt at the effective tier; routing only chooses the endpoint. Only endpoints the user configured are selectable. The classifier uses the loopback Ollama model (llama3.2:3b) and degrades to keyword heuristics, then to the user's default. Routing never blocks or fails a turn.
- D2: Every conversation has a privacy ceiling, `private-only` or `bounded-allowed`; the router may only pick endpoints at or below it. If the best model is bounded but the chat is `private-only`, the concierge says so instead of escalating. The router `reason` is written to the audit row. Jay chose `bounded-allowed` (Tier-1 minimum) as the default on 2026-07-11.
- D3: The model catalog is versioned data, not code: per entry `{ id, aliases, providerKind, strengths, contextWindow, costTier, speedTier, privacyClass, notes }`, baseline in `packages/converse/src/catalog.ts` with a user override at `~/.northkeep/catalog.json`. Phase A is static, no network. Phase B (opt-in signed remote feed) is deferred to its own ADR and Jay's OK under invariant #7.
- D4: A per-reply badge (model, privacy tier), the reason on tap, manual override and pin.
- Review fixes (M7b): the CLI auto path re-checks the ceiling on the re-fetched endpoint; an unrecognised `ceiling` is a 400, not fail-open; the ceiling ratchets server-side (unpinning needs an explicit `bounded-allowed`); PUT /api/routing validates with `isRoutingRule` and caps at 100 rules; audit CSV carries `route_reason`; a model override cannot ride `endpoint_id: 'auto'`.

## Consequences
- Easier: automatic model choice, memory and redaction intact, every choice inspectable.
- Harder: a bad pick erodes trust (mitigated by rules first and visible override); a per-turn classifier adds latency; catalog staleness is inherent.
- Accepted: routing.json 0600 applies at creation only; dangling rules are skipped and marked; duplicate labels resolve to the first match.

## Rejected
- A NorthKeep-hosted routing service: routing stays fully local.

## What leaves the machine
The original has no egress section. It states routing is local, no query transits a NorthKeep server, and the deferred Phase B feed is the only new network surface. Under `bounded-allowed` the router itself may choose a bounded endpoint; redaction still runs. The review found `classifyEndpoint` on the actual `baseUrl` is the sole oracle, the web path double-enforces the ceiling, and `runTurn` clamps tier 0 to 1 toward bounded endpoints. `route_reason` is content-free by construction.

## Links
Full record: docs/design/adr-0011-model-concierge.md · Builds on: ADR 0008
