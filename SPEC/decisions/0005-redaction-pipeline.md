# ADR 0005: Redaction pipeline (Tier 1 + Tier 2)

Status: Accepted 2026-07-05 (M3) · Review: adversarial review 2026-07-05; four leak classes found and fixed · Corrected 2026-09-24 (release 0.22.0 doc-vs-code pass): Tier 1 list updated per ADR 0059

## Context
The promise is frontier AI on sensitive text without leaking identifiers, honestly bounded. M3 builds the redaction engine and exposes it where NorthKeep actually controls the data. NorthKeep hands memory to Claude Desktop over local stdio, and Claude Desktop calls Anthropic, so NorthKeep is not in that wire.

## Decision
- D1: Redaction is a tool the user routes text through, not an interceptor: `northkeep redact` / `restore` (CLI, stdin-friendly) and a GUI Redact panel (paste outbound text, get a masked copy, paste the reply, names restored). Auto-redacting MCP output or a direct-to-provider proxy is parked for a later milestone; the engine is the same.
- D2: Tier 1 is always on and deterministic. Current list (0.22.0, ADR 0059, packages/redact/src/tier1.ts): API keys and tokens with a known issuer prefix or format (36 issuer prefixes, plus private-key blocks, Google API keys and JWTs), Luhn-valid card numbers, US SSNs, IBANs, emails, phones, IP addresses, GPS coordinates, street addresses, ZIP codes next to an address, labeled record and account numbers. Numbered placeholders (`[SSN_1]`), one-way.
- D3: Tier 2 is opt-in and on-device: Ollama NER turns people, orgs and locations into stable pseudonyms (`Person-1`, `Org-2`). It runs before Tier 1, which then sweeps the result. Without Ollama, or on non-JSON model output, Tier 2 is skipped and flagged `tier2Degraded`; the CLI and GUI say so unmissably (invariant #6).
- D4: Restore is asymmetric. Tier 2 pseudonyms are `restorable: true`; Tier 1 secrets are `restorable: false` forever. The restore map goes back to the caller (`--map` file, or in-page GUI state), not persisted, unless the user saves one.
- D5: `packages/redact/test/leak.test.ts` runs the seeded-secret corpus through Tier 1, asserting zero misses, first in `.github/workflows/ci.yml` on every push and PR. After the review: 63 secrets, zero misses.

## Consequences
- Easier: no overclaim about scrubbing prompts NorthKeep never sees.
- Harder: users must route text through redaction themselves.
- Limits (KNOWN-LIMITS.md): Tier 1 is ~99% on its target classes, not a guarantee across all formats. It does not catch a key with no recognizable prefix, a password, or a secret written in ordinary words. Tier 2 is 85 to 95% in-domain and degrades out of domain; a missed entity is a leak. Neither removes contextual identity; no Tier 3 is claimed.

## Rejected
- Interceptor on the Claude Desktop wire: NorthKeep is not in it.
- Server-side stored restore map: a standing real-to-fake table on disk.

## What leaves the machine
The original has no egress section. Its review found `/api/redact` stateless (no vault access, nothing persisted or logged) and using the loopback-guarded Ollama client. No new dependencies.

## Links
Amended by: ADR 0059 (Tier 1 list)
Full record: docs/design/adr-0005-redaction-pipeline.md
