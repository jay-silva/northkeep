# ADR 0027: Converse becomes a privacy-first agentic harness (umbrella)

- **Date:** 2026-07-24
- **Status:** Accepted
- **Deciders:** Jay (product owner; approved the harness plan and the milestone gating), Claude Code

## Context

Converse today is a mediated chat pipeline (ADR 0007): retrieve, redact, call,
restore, distill, audit, once per message, with exactly one destination (the
model endpoint the user picked). The next step for the product is letting the
model DO things on the user's behalf: fetch a page, run a web search, and
later reach MCP tools, the filesystem, or a browser. That turns Converse into
an agentic harness, and it multiplies the security problem: content no longer
crosses one boundary (user to model) but many (model to tool, tool to model,
model to model on later turns), and each crossing is a place plaintext could
leak.

Tools v1 is deliberately small: web search and web fetch, both read-only
egress to the public internet. MCP tools, filesystem access, and browser
control come later, each behind its own review. This ADR is the umbrella for
the whole harness effort: it fixes the governing privacy principle, records
the provider-layer design that milestone M10a ships, and maps the milestones.
Two companion ADRs are forthcoming: ADR 0028 (the web egress tools
themselves) and ADR 0029 (the harness security model in full detail).

## Decision 1: one principle governs every boundary crossing

ADR 0007's invariant generalizes from one destination to N destinations:

**Everything crossing the harness boundary arrives as plaintext, is stored as
plaintext, and is redacted per destination at send time.**

Concretely:

- Conversation history stays plaintext in the session (unchanged from ADR
  0007) and the whole prompt is re-redacted at the effective tier on every
  send. Nothing already-redacted is ever stored and replayed; a weaker tier
  must never ride along to a stronger destination.
- Tool arguments produced by a bounded model arrive in WIRE SPACE (the model
  only ever saw pseudonyms and masks, so its arguments contain them). The
  harness restores them to plaintext before the tool executes, because the
  tool needs real values to do real work.
- Tool results arrive as plaintext, are stored as plaintext in the
  transcript, and are re-redacted on every later send to a model, exactly
  like user messages.
- Arguments bound for a TOOL are redacted at that tool's egress tier, not the
  model's. A web fetch leaves the machine, so what rides in the URL or the
  request body is subject to redaction policy for that egress, independent of
  which model asked for it.

Every crossing is therefore governed by the same sentence, and the redaction
path stays single (see Decision 3).

## Decision 2: planned invariants for tool-enabled turns (detailed in ADR 0029)

Two rules are decided in principle now so nothing in M10a paints us into a
corner; ADR 0029 specifies them precisely before any tool executes:

- **No restore on egress.** Restoring pseudonyms or masks happens only for a
  local consumer (the user's screen, a tool executing on their behalf under
  the permission gate). No code path may restore plaintext into content that
  is about to leave the machine for a model or any other remote destination.
- **Tier-1 floor on tool-bound ARGUMENTS.** Arguments headed for a tool are
  redacted at Tier 1 minimum even when the conversation runs at Tier 0 on a
  private endpoint, because tool egress (a web fetch) can leave the machine
  regardless of where the model lives.

  > **Amended 2026-07-25 (M10 review).** This bullet originally read "a
  > conversation with tools enabled runs at Tier 1 minimum," which was never
  > implemented and is NOT what shipped: `task.ts` derives `effectiveTier` from
  > the endpoint alone (`privacy === 'bounded' && redactTier === 0 ? 1 :
  > redactTier`), so enabling tools does not raise the conversation's tier. The
  > floor that exists is the argument-level one above, applied where the
  > arguments actually egress. That is the deliberate design: raising the whole
  > conversation would mask secrets in the prompt sent to a LOCAL model the user
  > chose at Tier 0 — a real utility cost on exactly the workflows Tier 0
  > exists for — while buying no privacy, since that prompt never leaves the
  > machine. What leaves is the tool call, and that is what the floor covers.
  > ADR 0031's "Security properties" section describes this argument-level floor
  > correctly.

## Decision 3: the provider layer (shipped by M10a, this milestone)

M10a gives providers the ABILITY to express tool calls, with zero
user-visible behavior change. The design choices, and why:

- **`ChatMessage` is widened in place**, not forked. The role union gains
  `'tool'`, assistant messages gain optional `toolCalls`, tool messages gain
  `toolCallId`. Rationale: the redaction loop in `turn.ts` iterates one
  `ChatMessage[]`; a parallel "agent message" type would be a second place to
  forget redaction, and the whole security argument rests on there being one
  path. Providers map internal messages to their wire shapes explicitly
  (`toOpenAIWire`, `toAnthropicTurns`), so an internal field can never leak
  onto the wire by default, and a tool message can never be silently dropped
  by a role filter.
- **`chatTurn` alongside `chat`.** `chatTurn(messages, options)` returns
  `{ text, toolCalls, stopReason }`; `chat` remains for every text-only
  caller and is a thin wrapper over `chatTurn`, so each provider has exactly
  one wire parser. `ToolCallRequest.arguments` is the raw JSON text as the
  model emitted it: providers transport it faithfully and never parse or
  repair it; validation belongs to the harness, next to the permission gate.
- **`ToolSpec` is JSON-Schema shaped**, the same shape MCP's `listTools`
  returns, so MCP tools plug into the same plumbing later without a
  conversion layer.
- **No prompt-parsing fallback for models without native tool support.** A
  model that cannot emit structured tool calls gets no tools; the runtime
  signal is the endpoint refusing a tools-bearing request, surfaced as
  `TurnError('TOOLS_UNSUPPORTED')`, loud per invariant #6. Rationale:
  permission-gate integrity. A gate the user trusts must show the EXACT
  arguments that will execute; arguments scraped out of free text by a
  regex are a guess, and a gate over guessed arguments is theater. The
  catalog's `toolCapable` flag is a routing and UI hint only; enforcement is
  the runtime refusal, never the hint.

## Milestone map

- **M10a (this ADR's shipping milestone):** provider-layer plumbing. Types,
  wire mappings, SSE tool-call accumulation, `TOOLS_UNSUPPORTED` in the
  error union, `toolCapable` catalog hints. No loop, no tools, no behavior
  change.
- **M10b:** the `runTask` agent loop (model, tool, model, ...) with bounded
  iterations, built on `chatTurn`.
- **M10c:** the permission gate: per-tool, per-conversation consent, exact
  restored arguments shown before execution, audit rows per tool call.
- **M10d:** tools v1, web search and web fetch (ADR 0028), behind the gate.
- **M10e:** hardening pass and the ADR 0029 security review before the
  feature flag defaults on.
- **M11:** MCP client-side tools (the vault's own MCP server first),
  filesystem and browser tools each behind their own ADR.

## Honest limits (KNOWN-LIMITS.md discipline)

Tool use widens the egress surface by design: a web fetch is a real network
request, and redaction of tool-bound arguments protects identifiers, not
intent (the URL itself says what the user is interested in). The permission
gate and the audit log make that visible per call; ADR 0029 owns the full
threat analysis, including prompt-injection via fetched content, before any
tool ships enabled.
