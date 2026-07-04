# Known Limits

*Honesty about limits is a product feature. This file is kept current with
every milestone; if a limit is removed, say when and how.*

## M0 (vault core) — current

- **The unlocked vault lives in process memory.** While a command runs, the
  key and the decrypted database exist in RAM. Malware or an attacker with
  code execution on your machine can read them. True of every local-first
  tool; stated anyway.
- **No recovery, by design.** Lose the passphrase or the device secret file
  and the vault is gone. There is no back door for you, which means none for
  anyone else either. Back up `~/.northkeep/device.secret`.
- **Whole-file rewrite per save.** Every write re-encrypts and rewrites the
  vault file. Irrelevant at personal scale (milliseconds); would need a
  page-level encryption migration if vaults ever exceed available memory
  (see ADR 0001).
- **A crash mid-command can lose that command's write.** Saves are atomic
  (temp file + rename, previous version kept as `.nkv.bak`), so the vault
  never corrupts — but a write that never reached `save()` is not on disk.
- **`superseded_at`/`superseded_by` are schema-only.** The fields exist per
  the spec; nothing sets them yet. Contradiction handling arrives with the
  extraction pipeline (M2).
- **Scopes are labels, not walls.** The `scope` field is stored and
  filterable, but access enforcement (a conversation granted `personal`
  cannot see `client:x`) lands at M4.
- **Passphrase via `NORTHKEEP_PASSPHRASE` env var is convenient and less
  safe** — it can end up in shell history or process listings. Interactive
  prompt is the recommended path.
- **No redaction yet.** Nothing in M0 sends anything anywhere (there is no
  network code at all), but once M1 connects AI apps, redaction is M3.

## Permanent (will not be "fixed" — see SPEC/security-model.md)

- Content-level redaction cannot make free text semantically anonymous
  ("the CFO whose wife works at the competitor" survives every filter).
  We will never claim otherwise.
- Memory recall is good but not human-level; we compete on portability,
  ownership, and auditability — not on recall benchmarks.
