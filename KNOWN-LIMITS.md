# Known Limits

*Honesty about limits is a product feature. This file is kept current with
every milestone; if a limit is removed, say when and how.*

## M3 (redaction) — current

- **We redact text you route through us — we can't scrub what a chat app
  sends.** `northkeep redact` (and the GUI Redact panel) mask text *you*
  paste through them. Northkeep is not a proxy between Claude Desktop and
  Anthropic, so it cannot intercept a prompt you type directly into a chat
  client. Honest boundary, stated plainly.
- **Tier 1 is ~99%, not a guarantee.** It targets specific identifier
  formats (email, phone, SSN, card, IP, API keys, IBAN). An exotic format it
  doesn't recognize can slip through — the leak test locks in the formats we
  claim, and we add formats as we find gaps.
- **Tier 2 needs Ollama and is 85–95% in-domain.** A name it misses is a
  leak; Tier 1 always runs underneath as a backstop for secrets. Without
  Ollama, Tier 2 is skipped and you're told loudly — names are NOT masked.
- **We do not remove contextual identity.** "The paramedic lieutenant in
  Bourne whose partner runs compliance" survives every content-level filter.
  We don't claim Tier 3, and we say so.
- **Restore is one-directional for secrets.** Pseudonyms (names/orgs) come
  back; a masked SSN or card number stays masked — by design.

## GUI — current

- **The app window is a local web page with a per-session key.** While the
  UI is unlocked, any process that can read that session's token (or your
  Keychain, if you checked "keep unlocked") has vault access — the familiar
  rule: your Mac login session is the wall.
- **Closing the Tauri window kills the server and forgets the held key.**
  A browser tab from `northkeep ui` does the same when you Ctrl-C the
  terminal — but not if you only close the tab; the server keeps running.
- **The desktop app currently requires this machine's dev setup** (Node on
  PATH, the repo built). A double-clickable, signed, installable app is
  distribution work, deliberately deferred (ADR 0004).
- **No editing memories in the GUI yet** — forget-and-re-add until
  supersede semantics land.

## M2 (importers) — current

- **Extraction is a 3B model doing its best.** It misses facts (especially
  ones implied rather than stated), files almost everything under
  `semantic`, and occasionally paraphrases loosely. That's why every import
  ends in a review step — read what it extracted before you accept it.
- **Import speed is ~5 s per conversation** with the local model. A
  400-conversation ChatGPT history ≈ half an hour. Use `--limit 20` for a
  first taste.
- **Without Ollama, extraction is much rougher** (first-person pattern
  matching, confidence 0.4) — and the CLI tells you so in a banner you
  can't miss.
- **Dedupe is lexical.** "Takes coffee black" and "drinks coffee without
  milk" both survive. Conflicts are flagged for you, never auto-resolved.
- **The paste-prompt flow trusts the chatbot.** What Gemini claims to know
  about you imports at confidence 0.7 — review it.
- **ZIP imports need macOS/Linux** (the OS `unzip`). An already-extracted
  `conversations.json` works anywhere.
- **Very large exports parse fully into memory first** (`--limit` caps the
  extraction work, not the parse). Multi-GB exports may need a beefy
  machine; unzip output is hard-capped at 512 MB and fails cleanly past it.

## M1 (MCP server)

- **Unlocked = your Mac login is the wall.** After `northkeep unlock`, the
  vault key sits in your macOS Keychain and anything running in your
  logged-in session (including any MCP client you configure) can open the
  vault. Same trust level as saved browser passwords. `northkeep lock`
  revokes it.
- **Retrieval is keyword matching, not semantic search.** It ranks by word
  overlap, recency, and type priority. It will miss synonyms ("car" won't
  find "vehicle"). Embedding-based retrieval arrives with the local-model
  milestone (M2) — this line gets deleted then.
- **No scope enforcement yet.** Any connected MCP client can read every
  scope. Per-conversation scope grants are M4; until then, don't point an
  untrusted MCP client at your vault.
- **The call log shows traffic, not truth.** It logs what the server was
  asked and how much came back — it cannot show what the AI *did* with the
  content afterward. Calls rejected by input validation are answered before
  they reach the logger, so probing/malformed attempts don't appear yet —
  an audit-completeness gap that closes with the M4 audit log.
- **A stale `forget` survives in `.bak`** until the next write, as below.

## M0 (vault core)

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
- **`.nkv.bak` remembers what you just deleted.** The backup holds the
  immediately-previous vault state, encrypted with the same keys. A deletion
  is only durably gone once a later save overwrites the backup. Delete the
  `.bak` file yourself if that matters right now.
- **The hash chain catches naive edits, not a determined forger.** It is
  unkeyed: malware (or a chain-aware tool) with write access to the unlocked
  vault can rewrite history *and* every hash consistently. It exists to catch
  accidental corruption and unsophisticated tampering, and we won't pretend
  otherwise (see SPEC/security-model.md).
- **`superseded_at`/`superseded_by` are schema-only.** The fields exist per
  the spec; nothing sets them yet. Contradiction handling arrives with the
  extraction pipeline (M2).
- **Scopes are labels, not walls.** The `scope` field is stored and
  filterable, but access enforcement (a conversation granted `personal`
  cannot see `client:x`) lands at M4.
- **Passphrase via `NORTHKEEP_PASSPHRASE` env var is convenient and less
  safe** — it can end up in shell history or process listings. Interactive
  prompt is the recommended path. Either way, JavaScript strings are
  immutable: the passphrase string itself lingers in process memory until
  garbage collection (key *buffers* are actively zeroed; the source string
  cannot be).
- **No redaction yet.** Nothing in M0 sends anything anywhere (there is no
  network code at all), but once M1 connects AI apps, redaction is M3.

## Permanent (will not be "fixed" — see SPEC/security-model.md)

- Content-level redaction cannot make free text semantically anonymous
  ("the CFO whose wife works at the competitor" survives every filter).
  We will never claim otherwise.
- Memory recall is good but not human-level; we compete on portability,
  ownership, and auditability — not on recall benchmarks.
