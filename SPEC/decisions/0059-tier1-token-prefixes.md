# ADR 0059: Tier-1 masks issuer-prefixed API tokens

- **Date:** 2026-09-23
- **Status:** Accepted and shipped (main 3c0d306, 2026-09-24; in release
  0.22.0). First review and recheck both CLEARED WITH WOUNDS
  (2026-09-23), no wound open. Jay decided the placeholder question on
  2026-09-23 (options B and C, Decision 8). This changes redaction and
  publishes a claim in KNOWN-LIMITS, so the CLAUDE.md review gate applies.

  **Correction 2026-09-24 (release 0.22.0 doc-vs-code pass):** this status
  is stale. The branch was merged into main as merge commit `3c0d306`
  ("Merge adr-0059/tier1-tokens: Tier-1 token prefixes (ADR 0059)"), and the
  change ships for the first time in release 0.22.0. The table in Decision 1
  matches `TOKEN_PREFIX_PATTERNS` in packages/redact/src/tier1.ts:32 entry
  for entry (36 families), and acceptance steps 1 to 7 and 9 below were
  re-run against the built CLI on this date with the stated output.
- **Deciders:** Jay (product owner), Claude Code
- **Depends on:** ADR 0029 (exfiltration screens and the hard-deny set),
  ADR 0030 (trusted-API egress keeps only the hard-deny kinds), ADR 0033
  Decision 3 (the Tier-1 floor on `strict` MCP server arguments), ADR 0048
  (Tier-1 return masking of project payloads)
- **Does not touch:** crypto or key handling, the vault schema, sync, the
  connector, export or the local mirror, placeholder names, the set of
  secret kinds. No new dependency.

## Context

### The gap

On main at `9f8c8c4`, `applyTier1` left three widely used credential shapes
completely unmasked: Anthropic API keys (`sk-ant-api03-...`), GitHub
fine-grained personal access tokens (`github_pat_...`) and GitHub OAuth
tokens (`gho_...`). It masked `ghp_`, `sk-proj-` and `AKIA` in the corpus.
The Anthropic miss is the sharpest: it is the key NorthKeep's own users are
most likely to hold, because Anthropic is a provider in the model catalog
(`packages/converse/src/provider-catalog.ts`).

### How it was found, and the second finding

The first three were verified directly against `applyTier1` on main. While
probing them, a throwaway script also fed Tier-1 keys shaped like the ones
issuers really hand out, with `-` and `_` inside the body. Results on
`9f8c8c4`, each a complete leak (not a partial mask):

| Shape | Result on 9f8c8c4 |
|---|---|
| `sk-proj-` with `_` or `-` in the body (the real OpenAI project-key alphabet) | full leak |
| `sk-svcacct-` (OpenAI service account) | full leak |
| `sk-ant-api03-` (Anthropic) | full leak |
| `github_pat_` | full leak |
| `gho_` | full leak |
| `sk-or-v1-` (OpenRouter, a catalog provider) | full leak |
| `xai-` (xAI, a catalog provider) | full leak |
| `sk_live_` with a 99-char body | masked |

So "Tier-1 masks OpenAI project keys" was true only for a fixture no issuer
produces. The generic branch
`\b(?:sk|pk|rk)[_-](?:live|test|proj)?[_-]?[A-Za-z0-9]{16,}\b` needs a run of
16 or more letters and digits that ends on a word boundary, and a real
`sk-proj-` body contains `_`, which is a word character, so the match fails
at every start position.

### Why CI stayed green

Two reasons, both fixed here. The corpus's `sk-proj-` fixture was letters and
digits only. And the leak assertion was `text.includes(secret)`, which passes
when any single character of a key is masked, so a key masked only up to its
first `-` would also have passed.

### What this means for what already left

On main, the shapes above crossed every Tier-1 consumer unmasked: prompts to
cloud providers, arguments to `strict` MCP servers and bounded web
destinations, and MCP return masking. The exfiltration screen's `api_key`
hard-deny never fired for them. This change does not reach anything already
sent. Whether to advise key rotation, and how to word a release note, is
Jay's decision, not this ADR's.

### Where the broad claim is published

These public or reviewer-facing lines say Tier 1 masks "keys" or "secrets"
without naming shapes. They were over-broad on main and stay broad after
this change (prefixless secrets are still missed). They are listed here, not
edited, because changing public copy is itself a gated claim:
`README.md:88`, `README.md:219` ("Tier 1 masks secrets (emails, SSNs, cards,
keys)"), `site/index.html:206`, `site/start.html:94`, `site/roadmap.html:65`,
`docs/appstore-review-notes.md:54` ("API keys").

## Decision

### 1. An issuer-prefix table, compiled into the `api_key` detector

`packages/redact/src/tier1.ts` gains an exported table,
`TOKEN_PREFIX_PATTERNS`, whose entries are joined into the existing
`api_key` alternation. Every entry needs a literal issuer prefix followed by
a body with a minimum length over that issuer's alphabet. Sources: the
gitleaks rule set (`config/gitleaks.toml`, master, fetched 2026-09-23) and
the trufflehog detectors (`pkg/detectors/<name>/<name>.go`, main, fetched
2026-09-23).

