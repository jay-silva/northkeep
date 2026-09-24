# ADR 0059: Tier-1 masks issuer-prefixed API tokens

- **Date:** 2026-09-23
- **Status:** Proposed, NOT REVIEWED. This changes redaction and publishes a
  claim in KNOWN-LIMITS, so under the CLAUDE.md review gate it needs an
  adversarial review before it merges. The implementation sits on branch
  `adr-0059/tier1-tokens`, unmerged, so the reviewer can attack code rather
  than prose.
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
| anthropic | `sk-ant-[a-z]{2,10}\d{2}-[A-Za-z0-9_-]{20,}` | gitleaks and trufflehog name `api03` and `admin01`; the family form also covers other `sk-ant-<word><2 digits>-` variants, which are observed shapes, not sourced ones, and are not claimed |
| openai-named | `sk-(?:proj\|svcacct\|admin)-[A-Za-z0-9_-]{20,}` | gitleaks `openai-api-key` |
| openrouter | `sk-or-v1-[A-Za-z0-9]{32,}` | trufflehog `openrouter` (64 hex) |
| stripe | `[rs]k_(?:live\|test\|prod)_[A-Za-z0-9]{10,}` | gitleaks `stripe-access-token` |
| github | `gh[pousr]_[A-Za-z0-9]{30,}` | gitleaks `github-pat`, `github-oauth`, `github-app-token`, `github-refresh-token` |
| github-fine-grained | `github_pat_[A-Za-z0-9_]{40,}` | gitleaks `github-fine-grained-pat` |
| gitlab | `gl(?:pat\|dt\|ptt\|rt\|cbt\|ft\|ffct\|imt\|agent\|oas\|soat)-[A-Za-z0-9_-][A-Za-z0-9_.-]{18,}[A-Za-z0-9_-]` | gitleaks `gitlab-*` (the `.` covers routable tokens; a token never ends in `.`, so a sentence's full stop is not swallowed) |
| gitlab-runner-registration | `GR1348941[A-Za-z0-9_-]{20,}` | gitleaks `gitlab-rrt` |
| slack | `xox[baprse]-[A-Za-z0-9-]{10,}` | was already in Tier-1 as `xox[baprs]`; `xoxe` (refresh) added per gitleaks `slack-config-refresh-token` |
| slack-app | `xapp-\d-[A-Za-z0-9-]{10,}` | gitleaks `slack-app-token` |
| npm | `npm_[A-Za-z0-9]{36,}` | gitleaks `npm-access-token` |
| pypi | `pypi-AgE[A-Za-z0-9_-]{50,}` | gitleaks `pypi-upload-token` (widened from the pypi.org macaroon prefix to `AgE` so test.pypi.org tokens match too) |
| huggingface | `(?:hf\|api_org)_[A-Za-z0-9]{30,}` | gitleaks and trufflehog `huggingface` |
| xai | `xai-[A-Za-z0-9_]{50,}` | trufflehog `xai` (80 chars) |
| groq | `gsk_[A-Za-z0-9]{40,}` | trufflehog `groq` (52 chars) |
| replicate | `r8_[A-Za-z0-9_-]{30,}` | trufflehog `replicate` (37 chars) |
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
| planetscale | `pscale_(?:tkn\|oauth\|pw)_[A-Za-z0-9_.=-]{32,}` | gitleaks `planetscale-*` |
| pulumi | `pul-[a-f0-9]{40,}` | gitleaks `pulumi-api-token` |
| postman | `PMAK-[a-f0-9]{24}-[a-f0-9]{34,}` | gitleaks `postman-api-token` |
| heroku | `HRKU-AA[A-Za-z0-9_-]{58,}` | gitleaks `heroku-api-key-v2` |
| onepassword-service | `ops_eyJ[A-Za-z0-9+/]{100,}={0,3}` | gitleaks `1password-service-account-token` |
| age | `AGE-SECRET-KEY-1[0-9A-Z]{58,}` | gitleaks `age-secret-key` |
| atlassian | `ATATT3[A-Za-z0-9_=-]{100,}` | gitleaks `atlassian-api-token` (the prefixed branch only) |
| flyio | `fo1_[A-Za-z0-9_-]{43,}` or `fm[12][ar]?_[A-Za-z0-9+/]{100,}={0,3}` | gitleaks `flyio-access-token` |
| telegram-bot | `\d{8,10}:AA[A-Za-z0-9_-]{32,}` | gitleaks `telegram-bot-api-token` (the token shape, without its keyword anchor) |

Unchanged: PEM private-key blocks, the legacy generic
`\b(?:sk|pk|rk)[_-](?:live|test|proj)?[_-]?[A-Za-z0-9]{16,}\b` (old OpenAI
`sk-` keys, `pk_` keys), Google `AIza`, and JWTs.

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
every shape.

## False-positive analysis

Every new pattern needs a literal issuer prefix and a body of at least 20
characters (most need 30 to 100) drawn from a restricted alphabet with no
whitespace. Ordinary English cannot produce that. The realistic risks are
identifiers that share a prefix, and those are the near-miss tests.

**Measured, old detector versus new, counting `api_key` spans the new one
finds that the old one did not:**

| Corpus | Size | New `api_key` hits |
|---|---|---|
| Every tracked `.md .ts .tsx .json .txt .js .mjs .html` file in SPEC, docs, legal, site, e2e, packages, apps, workers, scripts, plus README, KNOWN-LIMITS, AGENTS, CLAUDE, DESIGN, plus every commit message body in `git log` | 589 files plus the log, 9.8 M chars | 0 |
| 20,000 `.md` and `.d.ts` files from installed dependencies (`node_modules/.pnpm`), prose and type signatures from across the JavaScript ecosystem | 132 M chars | 0 |

A sanity plant (one fake `gho_` token) confirmed the sweep detects hits.

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

**Accepted over-match:** a string with a real prefix and a long enough body
is masked even if it is not a valid key (bad checksum, wrong length). That
is a false positive by design: the cost is one masked non-secret, the
alternative is a leaked secret.

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
| Exfiltration screen | `packages/converse/src/tools/exfil.ts:397`, hard-deny set at `task.ts:67` | **Behaviour change:** `api_key` is a hard-deny kind, so a tool call whose restored arguments carry any new shape (plainly or after the screen's percent and base64 decoding) is now denied without a prompt, where it used to be allowed or prompted. This includes `trusted-api` tools such as web search (`task.ts:741-745` keeps hard-deny kinds there). |
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
- **A new issuer prefix** is not masked until it is added to the table.

## Acceptance (Jay, from the CLI)

Run from the worktree after `pnpm -r build`, in a throwaway home so nothing
touches the real vault. `redact` needs no vault; the home is set anyway.

```sh
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
F=$(printf 'FakeTestKey0%.0s' 1 2 3 4 5 6 7 8)   # 96 chars of fake filler
NK="node packages/cli/dist/index.js"
```

1. **The three verified misses, plus a real-shape OpenAI key.**
   `$NK redact "a sk-ant-api03-$F b github_pat_${F}_$F c gho_${F:0:36} d sk-proj-${F:0:30}_${F:0:30}"`
   prints `a [API_KEY_1] b [API_KEY_2] c [API_KEY_3] d [API_KEY_4]`.
2. **Catalog providers.**
   `$NK redact "xai-${F:0:80} and sk-or-v1-${F:0:64}"` prints
   `[API_KEY_1] and [API_KEY_2]`.
3. **Glued after an underscore.**
   `$NK redact "MY_KEY_ghp_${F:0:36}"` prints `MY_KEY_[API_KEY_1]`.
4. **Prose is left alone.**
   `$NK redact "Tokens start with github_pat_ or glpat-; set npm_config_registry; use xai-grok-4."`
   prints the sentence unchanged.
5. **Old shapes still masked.**
   `$NK redact "AKIAIOSFODNN7EXAMPLE and sk_live_${F:0:24}"` prints
   `[API_KEY_1] and [API_KEY_2]`.
6. **The gates.** `npx vitest run packages/redact` and
   `pnpm exec vitest run --config e2e/vitest.config.ts e2e/m3.test.ts` pass.
7. **Nothing written.** `ls -A "$NORTHKEEP_HOME"` prints nothing; then
   `rm -rf "$NORTHKEEP_HOME"`.

## Review history

- 2026-09-23: Proposed. No adversarial review yet. The reviewer's findings
  go here, verified against code, not this prose.
