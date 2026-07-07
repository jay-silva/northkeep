# ADR 0007 — Converse: the mediated client and sanctioned outbound calls

- **Date:** 2026-07-07
- **Status:** Accepted (M6)
- **Deciders:** Jay (product owner; chose the two-track strategy and the mediated client), Claude Code

## Context

Through M4, Northkeep's memory reaches an AI only when the AI decides to call
our MCP tools — *assisted* memory. MCP cannot intercept what the user types,
so automatic redaction of outbound text ("the SSN never leaves the laptop
without me doing anything") is impossible from inside Claude Desktop. The only
way to put retrieval, redaction, restore, distillation, and audit on **every
message** is for Northkeep to mediate the model call itself.

M6 builds that: **Converse**, a purpose-built private client. The user talks
to a model *through* Northkeep, which on each turn retrieves memory, redacts
outbound text, calls the model, restores pseudonyms locally, distills new
memory, and appends a content-free audit row (`runTurn` in
`@northkeep/converse`). This deliberately crosses the old "memory browser,
not a chat surface" line — the differentiator is inline privacy and memory
transparency, not chat features.

Two-track strategy: consumers keep the cheap Claude-Desktop + MCP path (a
subscription can't be used programmatically); the mediated client is the
enterprise product for regulated practices, on BYOK API keys or zero-cost
local models.

## Decision 1: Outbound calls are the invariant-#1 sanctioned path

Invariant #1 says plaintext leaves the machine only "to the model provider
the user explicitly selected, after the active redaction tier has run."
Converse is the first surface where Northkeep itself makes that call, and it
enforces the sentence structurally:

- The provider call in `runTurn` sits strictly **after** the redaction step;
  there is no code path that sends unredacted text to a non-private endpoint.
- Endpoints classified **bounded** (any host not provably loopback/LAN) get
  **Tier-1 minimum**, even if the user set redaction to "off" — the setting
  is upgraded, never downgraded.
- If the user chose Tier-2 and it degrades (no local NER model) while the
  endpoint is bounded, the turn **aborts loudly before sending** (invariant
  #6). Degrading to Tier-1 silently would be a privacy downgrade the user
  didn't approve. On a private endpoint the same degrade proceeds but is
  flagged (`tier2Degraded`) — nothing left the machine either way.
- Calls go **direct client → provider**. Northkeep infrastructure never
  proxies, terminates, or observes the traffic.
- The redaction/extraction models themselves stay strictly loopback (the
  `ollamaUrl` guard from ADR 0003 is unchanged). Only the *chat* endpoint is
  user-pointable; the privacy machinery is not.

## Decision 2: Privacy tier is derived from the endpoint host, never claimed

`classifyEndpoint` maps the endpoint URL's canonical hostname to a tier:
loopback, RFC-1918, link-local, IPv6 ULA/link-local/mapped-private, `.local`,
and `localhost` are **private** ("nothing leaves your network"); everything
else — including unresolvable single-label names and tricky hosts like
`127.0.0.1.evil.com` — is **bounded** ("masked before send, provable from the
audit log"). Fail closed. The WHATWG URL parser canonicalizes numeric and
userinfo tricks before classification. The badge is shown on the picker and
on every message, and recorded in the audit row, so "which model" and "how
private" are one honest, visible choice.

## Decision 3: BYOK keys live in the Keychain, never in files

Endpoint API keys go to the macOS Keychain (service
`northkeep-provider-key`, account = endpoint id) via the same `security -i`
stdin pattern as the master key (ADR 0002). The endpoint config file
(`providers.json`, 0600) records only `hasKey: true`. Keys are never returned
by any API route, never logged, never in audit rows, and error messages carry
HTTP status only (responses can echo prompts; errors end up in logs). With no
Keychain (tests, non-macOS) keys come from env vars only — storing them in a
file is refused with instructions. A key for a plain-`http` public endpoint
is refused outright (it would cross the network unencrypted).

## Decision 4: Distillation is automatic, visible, and undoable

Each exchange is distilled into memory candidates on-device (loopback Ollama
extraction with heuristic fallback, reusing `@northkeep/librarian`), deduped
against the vault, and **auto-stored** — then surfaced as "N memories added"
with one-click undo (tombstone, per the M0 no-delete design). Auto-but-
visible-and-undoable satisfies "automatic memory" without the silent-write
trust problem the product guide warns about. Distillation runs on the
*restored* plaintext, which never leaves the machine.

## Decision 5: One new networked dependency (invariant #7)

`@anthropic-ai/sdk` becomes a runtime dependency of `@northkeep/converse`,
used solely by the optional native `AnthropicProvider` (streaming + adaptive
thinking; default model `claude-opus-4-8`). Jay pre-approved it in planning.
The universal OpenAI-compatible provider is raw `fetch` — no dependency —
and all local paths add nothing. The universal provider's raw fetches all set
`redirect:'error'` so a hostile redirect cannot re-send the prompt or the key
elsewhere; the native Anthropic path delegates transport to the SDK (default
host `api.anthropic.com`, classified bounded, so redaction runs regardless) —
see the adversarial-review notes below.

## Honest limits (KNOWN-LIMITS.md)

For a **bounded** endpoint, redacted content still reaches that provider —
this is *bounded* privacy, provable from the audit log, not "never leaves."
Absolute privacy is the local/LAN path. Retrieval is keyword-based (semantic
comes later); distillation quality tracks the small local model; Tier-1
masks are one-way by design (the model sees `[SSN_1]`, and so does the
transcript). Conversation logs are session-memory only — the vault stores
distilled memories, not chat transcripts.

## Adversarial review (2026-07-07)

The most rigorous review in the project (network egress + API keys). The
classifier was executed against 28 adversarial hosts; the turn pipeline,
session handling, key storage, and every API route were traced.

**One CRITICAL finding, fixed before tag — unredacted egress of prior-turn
plaintext on a mid-session endpoint switch.** The original design stored
conversation history in "wire space" (already redacted at the tier that
applied when each turn ran) and replayed it verbatim. A session started on a
*private* endpoint with redaction off stored plaintext; switching to a
*bounded* endpoint mid-conversation (an ordinary picker action) then
prepended that plaintext and sent it to the cloud provider **unredacted** —
a direct breach of invariant #1. **Fix:** the session now stores history as
plaintext and `runTurn` re-redacts the ENTIRE prompt (system + full history +
new message) at the *effective* tier on every send. History can therefore
never be replayed at a stale, weaker tier; mid-session swapping stays a
supported feature and is now safe. Regressed by a unit test (private→bounded
switch masks the stored secret) and re-verified in the live self-test with a
real endpoint swap. The redaction guard was also made fail-closed
(`effectiveTier !== 0`, not an `=== 1 || === 2` allowlist).

**Positive assurance (audited clean):**
- **No key-leak path.** No key field exists in `providers.json` (only
  `hasKey`); `withBadge` omits keys from every `/api/providers` response;
  `/api/models` returns model ids only; keys never appear in audit rows,
  logs, or error messages (provider errors carry HTTP status only). The
  `security -i` stdin path is injection-safe (id is `[a-z0-9-]`, keys reject
  CR/LF and are shell-quoted). `addEndpoint` stores the key before persisting
  config, so `hasKey` never lies.
- **No classifier misclassification of a public host as private.** Integer/
  hex/octal IPv4, `@`-userinfo, `127.0.0.1.evil.com`, `localhost.evil.com`,
  IPv4-mapped-public IPv6, NAT64, trailing-dot FQDNs, punycode — all classify
  bounded; every parse ambiguity fails closed to bounded.
- **Tier-2-degraded-toward-bounded aborts before send** (the `throw` precedes
  `provider.chat`; a denied audit row is written, nothing sent).
- **Ollama loopback guard intact**; distillation stays local; audit is
  content-free; `/api/converse` is behind the same token + Host-header gate
  as every route; all raw-fetch provider calls set `redirect:'error'`.

**Accepted, documented, not fixed:**
- The native Anthropic path delegates HTTP to `@anthropic-ai/sdk`, which
  applies its own redirect policy — so the blanket "all provider fetches set
  `redirect:'error'`" claim (§5) holds for the universal provider but not the
  SDK path. Real-world risk is low (default host `api.anthropic.com`,
  classified bounded so redaction runs regardless); noted here for accuracy.
- `/api/models?base=` fetches an arbitrary URL, but it is token- and
  Host-gated and attaches no key on that path — no exfil beyond what a token
  holder already has.
- Link-local `169.254/16` (incl. the cloud metadata IP) classifies private
  per the stated contract; harmless on a local-first desktop install, flagged
  for any future hosted deployment.
