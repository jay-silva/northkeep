# ADR 0020 — Connector at-rest encryption for shared-scope content

Status: Accepted (2026-07-21)
Supersedes: the "plaintext-readable connector store" decision in ADR 0019 (the
rest of ADR 0019 — a separate opt-in connector, per-scope opt-in, loud
confirmation, metadata visibility — still stands).

## Context

A repo-wide code review (2026-07-21) found the Cloud Connect connector stored
shared-scope memory **content as plaintext at rest** (`shared_entries.content
text NOT NULL`, no encryption anywhere in the connector). ADR 0019 had
deliberately chosen a "plaintext-readable connector store" and noted the docs
needed amending when the beta opened — but the amendment never happened, so two
binding, user-facing statements were **false**:

- Invariant #2 (CLAUDE.md): the connector "stores shared-scope content encrypted
  at rest (ciphertext only) and keeps no key in that database that can read it."
- KNOWN-LIMITS.md: "stored encrypted at rest: the database holds only
  ciphertext... A breach of the connector database alone yields ciphertext, not
  content."

For a product sold to regulated professionals (EMS/legal/therapy) on privacy,
shipping a false at-rest guarantee is unacceptable. Cloud Connect was in gated
beta but no design partners had begun testing, so there was no user data to
migrate. We chose to make the code match the guarantee (encrypt at rest) rather
than weaken the guarantee.

## Decision

Encrypt `shared_entries.content` at rest. Only the `content` column is
encrypted; scope, type, entry_hash, account_hash, counts, sizes, and timestamps
remain plaintext metadata (invariant #2 already declares metadata visible).

- **AEAD:** XChaCha20-Poly1305 (via `@noble/ciphers`; pure-JS, serverless-safe,
  audited — the connector server deliberately keeps `sodium-native` out of its
  bundle, and `@noble` is the repo's established portable-crypto choice). Random
  24-byte nonce per entry; the 192-bit nonce space makes random nonces safe with
  no counter. No hand-rolled crypto (invariant #3).
- **Key:** derived per request, never stored in the database:
  `key = HKDF-SHA256(ikm = NORTHKEEP_CONNECTOR_CONTENT_SECRET, salt =
  account_hash, info = "nk-connector-content-v1")`. The secret lives only in the
  server environment. `account_hash` is in the DB; the secret is not.
- **Format:** the content column holds `"nkc1:" + base64(nonce || ciphertext ||
  tag)`. A value without the `nkc1:` prefix (legacy plaintext) decrypts to
  `null` and is **skipped** (fail-closed, never leaked); the owner re-pushes.
- **Fail-closed:** a connector with real (Neon) content storage but no content
  secret refuses to start, mirroring the billing/entitlement fail-closed pattern.
- **Boundaries:** content is encrypted at the push handler before it reaches
  storage, and decrypted transiently at the retrieve/search boundary (in memory,
  never logged). Storage stays a dumb ciphertext store (InMemory and Neon alike).

## The honest security boundary (state this in user docs, do not overstate)

- A breach of the connector **database alone** (stolen backup, insider with
  DB-only access, legal process against the database) yields **ciphertext**, not
  content — the key is not in the database.
- The **running server** rebuilds the key from the environment secret plus the
  account identity and decrypts transiently to serve authenticated app requests.
  So a **full runtime compromise** (environment secret + code + database) is
  **not** protected. The honest claim is "we keep no key in the database that
  reads your content," never "we cannot read it."

## The "connected app's own credential" nuance (correcting invariant #2's wording)

Invariant #2 says the key is rebuilt "from the connected app's own credential
plus a secret held on our server." As implemented, the KEY is derived from the
server secret + the **account** identity, NOT the app's OAuth credential. This
is intentional and necessary: shared content is per-account and is encrypted at
**push** time by the user's device, before any specific AI app retrieves it, and
several apps (Claude, ChatGPT) can be paired to one account — so the content key
cannot be a function of one app's credential. The app's OAuth credential still
**gates access** (only a legitimately-paired, authenticated app reaches the
decrypt path); it just is not part of the key. Invariant #2's user-facing wording
in CLAUDE.md should be corrected to "a secret held in the server environment plus
your account identity, released only to an authenticated paired app" — flagged
for the owner (that file is owner-managed).

## Consequences

- Retrieval decrypts the account's entries transiently in memory to run the
  substring search and return results; slightly more per-request work, matching
  "decrypts transiently to serve each legitimate request."
- New dependency `@noble/ciphers` in apps/connector-server (pure-JS, not a
  network dependency; no invariant-#7 ADR needed for network egress).
- `NORTHKEEP_CONNECTOR_CONTENT_SECRET` becomes a required Vercel env var for the
  hosted connector; losing/rotating it makes existing shared content unreadable
  (owners re-push). Generate >= 32 bytes of entropy.
- Key-handling change: adversarial review required before merge (invariant #3).
