# ADR 0005 — Redaction pipeline (Tier 1 + Tier 2)

- **Date:** 2026-07-05
- **Status:** Accepted (M3)
- **Deciders:** Jay (compliance domain owner; approved the plan), Claude Code

## Context

The product's promise is to let people use frontier AI on sensitive text
without leaking identifiers — honestly bounded. M3 builds the redaction
engine and exposes it where we actually control the data.

## Decision 1: Redaction is a tool the user routes text through — NOT an interceptor

NorthKeep hands memory to Claude Desktop over local stdio; Claude Desktop is
what calls Anthropic. We are not in that wire and will not pretend to scrub a
prompt we never see. So redaction ships as an explicit operation:
`northkeep redact` / `restore` (CLI, stdin-friendly) and a GUI **Redact**
panel (paste outbound text → masked copy → paste the model's reply → names
restored). This matches the "sell bounded privacy honestly" positioning and
avoids the overclaim the research community punishes.

Deeper integration (auto-redacting content returned over MCP; a
direct-to-provider proxy that redacts/ restores around the model call per the
product guide §4) is a **parked decision** for a later milestone — the engine
is identical either way. See the open-questions note.

## Decision 2: Two tiers, and Tier 2 degrades loudly

- **Tier 1 (always on, deterministic, ~ms):** regex detectors for email,
  phone (NA + international), US SSN, credit card (Luhn-validated), IPv4/IPv6,
  API keys / PEM private keys, IBAN. Numbered, consistent placeholders
  (`[SSN_1]`). One-way — the model never needs your real SSN. This is the
  **leak-test gate**.
- **Tier 2 (opt-in, on-device):** a local model (Ollama) does NER; people,
  orgs, and locations become stable pseudonyms (`Person-1`, `Org-2`) via a
  map, so text reads consistently and the response can be restored. Runs
  before Tier 1 (so it sees real names to classify); Tier 1 then sweeps the
  result. Without Ollama, Tier 2 is skipped and the result is flagged
  `tier2Degraded` — the CLI and GUI say so unmissably (invariant #6). Never a
  silent downgrade.

## Decision 3: Restore is asymmetric, mapping stays with the caller

Tier-2 pseudonyms are `restorable: true` and round-trip; Tier-1 secrets are
`restorable: false` and stay masked forever. The restore map is returned to
the caller (a `--map` file for the CLI, in-page state for the GUI) rather
than persisted server-side — least-privilege: no standing real→fake table on
disk unless the user saves one. (A vault-stored map for cross-session
pseudonym consistency is a future option, not M3.)

## Decision 4: The leak test is the CI gate

`packages/redact/test/leak.test.ts` runs a 50-seeded-secret corpus through
Tier 1 and asserts zero misses. A new `.github/workflows/ci.yml` runs it
first on every push/PR (per the blueprint: the leak gate lands with M3). A
real gap it caught during development — a UK-formatted phone number the
NA-shaped pattern missed — is exactly why the gate exists.

## Honest limits (stated, not fixed — KNOWN-LIMITS.md)

Tier 1 is ~99% on the identifier classes it targets, not a guarantee across
all formats. Tier 2 is 85–95% in-domain and degrades out-of-domain; a missed
entity is a leak, which is why Tier 1 always backstops. Neither tier removes
*contextual* identity ("the CFO whose wife works at the competitor") — we do
not claim Tier 3.

## Adversarial review (2026-07-05)

Reviewed with this milestone — maximally adversarial about detector gaps
since a miss is a real leak. Positive assurance: the overlap/placeholder
logic never leaves a partial-secret fragment; `restore()` longest-first
ordering is safe and never reintroduces a Tier-1 secret; `/api/redact` is
genuinely stateless (no vault access, nothing persisted/logged) and uses the
loopback-guarded Ollama client. The review found — and we fixed, each added
to the leak corpus as a regression first — four real leak classes the
original corpus didn't exercise: SSNs without dashes / with `.` or `/`;
credit cards separated by dots or Unicode spaces (NBSP/thin space, i.e.
pasted-from-document); **Stripe `sk_live_`/`rk_live_` keys** (underscore form
— only the OpenAI hyphen form was matched); JWTs; and compressed IPv6
(`fe80::1`, `::1`). Also fixed: Tier-2 now degrades loudly on non-JSON model
output instead of silently passing names through (invariant #6). IPv6 branch
ordering and a token-boundary guard prevent both partial matches and false
positives on `std::string`/clock times. Leak gate: 63 secrets, zero misses.

## Dependencies introduced

None. `@northkeep/redact` depends only on `@northkeep/librarian` (for the
existing loopback Ollama client). No new npm packages.