Every pattern below is prefixed with the guard `(?<![A-Za-z0-9])` (see
Decision 3).

| Family | Pattern (after the guard) | Source |
|---|---|---|
| anthropic | `sk-ant-[a-z]{2,10}\d{2}-[A-Za-z0-9_-]{40,}` | gitleaks and trufflehog name `api03` and `admin01`; the family form also covers other `sk-ant-<word><2 digits>-` variants, which are observed shapes, not sourced ones, and are not claimed |
| openai-named | `sk-(?:proj\|svcacct\|admin)-[A-Za-z0-9_-]{40,}` | gitleaks `openai-api-key` |
| openrouter | `sk-or-v1-[A-Za-z0-9]{32,}` | trufflehog `openrouter` (64 hex) |
| stripe | `[rs]k_(?:live\|test\|prod)_[A-Za-z0-9]{16,}` | gitleaks `stripe-access-token` |
| github | `gh[pousr]_[A-Za-z0-9]{30,}` | gitleaks `github-pat`, `github-oauth`, `github-app-token`, `github-refresh-token` |
| github-fine-grained | `github_pat_[A-Za-z0-9_]{40,}` | gitleaks `github-fine-grained-pat` |
| gitlab | `gl(?:pat\|dt\|ptt\|rt\|cbt\|ft\|ffct\|imt\|agent\|oas\|soat)-[A-Za-z0-9_-][A-Za-z0-9_.-]{18,}[A-Za-z0-9_-]` | gitleaks `gitlab-*` (the `.` covers routable tokens; a token never ends in `.`, so a sentence's full stop is not swallowed) |
| gitlab-runner-registration | `GR1348941[A-Za-z0-9_-]{20,}` | gitleaks `gitlab-rrt` |
| slack | `xox[baprse]-[A-Za-z0-9-]{10,}` | was already in Tier-1 as `xox[baprs]`; `xoxe` (refresh) added per gitleaks `slack-config-refresh-token` |
| slack-app | `xapp-\d-[A-Za-z0-9-]{10,}` | gitleaks `slack-app-token` |
| npm | `npm_[A-Za-z0-9]{36,}` | gitleaks `npm-access-token` |
| pypi | `pypi-AgE[A-Za-z0-9_-]{50,}` | gitleaks `pypi-upload-token` (widened from the pypi.org macaroon prefix to `AgE` so test.pypi.org tokens match too) |
| huggingface | `(?:hf\|api_org)_[A-Za-z0-9]{34,}` | gitleaks and trufflehog `huggingface` |
| xai | `xai-[A-Za-z0-9_]{50,}` | trufflehog `xai` (80 chars) |
| groq | `gsk_[A-Za-z0-9]{40,}` | trufflehog `groq` (52 chars) |
| replicate | `r8_[A-Za-z0-9_-]{35,}` | trufflehog `replicate` (37 chars) |
| perplexity | `pplx-[A-Za-z0-9]{40,}` | gitleaks `perplexity-api-key` (48 chars) |
| aws-access-key | `(?:AKIA\|ASIA\|ABIA\|ACCA)[0-9A-Z]{16}(?![A-Za-z0-9])` | was `AKIA` only; the other three per gitleaks `aws-access-token` |
| aws-bedrock | `ABSK[A-Za-z0-9+/]{100,}={0,2}` | gitleaks `aws-amazon-bedrock-api-key-long-lived` |
| sendgrid | `SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}` | trufflehog `sendgrid` |
| digitalocean | `do[opr]_v1_[a-f0-9]{64,}` | gitleaks `digitalocean-*` |
| shopify | `shp(?:at\|ca\|pa\|ss)_[a-fA-F0-9]{32,}` | gitleaks `shopify-*` |
| linear | `lin_api_[A-Za-z0-9]{40,}` | gitleaks `linear-api-key` |
| notion | `ntn_[A-Za-z0-9]{40,}` or `secret_[A-Za-z0-9]{43,}` | gitleaks `notion-api-token`; trufflehog `notion` |
| databricks | `dapi[a-f0-9]{32,}` | gitleaks `databricks-api-token` |
| sentry | `sntry[us]_[A-Za-z0-9+/=_]{40,}` | gitleaks `sentry-user-token`, `sentry-org-token` |
| doppler | `dp\.pt\.[A-Za-z0-9]{40,}` | gitleaks `doppler-api-token` |
| planetscale | `pscale_(?:tkn\|oauth\|pw)_[A-Za-z0-9_.=-]{31,}[A-Za-z0-9_=-]` | gitleaks `planetscale-*` (last character may not be `.`, so a sentence's full stop stays outside the mask) |
| pulumi | `pul-[a-f0-9]{40,}` | gitleaks `pulumi-api-token` |
| postman | `PMAK-[a-f0-9]{24}-[a-f0-9]{34,}` | gitleaks `postman-api-token` |
| heroku | `HRKU-AA[A-Za-z0-9_-]{58,}` | gitleaks `heroku-api-key-v2` |
| onepassword-service | `ops_eyJ[A-Za-z0-9+/]{100,}={0,3}` | gitleaks `1password-service-account-token` (standard base64; a base64url body is a residual) |
| age | `AGE-SECRET-KEY-1[0-9A-Z]{58,}` | gitleaks `age-secret-key` |
| atlassian | `ATATT3[A-Za-z0-9_=-]{100,}` | gitleaks `atlassian-api-token` (the prefixed branch only) |
| flyio | `fo1_[A-Za-z0-9_-]{43,}` or `fm[12][ar]?_[A-Za-z0-9+/]{100,}={0,3}` | gitleaks `flyio-access-token` (standard base64; a base64url body is a residual) |
| telegram-bot | `(?<=<guard>bot)\d{5,16}:A[A-Za-z0-9_-]{33,}` or `<guard>\d{8,10}:AA[A-Za-z0-9_-]{32,}` | gitleaks `telegram-bot-api-token` (`[0-9]{5,16}:A` + 34), whose wide range gitleaks pairs with a `telegram` keyword. Here `bot` is the anchor: the first arm matches right after `bot`, the spelling Telegram's own API uses (`api.telegram.org/bot<id>:<secret>/method`), and `bot` stays outside the mask; `robot<digits>:` is refused by the guard on `bot`. The bare arm keeps the narrow `<8-10 digits>:AA` shape, because the wide range without an anchor hard-denied identifiers like `order:123456:AwaitingFulfillment-...` (recheck). |

Unchanged: PEM private-key blocks, the legacy generic
`\b(?:sk|pk|rk)[_-](?:live|test|proj)?[_-]?[A-Za-z0-9]{16,}\b` (old OpenAI
`sk-` keys, `pk_` keys), Google `AIza`, and JWTs.

**Why the 1Password and Fly bodies stay standard base64.** The first fix
round widened them to base64url as a precaution. The recheck showed that
widening spans ordinary snake_case and kebab identifiers and file paths of
100+ characters after `fm1_`/`fm2_` (`def fm2_compute_..._v2():`), which then
hard-deny. gitleaks gives both as standard base64, so the bodies are back to
that, and a base64url body is recorded as a residual.

### 2. The table runs before the generic branch

JavaScript alternation takes the first branch that matches at a position,
not the longest. The table sits ahead of the generic `sk|pk|rk` branch so
the generic branch never claims a partial span of a named key.

### 3. The guard is "no letter or digit before", not `\b`

`\b` fails when a token is glued after `_` (`MY_KEY_ghp_...`, a common env
or config spelling), because `_` is a word character. The table's guard
`(?<![A-Za-z0-9])` still refuses a prefix glued onto a word (`xghp_...`)
while matching after `_`. Slack, AWS and Stripe moved into the table for the
same reason; their old branches ended in `\b` and leaked whole when a word
followed after `_`.

### 4. Minimum lengths, never exact lengths

Each body is `{N,}` over the issuer's full alphabet, deliberately looser than
gitleaks and trufflehog. Their job is to report only valid keys; ours is
never to let a key through. An exact `{36}\b` turns an issuer's decision to
lengthen a key, or to add `_` to the alphabet, into a full leak. We do not
require Anthropic's trailing `AA`, OpenAI's `T3BlbkFJ` marker, or the
GitHub and npm checksums.

The raised minimums of Decision 8 keep this rule: each is still well below
the issuer's real key length.

### 5. The kind stays `api_key`

New shapes reuse `api_key`, so placeholders stay `[API_KEY_n]`, the exfil
screen's `KIND_NOUN` table and the hard-deny set need no change, and the
model cannot tell which issuer a masked key came from.

### 6. The leak gate checks whole spans and 8-char windows

`packages/redact/test/leak.test.ts` now requires every `api_key` corpus
entry to be masked as one whole replacement (`original === secret`), and
requires that no 8-character window of any corpus secret survives, in
isolation and in one blob. `e2e/m3.test.ts` applies the window check to the
CLI's output. Against the corpus as it stood on `9f8c8c4` both checks pass
(baseline taken before any new entry was added), so the stronger gate did
not need any old fixture changed.

### 7. Fixtures are built at runtime and fail the issuer checksums

`packages/redact/test/fake-tokens.ts` assembles one or more fake tokens per
family by string concatenation, so no complete token-shaped literal is
committed for a secret scanner, or a reader, to mistake for a real key.
Bodies are repeated `FakeTest0Key9` filler with `-` and `_` wherever the
issuer's alphabet allows them. They miss the strict issuer shapes on
purpose: no Anthropic trailing `AA`, no OpenAI marker, and the GitHub and
npm fixtures fail the CRC32/base62 checksum under both published readings
(over the random part alone and over prefix plus random part). A unit test
asserts the checksum failure, so a later edit cannot quietly turn a fixture
into a valid-shaped token. The corpus appends one sentence per fake token,
so both the unit leak test and the e2e CLI leak gate enforce zero misses on
every shape. There is at least one fixture per alternation branch (every
GitLab, Slack, DigitalOcean, Shopify, PlanetScale, Fly, AWS and Stripe
sub-prefix), not only one per family.

The materialized fixtures do match 49 of gitleaks' strict shape rules. That
is expected: most issuers have no offline checksum, so any string of the
right shape passes a scanner. They exist only at runtime, are visibly
filler, and the only issuers with an offline checksum (GitHub, npm) are the
ones the checksum test covers. The committed diff was scanned with the 220
gitleaks rules that compile in JavaScript: two hits, AWS's published
documentation example key `AKIAIOSFODNN7EXAMPLE` (already in the corpus
before this change) and a `generic-api-key` false positive on the fragment
`AGE-SECRET-`.

## False-positive analysis

Every new pattern needs a literal issuer prefix and a body of at least 20
characters (most need 30 to 100) drawn from a restricted alphabet with no
whitespace. Ordinary English cannot produce that. The realistic risks are
identifiers that share a prefix, and those are the near-miss tests.

**Correction 2026-09-24 (release 0.22.0 doc-vs-code pass):** "a body of at
least 20 characters" is not true of every entry. In
packages/redact/src/tier1.ts:32-84 the Slack and Slack app bodies need 10
or more characters (`xox[baprse]-[A-Za-z0-9-]{10,}`,
`xapp-\d-[A-Za-z0-9-]{10,}`), the Stripe body 16 or more, and the new AWS
prefixes (`ASIA`, `ABIA`, `ACCA`) exactly 16. Every other entry needs 20 or
more. The bare Telegram arm has no issuer prefix: it is 8 to 10 digits, the
literal `:AA`, and 32 or more body characters.

**Measured, old detector versus new, counting `api_key` spans the new one
finds that the old one did not:**

| Corpus | Size | New `api_key` hits |
|---|---|---|
| Every tracked `.md .ts .tsx .json .txt .js .mjs .html` file in SPEC, docs, legal, site, e2e, packages, apps, workers, scripts, plus README, KNOWN-LIMITS, AGENTS, CLAUDE, DESIGN, plus every commit message body in `git log` | 589 files plus the log, 9.8 M chars | 0 |
| 20,000 `.md` and `.d.ts` files from installed dependencies (`node_modules/.pnpm`), prose and type signatures from across the JavaScript ecosystem | 132 M chars | 0 |

A sanity plant (one fake `gho_` token) confirmed the sweep detects hits.

**Cost.** The exfil screen caps a candidate at 4,096 characters and its DoS
bound rests on Tier-1 cost. Timed old against new on 4,096-char worst cases
(random alphanumerics, `-`/`_`-heavy text, repeated `sk-ant-api03-` and
`ghp_` prefixes, dot-heavy `glpat-`, `xoxb-` followed by dashes, prose):
every case within 0.8 ms of the old detector, worst case 5.7 ms against
4.9 ms.

**Near-miss unit tests** (`NEAR_MISSES` in `fake-tokens.ts`, asserted to
produce no `api_key` span): the bare prefixes in prose (`github_pat_`,
`glpat-`, `sk-ant-api03-`, `sk-or-v1-`, `ops_eyJ`), too-short bodies
(`github_pat_short_123`, a 12-char `gho_`, `r8_short`, `gsk_test`,
`pplx-api`, `sk-proj-demo`, `glpat-short`), prefix-sharing identifiers
(`npm_config_registry`, `npm_package_version`, `hf_transfer`, `HF_HOME`,
`hf_hub_download`, `xai-grok-4`, `xai-sdk`, `secret_key_base`,
`secret_token`, `pul-request`, `PMAK-docs`), lookalike words (`dapibus`,
`ASIA PACIFIC`, `ASIAN`, `SG.1.2.3`), a clock time and a short
`12345678:AA`, and a prefix glued onto a letter (`xghp_`).

**Over-match, and what it really costs.** A string with a real prefix and a
long enough body is treated as a key even if it is not one. The first draft
of this ADR costed that as "one masked non-secret". That was wrong for two
of the consumers. `api_key` is a hard-deny kind, so the same match also:

- **denies a tool call outright**, at the screen, before the gate and with
  no prompt and no override (`task.ts:67`, `task.ts:773`), and
- **drops a candidate memory** in distillation (`turn.ts:611-613`).

The first review measured what the first draft caught, through the real
`screenArguments` and a real strict-MCP `runTask`: `.env.example`-style
placeholders (`sk_test_yourkeyhere`, `sk-ant-api03-your-api-key-goes-here-xxxx`,
`sk-proj-your_openai_project_key_here_123`, `ghp_` + 30 `x`, `gsk_` + 40 `x`,
`hf_` + 34 `x`), branch and namespace slugs
(`sk-admin-dashboard-redesign-for-q4-launch`,
`sk-proj-management-tool-refactor-phase-two`,
`sk-ant-dev01-cluster-monitoring-stack`), and a roughly doubled false
hard-deny rate on random base64url leaves (12 to 26 of 20,000). The recheck
added two classes the first fix round introduced: identifiers like
`order:123456:AwaitingFulfillment-...` through a widened bare Telegram arm,
and 100+-character snake_case or kebab strings after `fm1_`/`fm2_` through
the base64url widening. Real text: 0 new hits in 173 M and then 212.7 M
characters of dependency code and repo history across the two reviews.

**After Jay's decision (Decision 8) and this round, what still over-matches:**

- **Released, and tested as released** (`RELEASED_BY_B_AND_C` and
  `RECHECK_OVERMATCH` in `fake-tokens.ts`): every placeholder and slug
  listed above, bodies that are a single repeated character, the
  recheck's Telegram identifiers, and its `fm1_`/`fm2_` strings.
- **Still hard-denied:** a placeholder or slug whose body is at or past the
  new minimum and is not one repeated character, such as
  `sk-ant-api03-` followed by 40 or more characters of placeholder words, or
  a branch named `sk-proj-` plus 40 or more characters. These are rarer
  than the released ones but not impossible.
- **Random base64url:** the raised `r8_` and `hf_` minimums did not remove
  the increase. One fresh sample of 20,000 random 4,000-char base64url
  leaves: 9 flagged by the old detector, 17 by this one (about 0.05% to
  0.09% per leaf), with `r8_` the largest single contributor. Through the
  full screen this means a tool call carrying a large random base64url blob
  is occasionally refused.

So the practical cost now is narrower: a key-prefixed string long enough to
look like a real key, in a tool call to a strict MCP server or a web tool,
is refused with "the request carries an API key or token" and cannot be
approved, and a memory carrying one is dropped. Jay accepted this cost with
options B and C.

## Where Tier-1 runs, so the reach of this change

Every consumer calls the same `applyTier1`, so each one below changes
behaviour for the new shapes at once.

| Consumer | Code | Effect of this change |
|---|---|---|
| Provider egress (conversations) | `redact()` at `packages/redact/src/index.ts:54`, called from `packages/converse/src/turn.ts:385` | New shapes are masked before any prompt reaches a cloud model at every tier from 1 up. Tier 0 (private endpoints only) is unchanged. |
| Provider egress (tasks) | `packages/converse/src/task.ts:398` | Same, for task-mode prompts. |
| CLI | `northkeep redact`, `packages/cli/src/index.ts:379` | Masks new shapes. |
| Web app API | `apps/web/src/api.ts:718` | Masks new shapes. |
| Mobile | `apps/mobile/src/lib/converse-run.ts:171`, `local-model.ts:70` | Masks new shapes before provider egress on the phone. Reaches users only with the next mobile build. |
| Tool-egress floor | `packages/converse/src/task.ts:918-921` | Arguments to a `strict` MCP server or a bounded web destination are sent with new shapes masked. |
| Exfiltration screen | `packages/converse/src/tools/exfil.ts:397`, hard-deny set at `task.ts:67` | **Behaviour change:** `api_key` is a hard-deny kind, so a tool call whose restored arguments carry any new shape (plainly or after the screen's percent and base64 decoding) is now denied without a prompt, where it used to be allowed or prompted. This includes `trusted-api` tools such as web search (`task.ts:742-746` keeps hard-deny kinds there). |
| Memory distillation | `packages/converse/src/turn.ts:611-613` | **Behaviour change:** a candidate memory that contains a new shape is dropped, not stored. |
| MCP return masking (memories) | `maskContent`, `packages/mcp-server/src/server.ts:313-316`, when `NORTHKEEP_REDACT_TIER=1` | Memory content returned to AI apps has new shapes masked. |
| MCP and CLI project payloads | `maskProjectFields`, `packages/mcp-server/src/project-mask.ts:21`, used by `server.ts:127` and `packages/cli/src/projectsCmd.ts:656` | Project text returned with Tier-1 on has new shapes masked; identifier keys stay exact. |
| `redactDeterministic` | `packages/redact/src/index.ts:114` | Exported; its only caller in the repo is `packages/redact/test/tier3.test.ts`. |

**Not consumers** (grep for `@northkeep/redact` and `applyTier1` finds no
use): `packages/core` (so vault storage, JSON export, git export and import,
and the M-A1 local mirror), `packages/sync`, `apps/sync-server`,
`apps/connector-server`, `workers`, `packages/importers`,
`packages/librarian`, `packages/extract`. A token a user stores in the vault
stays in the vault, its export and its mirror exactly as written, and a
token in a scope the user marked Shared reaches the connector store
unmasked (invariant 1(b); that path never ran Tier-1).

## Claims this ADR publishes, and where each is enforced

| Claim | Enforced by | Test |
|---|---|---|
| Tier-1 masks each family in Decision 1 as one whole `[API_KEY_n]` span | `TOKEN_PREFIX_PATTERNS`, `tier1.ts` | `redact.test.ts` "masks every fake token as one whole api_key span" (prose, bare, quoted, `KEY=`, `MY_KEY_` glued) |
| Every family in the table has a fixture | same | `redact.test.ts` "has a fake token for every family" |
| The verified 9f8c8c4 gap is closed (Anthropic, `github_pat_`, `gho_`, real-shape OpenAI) | same | `redact.test.ts` "closes the verified gap on 9f8c8c4" |
| Prefix-sharing prose and identifiers are not masked as keys | the guard and minimum lengths | `redact.test.ts` "leaves prefix-sharing prose and identifiers alone" |
| Zero Tier-1 misses on the seeded corpus, including every new shape, as whole spans with no surviving 8-char window | leak gate | `leak.test.ts` (unit), `e2e/m3.test.ts` (CLI) |
| Fixtures are not validly checksummed GitHub or npm tokens | fixture construction | `redact.test.ts` "uses fixtures that fail the GitHub and npm CRC32 checksum" |
| The exfil screen flags the new shapes as `api_key` (so they hard-deny), plain, percent-encoded, and in a JSON body leaf | `exfil.ts:397` with `task.ts:67` | `exfil.test.ts` "screenArguments: issuer-prefixed API keys (ADR 0059)" |
| A distilled memory candidate carrying a new shape is dropped, and the prompt to the provider carries the key masked | `turn.ts:611-613`, `turn.ts:385` | `converse.test.ts` "never distills an issuer-prefixed API key into memory (ADR 0059)" |
| A Telegram bot token is masked in its API URL, curl, webhook, env and bare forms, with `bot` left visible; the wide id range only after `bot` | telegram-bot entry | `redact.test.ts` "masks a Telegram bot token in its API URL, curl, webhook, env and bare forms", "masks the bot-anchored Telegram shape with the wide id range, but not a bare one" |
| A strict MCP server never receives a Telegram bot token in any of those forms; the call is denied at the screen before any prompt | `exfil.ts:397`, `task.ts:67`, `task.ts:918-921` | `task.test.ts` "runTask: Telegram bot tokens toward a strict MCP server (ADR 0059)" |
| The CLI leak gate fails if the CLI exits non-zero, prints an error or a stack on stderr, or prints no placeholders; a harmless runtime warning does not fail it | `e2e/m3.test.ts` | the same test |
| Placeholders, near-length branch names and single-repeated-character bodies are not treated as keys (options B and C) | raised minimums, `isRepeatedFillPlaceholder` | `redact.test.ts` "releases placeholders, near-length branch names and repeated-character bodies" |
| Fake keys at and just above the raised minimums are still masked; a real-entropy body with a short run, or more than 20 non-run characters, is still masked | same | `redact.test.ts` "still masks real-length fake keys at and just above the raised minimums", "exempts only a genuinely repeated body" |
| The recheck's over-match identifiers (bare `<digits>:A...`, `fm1_`/`fm2_` paths and identifiers) are not treated as keys | narrow bare Telegram arm, standard base64 Fly and 1Password bodies | `redact.test.ts` "does not hard-deny the identifiers the recheck caught" |

## Decision 8: placeholders and slugs (Jay, 2026-09-23: options B and C)

**The question put to Jay.** Accept that placeholder values and key-prefixed slugs are
hard-denied in tool calls and dropped from memory, or narrow the match?

**Options.**

- **A. Accept as is.** Simplest and loosest against real keys. Cost: the
  refusals above, with no way to approve them.
- **B. Raise four minimums toward real key lengths.** Anthropic and
  `sk-(proj|svcacct|admin)-` bodies from 20 to 40 (real keys run past 90),
  Stripe from 10 to 16 (the old generic branch's minimum; real keys are
  long), `r8_` from 30 to 35 (real 37), `hf_` from 30 to 34 (real 34). This
  releases the two `sk-proj-`/`sk-admin-` slugs, the `sk-proj-...here_123`
  placeholder, the short Stripe placeholders, and most of the base64url
  increase. Cost: a real key truncated below the new minimum would leak, and
  Decision 4's margin against an issuer shortening a key shrinks.
- **C. Exempt a body that is one character repeated** (`ghp_xxxx...`). Such
  a body carries no entropy, so it cannot be a real key, and it cannot be
  used to smuggle one. Cost: small code, small benefit.
- **D. Exempt bodies containing placeholder words** (`your`, `here`,
  `example`, `placeholder`, `changeme`). **Not recommended:** the exfil
  screen exists to stop a prompt-injected model from sending a key out, and
  this exemption would let it append `_yourkeyhere` to a real key and pass.

**Recommendation made:** B and C together, never D.

**Jay's decision (2026-09-23): B and C.** Implemented as:

- **B.** `TOKEN_PREFIX_PATTERNS` minimums: Anthropic and
  `sk-(proj|svcacct|admin)-` 40, Stripe 16, `r8_` 35, `hf_`/`api_org_` 34.
- **C.** `isRepeatedFillPlaceholder` in `tier1.ts`, the `valid` check on the
  `api_key` detector: a match is not a key when its longest run of one
  character is 20 or more and at most 20 other characters remain (room for
  the longest prefix, PyPI's 20). A match that fails the check is dropped
  before any consumer sees it, so it neither masks nor hard-denies. Why it
  opens no evasion path: at most 20 non-run characters survive, prefix
  included, so at most a 20-character fragment of a real key could ride
  along, and sending a key in fragments is already a documented residual.

The measured result is in "Over-match, and what it really costs" above. B
did not remove the random base64url increase as the recommendation
predicted; that is recorded there, not hidden.

## Residual (documented, not closed)

- **Prefixless secrets.** An AWS secret access key, a Twilio auth token, an
  Azure key, a database password, any bare hex or base64 string. No prefix,
  no Tier-1 match. Twilio `SK...` strings are key identifiers, not secrets,
  and are deliberately not matched.
- **Shapes left out for lack of a source checked here:** Google OAuth client
  secrets (`GOCSPX-`), Google access tokens (`ya29.`), Google refresh tokens
  (`1//`), Stripe webhook secrets (`whsec_`). Candidates for a follow-up once
  sourced.
- **A token split or disguised in the text.** Wrapped across a line break,
  with a zero-width or other invisible character inside, glued directly
  after a digit, or shorter than the family's minimum. The exfil screen
  decodes percent and base64 encodings; the Tier-1 floor itself stays a
  literal matcher (KNOWN-LIMITS says so).
- **The legacy branches keep `\b`.** The generic `sk|pk|rk` branch, `AIza`
  and JWTs still fail when a token is glued after `_`. Not widened here,
  because widening the generic body is the change most likely to hit slugs
  and branch names.
- **OpenAI `sk-None-` keys** (an older user-key shape, recalled by the
  reviewer, not verified from a source used here). With `-` or `_` in the
  body they leak whole, because the generic branch needs 16 unbroken
  alphanumerics. Not added: neither gitleaks' `openai-api-key` rule nor any
  other source this ADR cites names it. A follow-up once sourced.
- **1Password and Fly bodies in base64url.** gitleaks gives both as standard
  base64 and the pattern follows it. If a real token carries `-` or `_`, it
  would be masked only up to that character. Unverified either way.
- **Keys cut below the raised minimums** (Decision 8). A real key truncated
  to fewer than 40 body characters (Anthropic, OpenAI named), 16 (Stripe),
  35 (`r8_`) or 34 (`hf_`) is not masked.
- **Real token formats are unverified against reality.** Every fixture is
  self-built filler, so both the transcription of gitleaks/trufflehog and
  each issuer's current format are untested against a live token. That is
  the failure mode this ADR found in the old `sk-proj-` fixture.
- **A new issuer prefix** is not masked until it is added to the table.

## Acceptance (Jay, from the CLI)

Run from the worktree after `pnpm -r build`, in a throwaway home so nothing
touches the real vault. `redact` needs no vault; the home is set anyway.
Written for zsh (and works in bash): the CLI is a shell function, because
zsh does not split an unquoted `$NK` into a command and its argument.

```sh
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
F=$(printf 'FakeTestKey0%.0s' 1 2 3 4 5 6 7 8)   # 96 chars of fake filler
nk() { node packages/cli/dist/index.js "$@"; }
```

1. **The three verified misses, plus a real-shape OpenAI key.**
   `nk redact "a sk-ant-api03-$F b github_pat_${F}_$F c gho_${F:0:36} d sk-proj-${F:0:30}_${F:0:30}"`
   prints `a [API_KEY_1] b [API_KEY_2] c [API_KEY_3] d [API_KEY_4]`.
2. **Catalog providers.**
   `nk redact "xai-${F:0:80} and sk-or-v1-${F:0:64}"` prints
   `[API_KEY_1] and [API_KEY_2]`.
3. **Glued after an underscore.**
   `nk redact "MY_KEY_ghp_${F:0:36}"` prints `MY_KEY_[API_KEY_1]`.
4. **Telegram, as its API URL spells it.**
   `nk redact "curl https://api.telegram.org/bot7012345678:AA${F:0:34}/getMe"`
   prints `curl https://api.telegram.org/bot[API_KEY_1]/getMe`.
5. **Prose is left alone.**
   `nk redact "Tokens start with github_pat_ or glpat-; set npm_config_registry; use xai-grok-4."`
   prints the sentence unchanged.
6. **Placeholders are not keys (Decision 8).**
   `nk redact "GITHUB_TOKEN=ghp_$(printf 'x%.0s' {1..36}) STRIPE=sk_test_yourkeyhere"`
   prints the input unchanged.
7. **Old shapes still masked.**
   `nk redact "AKIAIOSFODNN7EXAMPLE and sk_live_${F:0:24}"` prints
   `[API_KEY_1] and [API_KEY_2]`.
8. **The gates.** `npx vitest run packages/redact` and
   `pnpm exec vitest run --config e2e/vitest.config.ts e2e/m3.test.ts` pass.
9. **Nothing written.** `ls -A "$NORTHKEEP_HOME"` prints nothing; then
   `rm -rf "$NORTHKEEP_HOME"`.

## Review history

- 2026-09-23: Proposed.
- 2026-09-23, first review (`Reviews/adr-0059/r1-first-review.md`):
  **CLEARED WITH WOUNDS.** Executed attacks: 2,310 context cases, old/new
  shape comparisons, a 173 M-char false-positive sweep (0 new hits), cost at
  4 KB to 1 MB (new `api_key` alternation linear, at most 9 ms per MB),
  real-consumer runs (strict-MCP `runTask`, MCP return masking over a real
  vault, the CLI), a per-entry mutation test (all 36 entries load-bearing),
  and byte-identical output on the old corpus.
  - Flesh wound: Telegram bot tokens leaked whole in their canonical
    `api.telegram.org/bot<id>:<secret>/` spelling at every consumer tested,
    against a published claim.
  - Scar tissue: placeholders, key-prefixed slugs and a small share of
    base64url payloads now hard-deny and drop memories, costed too lightly.
  - Notes: the acceptance block failed in zsh; `sk-None-` unsourced and
    leaking; 1Password and Fly alphabets unverified; PlanetScale swallowed a
    full stop; the e2e CLI gate would pass on a crashed CLI; whole-Tier-1
    cost is superlinear on some 1 MB inputs under old and new alike (a
    pre-existing, non-`api_key` detector; recorded outside this ADR).
- 2026-09-23, fix round:
  - Telegram: the entry now matches bare and right after `bot`, with the
    digit and secret ranges from gitleaks (`\d{5,16}:A` + 33 or more). Tests
    cover the API URL, curl, webhook, env and bare forms through
    `applyTier1`, and through a strict-MCP `runTask`, where every form is
    denied at the screen with no prompt and never reaches the server. Both
    tests fail on the old entry.
  - Scar tissue: restated with the review's numbers (see "Over-match, and
    what it really costs") and put to Jay as an open question with a
    recommendation; no pattern weakened.
  - `sk-None-`: recorded as residual (no source in hand). 1Password and Fly
    bodies widened to base64url defensively. PlanetScale no longer swallows
    a full stop. Acceptance block rewritten with a shell function. The e2e
    CLI leak gate now asserts exit code 0, empty stderr, every placeholder
    kind present, and at least one `[API_KEY_n]` per corpus key.
  - Re-measured after the fix: zero new `api_key` hits against the old
    detector over the repo text plus log (9.8 M chars), 20,000 dependency
    docs and type files (132 M chars) and 20,000 dependency code, JSON,
    YAML, Python and source-map files (118 M chars).
- 2026-09-23, recheck (`Reviews/adr-0059/r2-recheck.md`): **CLEARED WITH
  WOUNDS**, no wound open. The Telegram wound is closed at the CLI,
  strict-MCP egress and MCP return; the zsh block, PlanetScale and the m3
  gate hold (the m3 gate now fails on crashed, silent, echoing and killed
  CLIs). Scar tissue: the fix round's own over-match classes, the widened
  bare Telegram arm and the `fm*` base64url bodies, hard-deny identifiers
  and were not in the cost statement. Notes: `BOT`/`Bot` URL spellings,
  a percent-encoded colon, the one-character-looser Telegram body, the
  m3 `stderr === ''` check failing on a harmless warning, and the m3 CLI
  children inheriting no `NORTHKEEP_HOME`.
- 2026-09-23, Jay's decision: options B and C (Decision 8).
- 2026-09-23, round 3:
  - B and C implemented. Tests: the review's placeholders and slugs, and
    bodies of one repeated character, produce no `api_key` span; fake keys
    at and just above each raised minimum are masked; a real-entropy body
    with a short run, or with more than 20 non-run characters, is masked.
  - Bare Telegram arm back to `\d{8,10}:AA`, the `bot`-anchored arm kept
    wide. 1Password and Fly bodies back to standard base64 (residual
    recorded). The recheck's over-match strings are tested as not keys.
  - m3: the stderr check fails on an error or a stack, not on a warning;
    the child CLI runs with `NORTHKEEP_HOME` under the test's temp dir.
    Proven with stub CLIs: crash (exit 1), exit 0 with a `TypeError` stack,
    silent and echo all fail the gate; a CLI that prints an
    `ExperimentalWarning` and then works passes it.
  - Re-measured: zero new `api_key` hits against the old detector over the
    repo text plus log (9.9 M chars), 20,000 dependency docs and type files
    (132 M chars) and 20,000 dependency code, JSON, YAML, Python and
    source-map files (118 M chars). Random base64url: 9 to 17 of 20,000
    (above).
