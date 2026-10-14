# ADR 0007: Converse: the mediated client and sanctioned outbound calls

Status: Accepted 2026-07-07 (M6) · Review: adversarial review 2026-07-07 one CRITICAL finding fixed before tag; three items accepted

## Context
MCP cannot intercept what the user types, so automatic redaction of outbound text is impossible inside Claude Desktop. M6 builds Converse, where each turn (`runTurn`) retrieves memory, redacts, calls the model, restores pseudonyms locally, distills memory and writes a content-free audit row. Converse is the enterprise product on BYOK keys or local models.

## Decision
- D1: The provider call sits strictly after redaction; no path sends unredacted text to a non-private endpoint. Bounded endpoints get Tier-1 minimum even if redaction is "off". Degraded Tier-2 toward a bounded endpoint aborts before sending (invariant #6); on a private endpoint it proceeds flagged `tier2Degraded`. Calls go direct to the provider; redaction models stay loopback (ADR 0003).
- D2: `classifyEndpoint` derives the tier from the canonical hostname: loopback, RFC-1918, link-local, private IPv6, `.local` and `localhost` are private; everything else, including unresolvable single-label names, is bounded. Fail closed. The badge shows on every message and audit row.
- D3: BYOK keys live in the macOS Keychain (service `northkeep-provider-key`) via `security -i` stdin; `providers.json` (0600) records only `hasKey: true`. Keys are never returned, logged or audited; errors carry HTTP status only. Without a Keychain, keys come from env vars only. A key for a plain-`http` public endpoint is refused.
- D4: Each exchange is distilled on-device, auto-stored, and shown as "N memories added" with one-click undo.
- D5: One networked dependency: `@anthropic-ai/sdk` for the optional native `AnthropicProvider` (default `claude-opus-4-8`), pre-approved by Jay. The OpenAI-compatible provider is raw `fetch` with `redirect:'error'`.
- D6 (review fix): sessions store history as plaintext and `runTurn` re-redacts the entire prompt at the effective tier every send, after stale wire-space history leaked prior plaintext on a private-to-bounded switch. The guard is fail-closed (`effectiveTier !== 0`). One accumulating `PseudonymMap` per session, mutated in place, keeps restore working; do not refactor it to copy.

## Consequences
- Limits: a bounded endpoint still receives redacted content (bounded privacy, provable from the audit log); absolute privacy is local/LAN. Retrieval is keyword-based; Tier-1 masks are one-way; transcripts are session-only.
- Accepted: the SDK path uses its own redirect policy, so `redirect:'error'` holds only for the universal provider; `/api/models?base=` fetches an arbitrary URL (token- and Host-gated, no key); `169.254/16` classifies private, flagged for any hosted deployment.

## Rejected
- Replaying redacted "wire space" history: it leaked plaintext across an endpoint switch.
- Silent Tier-2 to Tier-1 fallback toward a bounded endpoint: unapproved downgrade.

## What leaves the machine
The original has no egress section. It calls Converse invariant #1's sanctioned path: text goes directly to the provider the user selected, at least Tier-1 masked for bounded hosts. A private endpoint (loopback or LAN, including `169.254/16`) can receive unmasked text if redaction is off. NorthKeep never proxies or observes the call; distillation runs on restored plaintext that stays local.

## Links
Full record: docs/design/adr-0007-mediated-client.md · Related: ADRs 0002, 0003
