# ADR 0014: Effortless models: guided onboarding, local install, branded launcher

Status: Accepted (M9) 2026-07-12 · Review: adversarial review 2026-07-12, safe to ship, nothing at CRITICAL/HIGH/MEDIUM · Deciders: Jay (product owner), Claude Code

## Context
Model setup was developer-shaped: a bare `label + URL + key + model` form, invisible cost, and local models assumed Ollama. In real use a message routed to the 3B model and confabulated. M9 makes setup effortless for a non-engineer and adds a branded front door.

## Decision
- D1 (M9a, shipped): bare `northkeep` opens a branded home with a live status block and a prompt. Status gathering never prompts for a passphrase (`resolveMasterKey` ambient key only). The global command is a `~/.local/bin` symlink.
- D2 (M9b): a curated `KNOWN_PROVIDERS` registry in `provider-catalog.ts` drives a guided "Connect a model" flow. First-cut providers: Anthropic, OpenAI, Google (Gemini), xAI (Grok), OpenRouter, Meta (Llama). Meta Llama is hosted via OpenRouter (`meta-llama/*`) because Meta wound down its first-party API. The freeform form stays as the advanced escape hatch. Keys flow only through the audited `addEndpoint({apiKey})` to Keychain (`northkeep-provider-key`) path (ADR 0008); key-prefix validation warns, never blocks.
- D3 (M9b): `costLabel(tier)` shows rough tiers, always labelled approx: Free (local), $ (~$0.15 to 0.60/1M), $$ (~$1 to 5/1M), $$$ (~$5 to 15+/1M).
- D4 (M9c): if Ollama is missing, guide the user to install it (ollama.com, `brew install ollama`); never auto-install a daemon. Then `detectHardware()` and `recommendLocalModel()` (RAM <8 and 8 to 16 GB: 3B, 16 to 32: 7B, 32 to 64: 14B, 64+: 32B) offer a 1-click `OllamaClient.pull()` over loopback, then auto-`addEndpoint`. `ollamaState()` distinguishes not-installed, no-models, ready.
- D5 (M9d): `suggestBetterModel()` deterministically and dismissably suggests a stronger catalogued model not yet connected.
- Invariant #7: no new network mechanism and no new SDK. Providers other than Anthropic are OpenAI-compatible (`createOpenAICompatibleProvider`); Claude uses the existing `@anthropic-ai/sdk`; hosted endpoints classify `bounded`, so redaction applies unchanged.

## Consequences
- Limits: macOS-first (hardware, Ollama detection, config paths). Curated is not exhaustive; unlisted models work via the advanced form, unguided and without cost labels. Cost is approximate. Local install needs Ollama and the disk/RAM for the model. Model ids drift; re-verify each milestone.
- Review fixed: re-pulling a model no longer duplicates the endpoint. Accepted LOW/INFO: pull jobs TTL-evict; `/api/local/status` exposes a device fingerprint to the token-authed local caller only.

## Rejected
- Freeform form only: only catalogued providers can be guided and cost-labelled.
- Auto-installing Ollama: we do not install a background daemon for the user.
- New provider SDKs: OpenAI-compatible reuse avoids new dependencies.

## What leaves the machine
The original has no egress section; its invariant #7 note states no new network mechanism. Hosted providers use the existing user-configured-endpoint outbound (ADR 0007/0008) under the redaction firewall. Ollama pull is loopback-locked (`ollamaUrl()` refuses non-loopback, `redirect:'error'`), and auto-add hardcodes the localhost baseUrl. The suggestion is content-free. Keys are never returned, logged, filed, put in a URL, or embedded in an error.

## Links
Builds on: ADR 0007, ADR 0008

Full record: docs/design/adr-0014-effortless-models.md
