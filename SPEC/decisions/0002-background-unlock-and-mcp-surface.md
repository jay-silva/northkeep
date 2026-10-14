# ADR 0002: Background unlock (Keychain) and the MCP surface

Status: Accepted 2026-07-04 (M1) · Review: invariant-#3 adversarial review 2026-07-04, no critical findings; fixes listed in the full record · Linux key storage later set by ADR 0064

## Context
Claude Desktop launches the MCP server silently, with no terminal to prompt for a passphrase. Something on the machine must hold enough to open the vault, or the product does not work. The question is what, and where.

## Decision
- D1: `northkeep unlock` prompts once, derives the master key (Argon2id + device secret), verifies it against the vault, and stores the derived key, never the passphrase, in the login Keychain (service `northkeep-vault`). `northkeep lock` deletes it. Writes go through `security -i` (stdin), so the key never appears on a command line.
- D2: Key resolution everywhere: `NORTHKEEP_MASTER_KEY` env (tests/CI) → Keychain → `NORTHKEEP_PASSPHRASE` env (derive, slow) → interactive prompt (CLI only). A locked vault returns a "run northkeep unlock" error to the AI client, never a hang or silent failure.
- D3: Every MCP tool call takes an advisory lock (`vault.nkv.lock`), opens the vault fresh, operates, saves if mutating, and closes. The decrypted database never outlives one call, and CLI and server writes cannot clobber each other.
- D4: Every call appends one JSON line to `~/.northkeep/mcp-calls.log`: timestamp, tool, filter params, query term count, content length, result count/id, error. Never memory content or query text. `northkeep log` shows it.
- D5: `forget` is a tombstone (schema 0.2): content is blanked irrecoverably, the row and hashes stay so the chain stays verifiable. `superseded_at`, `superseded_by` and `forgotten_at` are excluded from the hash input; 0.1 vaults migrate automatically; the 0.2 hash rule is frozen.

## Consequences
- Easier: the AI client can use the vault without a prompt; per-call cost is milliseconds with a pre-derived key.
- Harder (trust statement): while unlocked, anyone with the user's logged-in Mac session can read the vault, the same trust level as saved browser passwords. Stated in `unlock` output, the security model and KNOWN-LIMITS.md.
- Limits: Linux vault-key storage is ADR 0064 (Secret Service, or a mode-0600 file only after `--allow-key-file` when that daemon is absent). Windows remains an env-var fallback. Provider API keys and OAuth tokens are unchanged by 0064. Schema-rejected calls do not reach the call log (audit completeness lands with M4).

## Rejected
- Passphrase in the Claude Desktop config env block: plaintext passphrase in a JSON file on disk.
- Long-running unlocked daemon: far more machinery; revisit post-MVP.
- Passphrase in the Keychain: the derived key is equally powerful but skips Argon2id (~0.5s) per call and keeps the human secret human.

## What leaves the machine
The original has no egress section. It states that `@modelcontextprotocol/sdk` uses stdio only (no network listener), `zod` does no I/O, and no dependency added in M1 performs network access; invariant #7 was not triggered.

## Links
Linux key storage: ADR 0064 · Full record: docs/design/adr-0002-background-unlock-and-mcp-surface.md
