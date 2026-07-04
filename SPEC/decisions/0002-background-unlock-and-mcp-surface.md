# ADR 0002 — Background unlock (Keychain) and the MCP surface

- **Date:** 2026-07-04
- **Status:** Accepted (M1)
- **Deciders:** Jay (approved the M1 plan), Claude Code

## Context

The MCP server is launched silently by Claude Desktop — there is no terminal
to prompt for a passphrase. Something on the machine must hold enough to open
the vault, or the product doesn't work. The question is what, and where.

## Decision 1: Derived master key in the macOS Keychain, explicit opt-in

`northkeep unlock` prompts for the passphrase once, derives the master key
(Argon2id + device secret), verifies it against the vault, and stores the
**derived key** — never the passphrase — in the user's login Keychain
(service `northkeep-vault`). `northkeep lock` deletes it. The MCP server and
the CLI both use it when present.

- Writes go through `security -i` (commands on stdin), so the key never
  appears on a process command line.
- Resolution order everywhere: `NORTHKEEP_MASTER_KEY` env (tests/CI) →
  Keychain → `NORTHKEEP_PASSPHRASE` env (derive, slow) → interactive prompt
  (CLI only). A locked vault yields a helpful "run northkeep unlock" error to
  the AI client, never a hang or a silent failure.

**Alternatives rejected:**
- *Passphrase in the Claude Desktop config env block:* plaintext passphrase
  in a JSON file on disk. No.
- *Long-running unlocked daemon:* better UX ceiling (auto-lock timers), far
  more machinery; revisit post-MVP if per-call reopen ever hurts.
- *Storing the passphrase in the Keychain:* the derived key is equivalent in
  power but skips Argon2id per call (~0.5s) and keeps the human secret human.

**Trust statement (Jay-visible):** while unlocked, anyone with the user's
logged-in Mac session can read the vault — the same trust level as saved
browser passwords. Stated in the `unlock` output, the security model, and
KNOWN-LIMITS.md. Linux/Windows: env-var fallback until those ports land.

## Decision 2: Per-call open under a file lock (no resident vault)

Every MCP tool call acquires an advisory lock (`vault.nkv.lock`), opens the
vault fresh with the resolved key, operates, saves if mutating, and closes.
The decrypted database never outlives one call, and CLI/server writes cannot
clobber each other (the vault is whole-file; unserialized concurrent saves
would silently drop one writer). Cost: ~ms per call with a pre-derived key.

## Decision 3: Content-free call log

Every call appends one JSON line to `~/.northkeep/mcp-calls.log`: timestamp,
tool, filter params, query term *count*, content *length*, result count/id,
error. Never memory content and never query text — a plaintext log echoing
vault content to disk would undo the encryption. `northkeep log` displays it.
This is the seed of the M4 audit log.

## Decision 4: Forget = tombstone (schema 0.2)

`forget` blanks content irrecoverably but keeps the row and its hashes, so
the chain stays verifiable and the deletion itself is auditable. Enabled by a
hash-rule correction shipped in the same release: mutable bookkeeping fields
(`superseded_at`, `superseded_by`, `forgotten_at`) are excluded from the hash
input — hashing them would have broken the chain on every legitimate
supersede or forget. 0.1 vaults migrate automatically (column add + chain
rehash), a pre-release-only move; the 0.2 hash rule is now frozen. See
SPEC/memory-schema.md changelog.

## Dependencies introduced

`@modelcontextprotocol/sdk` (decided in the stack; stdio transport only — no
network listener) and its peer `zod` (schema validation, no I/O). No
dependency added in this milestone performs network access; invariant #7 not
triggered.

## Review requirement

Key-handling paths added here (`keychain.ts`, `key.ts`, `Vault.openWithKey`)
fall under the invariant-#3 adversarial-review rule, reviewed with this
milestone (2026-07-04). Outcome: keychain write path (stdin-only, validated
hex, constant service names), key resolution order, per-call open/close, and
migration-behind-authentication all confirmed sound; no critical findings.
Fixed from the review: passphrase prompt moved outside the file lock;
lock-steal made atomic (rename) with ownership-checked release; `forget`
rejects LIKE metacharacters in id prefixes; MCP `id`/`scope`/`content`/`query`
params bounded and charset-constrained so client-controlled text cannot reach
the plaintext call log; `unlock`'s verification open runs under the file
lock; key buffers zeroed on all error paths; `lock` distinguishes
"not found" from keychain access failure and warns about env-var grants.
Documented rather than fixed: schema-rejected calls don't reach the call log
(audit completeness lands with M4 — noted in KNOWN-LIMITS.md).
