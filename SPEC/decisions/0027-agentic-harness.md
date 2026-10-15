# ADR 0027: Converse becomes a privacy-first agentic harness (umbrella)

Status: Accepted 2026-07-24 (Jay approved plan and gating) · Review: none in this record; the M10 review amended it 2026-07-25 (the Tier-1 floor applies to tool-bound arguments, not the whole conversation); ADR 0029 owns the security review

Superseded in part by ADR 0066 (accepted 2026-10-15): Converse is no longer presented as a product mode.

## Context
Converse (ADR 0007) is a mediated pipeline with one destination: the model the user picked. Tools v1 is web search and web fetch, read-only public-internet egress.

## Decision
- D1: One principle for every crossing: everything arrives as plaintext, is stored as plaintext, and is redacted per destination at send time. The prompt is re-redacted at the effective tier every send; nothing redacted is stored and replayed. Model-produced tool arguments arrive in wire space and are restored before the tool executes. Tool results are stored plaintext and re-redacted on later sends. Tool-bound arguments are redacted at the tool's egress tier, not the model's.
- D2 (planned here, specified in ADR 0029): No restore on egress: restoring happens only for a local consumer (the user's screen, a tool executing under the permission gate), never into content leaving the machine.
- D3 (planned here, specified in ADR 0029): Tier-1 floor on tool-bound arguments, even at Tier 0 on a private endpoint. Enabling tools does not raise the conversation's tier: `task.ts` derives `effectiveTier` from the endpoint alone.
- D4: Provider layer (M10a): `ChatMessage` widened in place (role `'tool'`, `toolCalls`, `toolCallId`) so `turn.ts` keeps one redaction path; explicit wire mappings. `chat` wraps `chatTurn`. `ToolCallRequest.arguments` is raw JSON, never parsed or repaired by providers.
- D5: No prompt-parsing fallback. A model without native tool calls gets no tools; refusal surfaces as `TurnError('TOOLS_UNSUPPORTED')`. The `toolCapable` flag is a hint only.
- D6: Milestones: M10a plumbing; M10b `runTask` loop, bounded iterations; M10c permission gate showing exact restored arguments, audit per call; M10d web tools (ADR 0028); M10e ADR 0029 review before the flag defaults on; M11 MCP, filesystem and browser tools, each behind its own ADR.

## Consequences
- Harder: tool-incapable models get no tools.
- Limits: the URL itself says what the user is interested in. Prompt injection via fetched content is owned by ADR 0029.

## Rejected
- Raising the whole conversation to Tier 1 when tools are on: masks a local Tier 0 prompt that never leaves, buying no privacy.
- A separate agent message type: a second place to forget redaction.
- Regex-scraped tool calls: a gate over guessed arguments is theater.

## What leaves the machine
The original has no egress section. Its honest-limits section states tool use widens the egress surface by design: a web fetch is a real network request, and argument redaction protects identifiers, not intent. Its amendment says the Tier-1 floor that exists applies to tool-bound arguments where they egress. M10a is described as plumbing with no user-visible behaviour change.

## Links
Extends: ADR 0007 · Companions: ADR 0028, ADR 0029 · See also ADR 0031
Full record: docs/design/adr-0027-agentic-harness.md
