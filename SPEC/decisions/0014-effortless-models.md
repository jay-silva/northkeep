# ADR 0014 — Effortless models: guided onboarding, local install, branded launcher

- **Date:** 2026-07-12
- **Status:** Accepted (M9)
- **Deciders:** Jay (product owner; chose curated+escape-hatch, the provider list, guide-to-install Ollama, branded launcher), Claude Code

## Context

The concierge (M7) routes across models, but *setting them up* is
developer-shaped: adding a hosted model is a bare `label + URL + key + model`
form with no guidance, cost is invisible, and using a local model assumes the
user already installed Ollama and pulled a model. Real-usage feedback: a
substantive message routed to the tiny 3B model and confabulated — because
setup, model choice, and cost were all opaque. M9 makes model setup effortless
for a non-engineer and gives NorthKeep a branded front door.

## Decision 1: A branded CLI launcher (M9a — shipped)

Bare `northkeep` opens a branded home: the ASCII keep logo, a live status block
(vault locked/unlocked + memory count, default model + count, local-AI/Ollama,
sync, connected apps), the commands laid out, then a prompt where a typed
command runs as a subprocess and Enter drops into chat. Status gathering never
prompts for a passphrase (`resolveMasterKey` ambient-key only). Colors degrade
to plain when not a TTY / under `NO_COLOR`. The global `northkeep` command is a
`~/.local/bin` symlink (already on PATH). (`packages/cli/src/{ui,launcher}.ts`,
root `.action()` in `index.ts`.)

## Decision 2: Guided frontier onboarding — curated registry + escape hatch (M9b)

A curated **known-providers registry** (`provider-catalog.ts`,
`KNOWN_PROVIDERS`) drives a guided "Connect a model" flow: pick a provider →
"how to get an API key" (a real link + 2–3 steps) → secure paste → pick a model
(curated list, cost shown) → test → added. Each provider entry carries `id,
name, kind, baseUrl, keyUrl, keySteps, keyPrefix?, models[]`. First-cut
providers: **Anthropic, OpenAI, Google (Gemini), xAI (Grok), OpenRouter, Meta
(Llama)**. All but Anthropic are OpenAI-compatible.

The existing freeform "add any endpoint" form stays as the **advanced escape
hatch**. Rationale: we can only *walk a user through* providers we know, and the
cost/strength metadata only exists for catalogued models — so curated is the
easy path, freeform is the power-user door.

