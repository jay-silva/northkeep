# ADR 0081: Entitlement attestations bind to one connector account

Status: Accepted 2026-10-23 (Jay) · Review: private security review 2026-10-22, round 1 CLEARED WITH WOUNDS (fixed)

## Context
An entitlement attestation (ADR 0019 C3) says only "active subscriber". The connector stamps a 7-day grace window on whichever account presents it and never checks the nonce, so one attestation entitles any number of accounts. The sync server mints a fresh one per request. Billing must stop being transferable without the attestation naming the subscriber. Every device on a subscription shares one connector account (all derive from one device secret), so binding costs legitimate users nothing.

## Decision
- The connector binds each attestation nonce to the first account presenting it, in a new `entitlement_nonces` table: one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE account matches … RETURNING`. Another account gets no stamp and is answered as if no attestation came.
- The sync server derives the nonce as HMAC(nonce key, sync token hash, UTC day). The nonce key is a new sync-only secret, `NORTHKEEP_ENTITLEMENT_NONCE_KEY`, that the connector never holds. With the entitlement secret set and this key missing, the mint route returns 503 rather than falling back to random nonces.
- A nonce row lives until its window ends plus the attestation lifetime, so every attestation in that window carries an already-bound nonce. Rows store a hash of the nonce, are pruned on write, and are indexed on expiry.
- If binding throws, the connector skips the stamp and falls through to the account's existing grace window, so a fault in the new table never fails a push.
- The attestation format, header and clients are unchanged. Deploy the sync server, with its key set, before the connector.

## Consequences
- Easier: a leaked or posted attestation entitles at most one account.
- Harder: one table row per subscriber per day.
- Committed to: the residual is accepted. A subscriber scripting a different account each day keeps about 7 accounts entitled. Anyone who presents a leaked attestation first can block its owner's new stamp for that day; the owner's earlier grace still applies. Grace windows already stamped through shared attestations run out within 7 days of deploy.

## Rejected
- Single-use nonces: clients resend the same attestation every push and would lock themselves out.
- An account hash inside the attestation: the sync server would learn subscriber-to-account links.
- An hourly window: it allows about 168 accounts with no benefit to real users.
- A mint rate limit alone: each attestation would still entitle unlimited accounts.

## What leaves the machine
Nothing new leaves a device. The connector now stores nonce hashes, so whoever holds the nonce key together with the sync and connector databases could link a connector account to its subscriber. Today's random nonces give no such link. The key stays in the sync server's environment only.

## Links
Design: docs/design/adr-0019-hosted-connector.md (C3) · Plan: NorthKeep project northkeep · Supersedes: 0019 C3 unchecked nonce
