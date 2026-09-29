# ADR 0008 — Protocol-based, swappable model providers

- **Date:** 2026-07-07
- **Status:** Accepted (M6)
- **Deciders:** Jay (explicit requirement: model- and runtime-neutral, swappable by design), Claude Code

## Context

The Converse client (ADR 0007) must not couple "local model" to any one
runtime. The chat model must be whatever the user points at — DeepSeek, GLM,
Qwen, Llama, Claude, GPT — running on Ollama, LM Studio, vLLM, llama.cpp
server, text-generation-webui, a self-hosted LAN box, or a hosted API. As
better open models appear and an org has the hardware, they repoint one
endpoint and nothing else changes. Model neutrality is architecture, not a
feature flag.

## Decision 1: One universal provider speaking the OpenAI-compatible protocol

Nearly every runtime and hosted open-model API exposes
`/v1/chat/completions` and `/v1/models`. So the primary provider is
**`OpenAICompatibleProvider`** (`packages/converse/src/openai.ts`): raw
`fetch`, no dependency, configured by **base URL + model id + optional API
key**. That triple is the *entire* swap mechanism. Streaming via SSE
(`stream: true`); model discovery via `GET /v1/models` with a fallback to
Ollama's native `/api/tags` for runtimes that only offer that. Base URLs are
normalized (`…/`, `…/v1` accepted).

## Decision 2: A small `ModelProvider` interface, everything else behind it

`ModelProvider` is `{kind, baseUrl, chat(messages, {model, onToken, signal}),
listModels()}` (`provider.ts`). `runTurn` takes an injected provider; the
GUI, CLI, and tests construct whichever implementation the endpoint config
names. Fakes implement it in five lines, which is how the turn loop's
redaction guarantees are unit-tested.

## Decision 3: Optional native Anthropic provider

**`AnthropicProvider`** (`anthropic.ts`, via `@anthropic-ai/sdk` — the M6
dependency, ADR 0007 §5) gives the best Claude experience: true streaming and
adaptive thinking, default `claude-sonnet-5-5` (since 0.22.3). It is a quality nicety, not a
requirement — Claude is also reachable through OpenAI-compatible gateways if
the user prefers zero dependencies.

## Decision 4: The host→tier classifier lives beside the interface

`classifyEndpoint` (see ADR 0007 §2) is part of this package so that *every*
surface deriving a privacy badge derives it the same way, from the same
parsed hostname, fail-closed. Providers never self-declare privacy.

## Consequences

- Adding a runtime or hosted vendor requires **no code** — it's an endpoint
  config row (label, base URL, model, optional Keychain key).
- Endpoint configs persist in `providers.json` under `NORTHKEEP_HOME` (0600);
  key storage per ADR 0007 §3.
- A future non-OpenAI-compatible protocol (if one ever matters) is a third
  `ModelProvider` implementation, invisible to `runTurn` and the surfaces.
