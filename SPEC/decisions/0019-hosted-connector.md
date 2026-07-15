# ADR 0019 — Hosted shareable-scope connector

- **Date:** 2026-07-15
- **Status:** Proposed (C1 service under construction; the invariant re-wording and
  the full-surface adversarial review land with the beta, phase C5)
- **Deciders:** Jay (wants his memory usable inside the AI apps he already pays
  for — Claude, ChatGPT, Grok — not only NorthKeep's own client), Claude Code

## Context

NorthKeep's local Connect (ADR 0013) plugs the vault into apps running on the
SAME machine over a local stdio MCP server. Cloud apps — ChatGPT, Claude on
mobile, Manus, Grok — cannot reach a server on the user's machine; they connect
only to REMOTE MCP servers over HTTPS with OAuth. The C0 spike proved, on real
Claude and ChatGPT (including Claude on iPhone), that a self-hosted remote MCP
server with our own OAuth surfaces memory inside those apps. This ADR is the
real service behind that: the hosted connector.

The unavoidable tension: a remote server the AI's cloud calls must return
READABLE memory, so it must hold that memory in plaintext (or reversible to it).
That collides head-on with the ciphertext-only guarantee of sync (ADR 0009,
invariant #2) and the "we never see plaintext" promise. The resolution is not to
break the promise but to make it PER-SCOPE and OPT-IN: private is the default and
stays local/ciphertext-only forever; only scopes the user explicitly marks Shared
are copied to a server that can read them.

## Decision

A **separate, opt-in, plaintext-readable connector store** for shared scopes,
served to the user's own AI apps over spec-compliant remote MCP.

1. **Physically separate from sync.** Its own service (`apps/connector-server`)
   and its own Neon database, distinct from the ciphertext-only sync server and
   its DB. The sync server's "ciphertext only, cannot be made to decrypt" (ADR
   0009) stays literally true; the connector store is a different service a breach
   story can name separately.
2. **Default private; sharing is per-scope and explicit.** Nothing is shared until
   the user marks a specific scope Shared, loudly confirmed, badge-visible, and
   reversible with server-side deletion. A private scope (a lawyer's client
   matter, a patient) never reaches this store.
3. **Rows, not a vault image.** One row per shared entry in the interchange
   format, keyed by account + entry id — enables per-scope delete, SQL caps, and
   idempotent upserts without whole-blob read-modify-write. No server-side
   embeddings; retrieval reuses core's keyword/recency scoring in-process.
4. **Anonymous, device-secret-derived account + pairing.** The desktop derives a
   connector token under its own label (`nk-connector-token-v1`, distinct from the
   sync token, ADR 0009) and the server keys accounts on its SHA-256 — no email,
   no password, no PII. `POST /pair/start` returns a single-use pairing code the
   user types into the OAuth consent page, binding the AI app's OAuth grant to the
   account. All token/code/secret values are stored SHA-256-only.
5. **Self-hosted OAuth 2.1** on the MCP SDK's authorization server, persisted in
   the connector DB (NOT in-process — the C0 spike proved in-memory state dies on
   serverless): DCR, PKCE S256, RFC 9728 protected-resource metadata, RFC 8707
   audience binding. No third-party IdP.
6. **Billing inside the existing $10/mo sync subscription**; an allowlist is the
   free/comp gate for the beta. This is the managed piece the subscription is for.
7. **Content-free audit** on every tool call (account, tool, param counts, result
   ids — never content), mirroring the local MCP call log (ADR 0006 lineage).

## Invariant re-scoping (commitment; the wording ships in C5)

- **Invariant #1** gains clause (b): "…or (b) content in scopes the user has
  explicitly, individually marked Shared, which is copied to NorthKeep's connector
  store so the user's own AI apps can reach it. Default is private; sharing is
  per-scope, opt-in, loudly confirmed, badge-visible, and reversible with
  server-side deletion."
- **Invariant #2** is retitled to bind the VAULT-SYNC server verbatim as-is, plus:
  "The connector store is a separate opt-in service; it holds plaintext of shared
  scopes only, never private scopes, never keys, and derives nothing from content
  (no embeddings, no content logs, no analytics)."
- Docs to amend when the beta opens (C5): README "We never see plaintext" →
  "…unless you explicitly mark a scope Shared for the hosted connector, and then
  only that scope, and you can pull it back"; site connector card; privacy.html /
  legal/PRIVACY.md "Shared scopes (optional connector)" section; SPEC/
  security-model.md threat-table split; KNOWN-LIMITS.md connector section; TERMS.md
  takedown-on-notice (no scanning, ever). ADR 0009 and 0013 stay intact (each true
  of its scope) with a cross-reference here.

## Threat-model delta

A breach of the connector DB reveals: plaintext content + type + scope labels +
timestamps of SHARED entries; account hashes; OAuth client registrations; token
and code HASHES. It does NOT reveal: private scopes; the vault ciphertext (a
different database); passphrases, keys, or device secrets; email or card (Stripe
only, unchanged). The honest non-breach disclosure: every connected AI's provider
sees whatever it retrieves from the shared scopes — the same truth as local
Connect, now over the network.

## Retention / deletion

Unshare and forget delete the rows immediately (a content-free tombstone records
that a scope was unshared, for the audit). An account-delete endpoint wipes
everything. Entitlement lapse freezes reads, then deletes after a stated grace
period. Because only shared-scope plaintext is ever stored, deletion removes
exactly what the user chose to expose.

## Alternatives considered

- **Browser injection / proxying into other apps' chat** — fragile, a trust
  hazard, and it can't honestly firewall text typed into someone else's app.
  Rejected (the two-modes strategy is explicit about this).
- **A server-side vault image of only shared scopes** — forces whole-blob
  read-modify-write per write, defeats SQL caps and per-scope delete, and puts
  vault-decrypting code on the server. Rejected for rows.
- **A third-party OAuth IdP** (Auth0/WorkOS) — a new subprocessor for a service
  whose entire pitch is data minimization. Rejected for the SDK's self-hosted AS
  (the operational risk of owning the token surface is accepted and mitigated by
  the SDK being the reference implementation the clients test against).

## Adversarial-review checklist (before the C5 beta opens)

Scope isolation at the SQL layer (fail-closed, cross-account impossible); token/
code/secret hashing everywhere; PKCE + audience binding proven against a hostile
client; pairing-code brute-force limits (rate limit + single-use + 10-min TTL); no
content in any log, error, or audit row; unshare leaves zero recoverable rows; the
express/SDK route surface enumerated; and the invariant re-wording read back by a
design partner (the lawyer or clinician) before any real memory is shared.

## Phasing

C1 (this build): the service skeleton + Neon-backed OAuth + pairing + MCP tools
over SEEDED rows, persistence-across-instances proven. C2: desktop marks scopes
Shared + pushes real vault entries. C3: write-back down-sync + billing gate. C4:
ChatGPT hardening. C5: desktop GUI sharing UX + all the doc/ invariant amendments
above + the full adversarial review — the beta does not open before C5.
