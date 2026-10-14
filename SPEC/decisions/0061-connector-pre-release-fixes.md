# ADR 0061: Connector fixes before release 0.22.0 (lapsed unshare, hashed client secrets, legacy plaintext purge)

Status: Accepted, first released in 0.22.0 (2026-09-24) · Review: design CLEARED WITH WOUNDS; code recheck CLEARED · Jay accepted the recommendations · purge and secret migration run only once Production sets the D5 flags

## Context
Three defects made 0.22.0's privacy text false. Unshare was billing-gated, so a week after a subscription ended a user could not delete a shared scope (invariant #1). OAuth client secrets sat in plaintext in `client_json`. Pre-ADR-0020 plaintext rows were hidden but never deleted.

## Decision
- D1: Revocation never needs a live entitlement. A route is ungated only if it just deletes and records the caller's own data, returns at most a count, and cannot cause content to be stored or served. `DELETE /client/scope/:scope` needs only bearer ownership; other routes stay gated. A token with no account row gets `deleted: 0` and writes nothing. A new tombstone for an empty scope needs a name of at most 1024 bytes, fewer than 1000 on the account, and, when lapsed, an account stamped at least once.
- D2: Client secrets are stored only as `sha256hex(secret)`; `client_json` holds a fresh `nkcs-scrubbed:` sentinel. The SDK sees a per-process bound value, never a public client. Our check uses libsodium `memcmp`; nothing stored authenticates; bypassing it fails closed. `/token` and `/revoke` get a per-IP limiter first (50 per 15 minutes, IPv6 grouped by /56, like the SDK's).
- D3: Rows not starting with `nkc1:` are deleted by an idempotent per-process step, never in `SCHEMA_SQL`. The ADR 0020 read gate stays.
- D4: Used or expired OAuth codes and expired tokens are deleted.
- D5: Maintenance runs once per process, before the first request other than `GET /` (ADR 0063), only with `NORTHKEEP_CONNECTOR_MAINTENANCE=on`; the purge also needs `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT=on` and never runs with `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1`.

## Consequences
- Rolling back D2 after migration rejects every confidential client (fails closed); apps must reconnect.
- Limits: purged rows persist in Neon point-in-time backups for the retention window. A malformed `nkc1:` row is not purged (never served). Unsharing while lapsed deletes undelivered app rows. A lapsed user's single forget does not reach the server (unshare does); lapsed down-sync stays gated. One `X-NB-Entitlement` attestation stamps any account. D2 depends on the SDK's `client_secret` truthiness test. Retention of audit rows, tombstones, clients and accounts is unchanged. Concurrent unshares can overshoot the 1000 cap slightly.

## Rejected
- Deleting the secret field: downgrades confidential clients to public.
- Purge by default or by environment detection: unrecoverable for self-hosters.

## What leaves the machine
The original has no egress section; it states client network paths are unchanged except failure copy. The connector database holds less: hashed secrets, no legacy plaintext once purged, no dead codes; logs are counts only. "Holds only ciphertext" is true only after the purge has run in Production. No new dependency.

## Links
Depends on: ADRs 0010, 0016, 0019, 0020, 0038, 0050 · Corrects: ADRs 0019, 0038 · Amended by: ADR 0063
Full record: docs/design/adr-0061-connector-pre-release-fixes.md