**No new secret-handling surface:** the key still flows through the audited
`addEndpoint({apiKey})` → Keychain (`northkeep-provider-key`) path (ADR 0008);
never in `providers.json`, responses, or logs. Key-prefix validation is *soft*
(warn, don't block — formats drift).

## Decision 3: Cost is shown, roughly (M9b)

The catalog already carries `costTier`; M9 surfaces it. `costLabel(tier)` →
`{symbol, range}`: Free (local) / $ (~$0.15–0.60/1M) / $$ (~$1–5/1M) / $$$
(~$5–15+/1M), always labeled *approx*. Shown in the model picker, the endpoint
list, and routing reasons. Exact per-request accounting is out of scope — rough
tiers only.

## Decision 4: 1-click local-model install, hardware-matched (M9c)

If Ollama isn't installed, **guide** the user to install it (ollama.com link +
`brew install ollama`) — we do NOT auto-install a background daemon. Once Ollama
is present, a hardware-matched 1-click pull: `detectHardware()` (RAM + chip via
`node:os`) → `recommendLocalModel()` (RAM→size: <8→3B, 8–16→3B, 16–32→7B,
32–64→14B, 64+→32B) → "Your Mac (chip, RAM) can run <model> — Install" →
`OllamaClient.pull()` streams `POST /api/pull` NDJSON progress (loopback-only,
Invariant #1) with the import-job progress pattern → auto-`addEndpoint`. New
`ollamaState()` distinguishes not-installed / no-models / ready (the old
single-boolean `available()` couldn't).

## Decision 5: The concierge suggests a model you haven't connected (M9d)

`suggestBetterModel(message, configuredEndpoints)` — when the catalog's
strongest model for the classified task isn't among the configured endpoints, a
non-nagging suggestion ("coding question — Claude Opus would handle this better;
connect it?") surfaces subtly in the Converse provenance strip (GUI) and the
per-turn status line (CLI). Deterministic, dismissable, ties the catalog +
routing + guided-add together.

## Invariant #7 (networked deps) — no new mechanism, no new SDK

The new frontier providers add **no new network mechanism**: they reuse the
already-sanctioned user-configured-endpoint outbound (ADR 0007/0008). All new
providers are **OpenAI-compatible**, so they use the existing
`createOpenAICompatibleProvider` — **no new SDK dependency** (`@anthropic-ai/sdk`
already covers Claude). Ollama `pull` stays loopback-locked. Hosted endpoints
classify `bounded`, so the redaction firewall (Invariant #1) applies unchanged —
the guided flow shows the bounded badge honestly.

## Consequences & honest limits (KNOWN-LIMITS)

- **macOS-first:** hardware detection, Ollama detection, and the config paths are
  macOS-shaped; other platforms come later.
- **Curated ≠ exhaustive:** unlisted models still work via the advanced form;
  they just aren't guided or cost-labelled until catalogued.
- **Cost is approximate** (tiers, not per-request accounting).
- **Local install needs Ollama** (guided, not auto-installed) and the disk/RAM
  for the recommended model.

## Provider registry — verified values (2026-07, web-checked)

Live in `provider-catalog.ts`; model ids drift — re-verify each milestone.

| Provider | kind | base URL | get a key | prefix |
|---|---|---|---|---|
| Anthropic | anthropic | `api.anthropic.com` | console.anthropic.com/settings/keys | `sk-ant-` |
| OpenAI | openai-compat | `api.openai.com/v1` | platform.openai.com/api-keys | `sk-` |
| Google Gemini | openai-compat | `generativelanguage.googleapis.com/v1beta/openai` | aistudio.google.com/apikey | `AIza` |
| xAI Grok | openai-compat | `api.x.ai/v1` | console.x.ai | `xai-` |
| OpenRouter | openai-compat | `openrouter.ai/api/v1` | openrouter.ai/keys | `sk-or-` |
| Meta Llama | openai-compat | via **OpenRouter** (`meta-llama/*`) | openrouter.ai/keys | `sk-or-` |

**Meta/Llama decision:** Meta wound down its first-party Llama API (2026); no
cleanly-available OpenAI-compatible `api.llama.com`. So "Meta Llama" is
represented **hosted via OpenRouter**, scoped to `meta-llama/*` model ids
(documented in `provider-catalog.ts`). Revisit if Meta ships a stable
first-party endpoint.

## Acceptance test (Jay-runnable) — see the M9 ship checklist.

## Adversarial review (2026-07-12)

Focused review of API-key handling + the local-install path. **Verdict: safe to
ship — nothing at CRITICAL/HIGH/MEDIUM.** Confirmed: no key is ever returned,
logged, filed, put in a URL/GET, or embedded in an error — it routes only through
the audited `addEndpoint → Keychain` (`security -i` stdin) path; `withBadge`
carries `has_key` + a `cost_tier` enum, never a key. Local install is
loopback-locked (`ollamaUrl()` refuses non-loopback, `redirect:'error'`), the
`model` tag is charset-validated (no `/`, no shell/URL injection), the post-pull
auto-add hardcodes the localhost baseUrl (an attacker tag can't steer it
off-machine), and the job id is a server UUID. M9d suggestion is isolated
(own try/catch) and content-free. GUI renders all provider/model/cost text via
textContent; `keyUrl` is https-guarded before becoming an href. Transport
hardening (loopback bind, Host check, per-request token, CSP) covers the new
routes. **Fixed:** re-pulling a local model no longer creates a duplicate
endpoint (one entry per model). Accepted LOW/INFO: pull jobs TTL-evict rather
than delete-on-success (no secrets); `/api/local/status` exposes a device
fingerprint to the token-authed local caller only.
