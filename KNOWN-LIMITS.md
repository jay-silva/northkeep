# Known Limits

*Honesty about limits is a product feature. This file is kept current with
every milestone; if a limit is removed, say when and how.*

## M5 (vault sync) — current

- **The sync server can't read your memories, but it does hold your
  ciphertext.** Sync pushes the vault as its own encrypted blob; the server
  stores opaque bytes + a version number and never gets a key. That data does
  live on managed infrastructure (Neon Postgres) — encrypted, but hosted. Want
  full custody? The server is self-hostable.
- **A second machine needs your `device.secret` file, copied over by hand.**
  It's the account root — sync derives your identity from it. NorthKeep never
  transports it for you (that would defeat the two-secret model), and losing it
  still loses the vault. Guard it like a recovery key.
- **Conflicts are whole-vault, last-writer-wins.** If two machines edit before
  syncing, pulling replaces your local vault with the server's version — your
  prior local state is kept as `vault.nkv.bak`, not merged entry-by-entry.
  Per-entry merge is future work; for now, pull before you edit on a second
  machine.
- **Access is gated by subscription OR allowlist.** The hosted service (M5b)
  requires a **$10/month Stripe subscription** for anyone not on the allowlist;
  a non-subscribed, non-allowlisted account gets a 402 and can't sync. The
  allowlist (`NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES`) is the free/comp list —
  `northkeep sync id` prints your allowlist hash. A **self-hosted** server sets
  no Stripe env, so billing is off and only the allowlist gates; the ~4 MB size
  cap and host rate limiting are the only guards on an open (no-allowlist,
  no-Stripe) server, so don't expose one publicly.
- **Push before you pull on a machine you've edited.** Pulling replaces your
  local vault with the server's copy; unpushed local edits are moved to
  `vault.nkv.bak` (recoverable), not merged. There's no "you're ahead" warning
  yet, so sync in one direction at a time.
- **HTTPS only.** The client refuses a non-https sync server (except loopback
  for testing) so your token and blob never cross the network unprotected.

## M5b (billing) — current

- **Paying on the hosted service creates a bounded payer↔vault link.** To bill,
  the server stores one new fact: your encrypted account's token hash next to
  your Stripe customer/subscription id and status. Your **email and card never
  touch NorthKeep** — they live only in Stripe, and Checkout is Stripe-hosted
  (no card data, no PCI scope on us). The honest cost: the operator can now
  correlate *which paying customer owns which encrypted vault* — never its
  contents (still ciphertext-only). **Self-hosting stays fully anonymous** (no
  Stripe, allowlist only).
- **The gate leans on Stripe webhooks.** A cancelled subscription flips your
  account off when Stripe delivers the `subscription.deleted` webhook; if that's
  delayed, the `current_period_end` time check is the backstop (you keep syncing
  until the paid period ends, then it fails closed). No dunning/retry email flow
  beyond Stripe's defaults.

## M6 (Converse, the mediated client) — current

- **"Bounded" is bounded, not invisible.** Point Converse at a cloud
  endpoint and your *redacted* text still reaches that provider — masked
  before send, provable from the audit log, but on someone else's computer
  and subject to their retention. The absolute-privacy path is a local or
  LAN endpoint (the "private" badge), where nothing leaves your network.
- **The privacy badge trusts the address, not the wire.** A host is
  classified private because it's a loopback/RFC-1918/`.local` address. If
  you deliberately tunnel that address somewhere else (SSH forward, VPN),
  NorthKeep can't tell. Unrecognized and bare hostnames classify as
  *bounded* — we fail closed, so a LAN box by hostname may need its IP.
- **Tier-1 masks are one-way in the conversation too.** The model sees
  `[SSN_1]` and answers about `[SSN_1]` — your real number never comes back
  into the transcript. That's the point, but it reads oddly the first time.
- **Tier-2 toward a remote endpoint refuses to run degraded.** If Ollama is
  down and you asked for pseudonymization to a bounded endpoint, the message
  is NOT sent — start the model or explicitly drop to Tier 1. Loud, not
  silent.
- **Distillation quality tracks the small local model** (same as imports,
  M2). Auto-stored memories are visible with one-click undo — glance at
  what a turn added.
- **Conversation logs are not stored.** The vault keeps distilled memories
  and the content-free audit trail; the chat transcript itself lives only in
  session memory and is gone when the session ends (sync of any kind is M5).
- **Retrieval is still keyword-based** (M1 limit, unchanged) — memory
  injection misses synonyms until semantic retrieval lands.
- **API keys need the macOS Keychain.** On other platforms (or
  `NORTHKEEP_NO_KEYCHAIN=1`) keys are env-var-only for scripting — NorthKeep
  refuses to write them to files.

## M4 (scopes + audit) — current

