# ADR 0059: Tier-1 masks issuer-prefixed API tokens

Status: Accepted and shipped 2026-09-24 (main `3c0d306`, release 0.22.0) · Review: first review and recheck both CLEARED WITH WOUNDS (2026-09-23), no wound open · Jay chose options B and C on 2026-09-23 (D5)

## Context
On main at `9f8c8c4`, `applyTier1` left Anthropic keys (`sk-ant-api03-`), `github_pat_`, `gho_`, real-shape `sk-proj-`, `sk-svcacct-`, `sk-or-v1-` and `xai-` keys completely unmasked: some prefixes had no rule, and `_` in real `sk-proj-` bodies defeated the generic branch's `\b`. CI stayed green: the fixture had no `_`, and the assertion passed on any partial mask. Those shapes crossed every Tier-1 consumer unmasked; this change does not reach anything already sent.

## Decision
- D1: `TOKEN_PREFIX_PATTERNS` in `packages/redact/src/tier1.ts` (36 families, from gitleaks and trufflehog) joins the `api_key` alternation, ahead of the generic `sk|pk|rk` branch.
- D2: Guard `(?<![A-Za-z0-9])`, not `\b`, so `MY_KEY_ghp_...` matches. Bodies use minimum lengths over the issuer's alphabet, never checksums or exact lengths, except the AWS access-key entry (exactly 16).
- D3: The kind stays `api_key`, placeholder `[API_KEY_n]`.
- D4: `leak.test.ts` and `e2e/m3.test.ts` require whole-span masking and no surviving 8-character window; the CLI gate also fails on a crash or error output. Fixtures are built at runtime in `fake-tokens.ts` and fail the GitHub and npm checksums.
- D5 (Jay, B and C): minimums raised (Anthropic and `sk-(proj|svcacct|admin)-` 40, Stripe 16, `r8_` 35, `hf_`/`api_org_` 34); `isRepeatedFillPlaceholder` drops a match whose longest single-character run is 20 or more with at most 20 other characters.

## Consequences
- Every `applyTier1` consumer changes at once: provider prompts at Tier 1 and up (Tier 0 unchanged), the CLI, web API, mobile (next build), the tool-egress floor, and MCP and project return masking.
- Harder: `api_key` is a hard-deny kind. A tool call whose arguments carry a matching string is denied with no prompt and no override, including `trusted-api` tools; a memory candidate carrying one is dropped. Placeholders or slugs at or past the minimums still hard-deny; random base64url leaves are flagged at 17 of 20,000 (old detector: 9).
- Not consumers: `packages/core` (vault, export, mirror), sync, connector. A token in a Shared scope reaches the connector store unmasked (invariant 1(b)).
- Residual: prefixless secrets (AWS secret keys, passwords, bare hex or base64); unsourced `GOCSPX-`, `ya29.`, `1//`, `whsec_`, `sk-None-`; tokens split, wrapped, with invisible characters, glued after a digit, or cut below the minimums; legacy branches keep `\b`; base64url 1Password and Fly bodies; formats unverified against live tokens; new prefixes until added. Broad "masks keys" copy in README and site was listed, not edited.

## Rejected
- Exact lengths or checksums: a lengthened key would leak whole.
- Option A (accept every over-match): unapprovable refusals.
- Option D (exempt placeholder words): an injected model could append `_yourkeyhere` to a real key.

## What leaves the machine
The original has no egress section. It states the new shapes are masked before provider and tool egress, and nothing already sent is reached. No new dependency.

## Links
Depends on: ADRs 0029, 0030, 0033 (D3), 0048
Full record: docs/design/adr-0059-tier1-token-prefixes.md
