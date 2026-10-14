# ADR 0019: Hosted shareable-scope connector

Status: Accepted 2026-07-15, shipped as Cloud Connect (status corrected 2026-07-25) · Full-surface adversarial review required before the C5 beta; the record does not show it run · Amended by ADR 0020 (encryption at rest); corrected by ADR 0061 (deletion)

## Context
Cloud apps (ChatGPT, Claude mobile, Grok) cannot reach local Connect (ADR 0013); they need remote MCP with OAuth, proven by the C0 spike. Such a server must return readable memory, which collides with ciphertext-only sync (ADR 0009, invariant #2). The resolution: sharing is per-scope and opt-in; private scopes stay local and ciphertext-only.

## Decision
- D1: A separate service (`apps/connector-server`) with its own Neon database; the sync server stays ciphertext-only.
- D2: Default private. A scope reaches the store only when the user marks it Shared: loudly confirmed, badge-visible, reversible with server-side deletion.
- D3: One row per shared entry, keyed by account and entry id. No server-side embeddings; keyword/recency retrieval in-process.
- D4: Anonymous accounts keyed on the SHA-256 of a device-derived connector token (`nk-connector-token-v1`): no email, password or PII. `POST /pair/start` returns a single-use pairing code typed into the OAuth consent page. Token, code and secret values are stored SHA-256 only.
- D5: Self-hosted OAuth 2.1 on the MCP SDK's authorization server, persisted in the connector DB: DCR, PKCE S256, RFC 9728, RFC 8707 audience binding. No third-party IdP.
- D6: Billed inside the $10/mo sync subscription; an allowlist gates the beta.
- D7: Content-free audit per tool call.
- D8 (C4): ChatGPT `search` / `fetch` are thin account-scoped adapters over the same data path. CORS on `/register`, `/token`, `/revoke` reflects only the ChatGPT web origins.
- Commitment: reword invariants #1 and #2 to cover shared scopes and the connector store, wording to ship in C5.

## Consequences
- Threat model, current (ADR 0020): a connector DB breach alone does not reveal content or type; rows are ciphertext under per-account keys the server does not store; it sees them transiently. Scope labels, ids, counts, timestamps, entry hashes and credential hashes stay visible. Claim wording is "we don't store", never "we can't read". Private scopes and vault ciphertext are never there.
- Deletion, current (ADR 0061): unshare and forget delete rows immediately. There is no account-delete endpoint and no deletion after entitlement lapse; account deletion is manual. ADR 0061 lets unshare work without a live entitlement.

## Rejected
- Browser injection into other apps: fragile, cannot firewall typed text.
- A server-side vault image of shared scopes: whole-blob writes, vault-decrypting code on the server.
- Third-party IdP (Auth0/WorkOS): a new subprocessor.

## What leaves the machine
The original has no egress section. It adds invariant #1 clause (b): content of scopes the user explicitly marks Shared is copied to the connector store and served to the user's own connected AI apps, whose providers see what they retrieve. It states private scopes never reach this store.

## Links
Full record: docs/design/adr-0019-hosted-connector.md · Related: ADRs 0009, 0013, 0020, 0061