- **Scope isolation binds what goes through NorthKeep, not what you paste
  yourself.** A connection granted only `client:henderson` physically can't
  retrieve `client:acme` from the vault — but NorthKeep can't stop you from
  typing Acme's details into a Henderson conversation by hand. The boundary
  is on the vault, not your keyboard.
- **Scope labels are set at write time.** If a memory is saved under the
  wrong scope, enforcement faithfully applies the wrong label. Review scopes
  when importing.
- **The grant is per-connection config, not per-message.** You run a scoped
  MCP connection for a matter; you don't switch scopes mid-conversation (that
  would let the model widen its own access).
- **Tier-1 masking over MCP is opt-in and one-way.** `NORTHKEEP_REDACT_TIER=1`
  masks secrets in retrieved content; full name-pseudonymization over MCP
  needs a provider proxy that doesn't exist yet (parked).
- **The audit log covers NorthKeep's own surface.** It records what AI apps
  asked of the vault — it can't see what a provider did with the content
  after NorthKeep handed it over.

## M3 (redaction) — current

- **We redact text you route through us — we can't scrub what a chat app
  sends.** `northkeep redact` (and the GUI Redact panel) mask text *you*
  paste through them. NorthKeep is not a proxy between Claude Desktop and
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
- **No editing memories in the GUI yet** — forget-and-re-add until
  supersede semantics land.

## Desktop app / distribution (M7d) — current

- **Apple Silicon (arm64) only for now.** The signed DMG bundles an arm64
  Node runtime; Intel Macs aren't built yet (ADR 0012 targets aarch64 first).
  Running from source still works on any platform.
- **No auto-update.** Updates are manual — download the new DMG. An in-app
  updater would phone home, against the no-telemetry invariant (#5); if we add
  one it'll be its own opt-in, signed, content-free decision (future ADR).
- **The bundled Node runtime is a version we redistribute.** We pin it and
  verify it against nodejs.org's checksums at build time; on a Node security
  release we bump the pin and ship a new DMG. **Supply-chain residual:** the
  checksum file is fetched over HTTPS from the same host as the binary and is
  not yet GPG-verified against Node's release keys — so the check stops
  accidental corruption and naive MITM, but not a compromise of nodejs.org's
  distribution server. Adding `gpg --verify` of the signed SHASUMS is a
  hardening step planned before wide distribution.
- **First launch may do an online Gatekeeper check.** The app and DMG are
  notarized and stapled, so they open offline too — but an app copied out of
  the DMG on a machine that's never seen it may do a one-time online check.

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

## M8 (Connect — memory into other apps) — current

- **Connect is Mode 2: portable memory, NOT a chat firewall.** Connecting an
  app (Claude Desktop, Claude Code) gives it your owned memory under the scope
  you pick — but it does **not** redact what you type into that app; the app
  still sends your whole chat to its provider. For a redaction firewall on your
  messages, use Converse. This is stated plainly in the Connect UI.
- **Connect registers the app installed at a stable path.** The entry points at
  `NorthKeep.app` where it lives; if you move or rename the app, reconnect so
  the path is rewritten.
- **Restart required.** Claude Desktop reads MCP config only at launch — Connect
  ends with a restart prompt; Claude Code picks it up in a new session.
- **A connected app reads your vault while it's unlocked** (the Keychain grant,
  same as any MCP client). Lock, or scope the connection down, to limit it.
- **macOS only** for now (matches the arm64 app); the config paths are
  macOS-specific.

## M9 (effortless models) — current

- **Guided providers are curated, not exhaustive.** The one-click flow covers a
  vetted list (Anthropic, OpenAI, Google, xAI, OpenRouter, Meta-via-OpenRouter);
  any other model still works via "Advanced — add any endpoint," it just isn't
  walked-through or cost-labelled until catalogued.
- **Model ids drift.** Vendor model names change often; the catalog is a
  point-in-time snapshot, re-verified each milestone. An unknown id still works —
  it just won't carry cost/strength metadata.
- **Cost is approximate.** The $ / $$ / $$$ tiers are order-of-magnitude ranges,
  not per-request accounting; always shown labelled "approx."
- **Meta Llama routes through OpenRouter.** Meta wound down its first-party API;
  "Meta Llama" uses an OpenRouter key scoped to `meta-llama/*`.
- **Local install needs Ollama and the disk/RAM.** NorthKeep guides you to
  install Ollama (it doesn't auto-install the daemon) and recommends a model your
  Mac can run; the pull downloads several GB. Detection is macOS-shaped, and a
  stopped-but-installed Ollama reads as "not installed" (connection-refused is
  indistinguishable from absent).
- **Hardware detection is RAM-based.** The recommendation maps total RAM to a
  model size (Apple-Silicon unified memory); it doesn't measure free memory or
  GPU specifics.

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
