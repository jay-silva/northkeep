# ADR 0038: Shared-scope state belongs in the vault

Status: Accepted 2026-07-28, Decision 3 overruled by Jay; addendum (D5, D6) shipped in 0.20.0, 2026-08-26 · Review: against code 2026-07-28 (F1 to F7, actionable ones fixed); two reviews of the addendum 2026-08-26 · Corrected by ADR 0061

## Context
The shared-scope list lived in the per-device sidecar `~/.northkeep/connector.json`, so devices on one account disagreed. That list is an egress control (invariant #1(b)); syncing it lets one device's decision change what another transmits.

## Decision
- D1: A vault `scopes` table (`scope`, `shared`, `shared_at`), schema 0.3, created empty: nothing shared until marked.
- D2: The export carries a `scopes` key (invariant #4); a 0.2 export without it means nothing shared.
- D3 (Jay, 2026-07-28, reversing a per-device pending flow): a share or unshare made on one device takes effect on every device after sync without re-confirmation; the confirmation copy states the mark applies on all devices signed into this vault.
- D4: `connector.json` keeps the server URL only; a one-time fold-in moves the local list into the vault and cannot add a share.
- D5 (addendum A): `vault_meta.sync_generation`, an integer inside the sealed blob (schema 0.4). Incremented before upload inside `pushVault`'s file lock; pulls (`pullVault`, `pullVaultMobile`) refuse a lower generation and leave the local vault untouched. A phone conflict re-push sets `max(local, remote) + 1`. The field is exported.
- D6 (addendum B): `PUT /client/entries` rejects the whole push with 412, naming each scope, when a scope's latest tombstone `unshared_at` is `>=` the client's `shared_at`; a check error fails closed. `shared_at` is set only on a private-to-shared transition in `setScopeShared`. Old clients (no `shared_at`) pass only with no tombstone. Enforced behind `CONNECTOR_TOMBSTONE_ENFORCE`, set to 1 on production 2026-08-26.
- `DELETE /client/scope/:scope` is not billing-gated since ADR 0061 (before that it was, contrary to the original wording).

## Consequences
- Harder: schema 0.3, then 0.4; a 0.3-only build cannot open a 0.4 vault.
- Limits (KNOWN-LIMITS): a second device that never confirmed can still push, but it holds the full decrypted vault anyway; equal-generation forks are unordered, so a hostile sync server can swap them; a first pull on a fresh machine cannot prove the blob is newest; clock skew or fabricated `shared_at` remain; a Time Machine restore of a pre-0038 `connector.json` cannot re-stamp shares.

## Rejected
- Per-device confirmation of synced marks: overruled by Jay.
- Refusing shorter chains: a legitimately behind device pulls a shorter vault.
- Reusing ADR 0020's 409: clients map it to a re-push instruction.

## What leaves the machine
The original has no egress section. Decision 3's reasoning states that a mark made on one device lets every device on the vault push that scope to the same account's connector store, "no new recipient, no new content class", and unshare must still delete server-side. Pushes now carry a per-scope `shared_at`; tombstones are content-free.

## Links
Full record: docs/design/adr-0038-shared-scopes-in-the-vault.md · Supersedes: the C2 sidecar decision in `packages/sync/src/connector-config.ts` · Related: ADRs 0010, 0020, 0061
