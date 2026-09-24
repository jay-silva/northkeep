# ADR 0038: Shared-scope state belongs in the vault

- **Date:** 2026-07-28
- **Status:** **ACCEPTED 2026-07-28, with Decision 3 overruled by Jay** (see the
  revised Decision 3 below). Written because Jay asked that "everything about
  the vaults should sync including the scopes; desktop and mobile should be an
  exact match," and later clarified the intended semantics explicitly: "when you
  include or exclude a scope on your mac it should match on your phone." That is
  a schema change AND a change to who decides what leaves the machine, so it
  ships under the CLAUDE.md review gate: this ADR, an adversarial review against
  code, findings recorded here.
- **Supersedes:** the sidecar decision recorded in
  `packages/sync/src/connector-config.ts` (C2), which deferred exactly this.

## The problem

Cloud Connect's shared-scope list lives in `~/.northkeep/connector.json`, a
per-device sidecar. Sync moves the vault blob and nothing else, so two devices
signed into the same account disagree about what is shared. Today the desktop
shares six scopes and the phone shares whatever was set there. Neither device
can see the other's list, and nothing reconciles them.

The C2 comment states the intended fix plainly — keep the list inside the
encrypted vault so it follows the vault through sync — and defers it because it
touches the vault image and the invariant-#4 export surface. Both of those are
still true. What has changed is that the divergence is now a real, observed
problem rather than a theoretical one.

## What makes this more than a schema change

A vault currently has no scope metadata at all. A scope is a lowercase string on
an entry (`SPEC/memory-schema.md` §Scopes); there is no table describing a scope,
so "shared" has nowhere to live without new structure.

That is the easy half. The hard half is that **the shared-scope list is an
egress control, not a preference.** `packages/cli/src/shareCmd.ts` reads
`cfg.sharedScopes` and pushes exactly those scopes' content to the connector
server. Invariant #1(b) permits that only for scopes the user has "explicitly,
individually marked Shared," and requires the marking be "per-scope, opt-in,
loudly confirmed, badge-visible, and reversible."

Syncing that list means a decision made on one device changes what a *different*
device is willing to transmit. Marking `client:acme` Shared on the phone would,
after a sync, make the desktop willing to push that scope's content to the
connector store — on a machine where nobody confirmed anything. The confirmation
dialog that invariant #1 relies on happens once, on one device, and its
authority then travels.

That is the crux, and it is why this cannot be a quiet refactor.

## Decisions

### 1. Shared-scope state moves into the vault, in a new `scopes` table

Schema version 0.2 → 0.3, with a forward migration that creates the table empty
(no scope is shared until explicitly marked, preserving default-private).

As implemented:

```sql
CREATE TABLE IF NOT EXISTS scopes (
  scope       TEXT PRIMARY KEY,
  shared      INTEGER NOT NULL DEFAULT 0,
  shared_at   TEXT           -- ISO 8601, when the mark was last flipped on
);
```

The earlier sketch also carried `shared_by` (which device made the mark) to
support the original Decision 3's pending-confirmation flow. With that decision
overruled (below), `shared_by` serves no function and is dropped — the smallest
schema that carries the state.

### 2. The export carries it (invariant #4)

Invariant #4 requires an export be complete enough to rebuild an equivalent
vault. A shared mark is user state, not derived cache, so it MUST appear in the
export — unlike embeddings, which §Embeddings explicitly excludes. This adds a
`scopes` key to the export document alongside `memories`, and bumps
`schema_version` to `0.3`.

An importer reading a 0.2 export gets no `scopes` key and MUST treat that as
"nothing shared" rather than "unknown", which is the fail-closed reading.

### 3. A synced mark takes effect on every device — OVERRULED AND REVERSED by Jay, 2026-07-28

As originally proposed, this decision said a mark arriving via sync would sit
pending until confirmed on the receiving device. Jay overruled it: "when you
include or exclude a scope on your mac it should match on your phone." A shared
mark (and an unshare) made on one device takes effect everywhere after sync,
with no per-device re-confirmation.

Recorded reasoning for why this is defensible under invariant #1, not just
convenient:

- **The disclosure has already happened when the mark is made.** Marking a
  scope Shared on the Mac pushes that scope's content to the connector store
  right then, from the Mac. Both devices hold the same synced vault and talk to
  the same account's connector store. When the phone later honors the synced
  mark and pushes, it sends the same scope of the same vault to the same
  recipient — no new recipient, no new content class. The mark crossing devices
  does not widen what left the machine; it keeps a second copy of the vault
  from silently *contradicting* a decision already made and acted on.
- **Scope-level consent is already forward-looking.** A confirmed share has
  always covered memories added to that scope later, pushed without
  re-confirmation. Consent attaches to the scope within the account, not to a
  device or a point in time. Same-account devices inheriting the mark is the
  same semantic.
- **The confirmation copy must say so.** The share-confirmation dialog is
  updated to state that sharing applies to this scope on all devices signed
  into this vault. That keeps the "loudly confirmed" requirement honest about
  what is being confirmed.
- **Unshare propagates the same way**, which is strictly good: revocation made
  anywhere reaches every device, rather than a forgotten device continuing to
  re-push a scope the user believes is private again.

What is lost relative to the original proposal: a stolen-or-shared *second*
device can no longer be prevented from pushing by the fact it never confirmed —
but such a device holds the full decrypted vault anyway, so the pending flow
never provided a real boundary there (a compromised device is outside the
threat model, per invariant #2's own caveat).

### 4. `connector.json` keeps the server URL only

The server URL is genuinely per-device configuration (a self-hoster may point
one machine at a different connector). `sharedScopes` is removed from it, with a
one-time migration that folds any existing local list into the vault as
*confirmed on this device*, so Jay's current desktop setup is not silently
revoked.

## What the adversarial review must check against code, not against this prose

1. That a 0.2 → 0.3 migration cannot mark a scope shared that was not shared
   before, on any path including a partially-written vault.
2. That the export round-trips: export a 0.3 vault, rebuild, and confirm the
   shared set is identical and the chain still verifies.
3. That a hostile or buggy sync server cannot flip a scope to shared. The blob
   is ciphertext and authenticated, so this should hold — but it must be checked
   rather than assumed, because it is now the mechanism by which an egress
   control crosses machines.
4. That every path that pushes scope content to the connector reads the shared
   set from the VAULT and only from the vault — no surviving code path reads
   `sharedScopes` from the sidecar (a stale sidecar re-sharing an unshared scope
   would be the worst regression this change can produce).
5. That unsharing propagates. A scope unshared on one device must not stay
   shared on another, and unshare must still delete server-side (invariant #1's
   "reversible with server-side deletion"). Check the second device cannot
   re-push a just-unshared scope from a stale in-memory list.
6. That the share-confirmation copy states the mark applies to all devices on
   this vault (the revised Decision 3 leans on this), and that the sidecar
   fold-in migration cannot ADD a share that the sidecar did not already have.

## Consequences

- Two devices converge on one shared-scope list, which is the point.
- A share or unshare made anywhere takes effect everywhere after the next sync
  — including unshare-as-revocation, which now actually propagates.
- Vault schema and export format both move to 0.3; every reader of the export
  format is affected.
- The C2 sidecar rationale is retired.

## Status of this record

Accepted and implemented 2026-07-28 (schema 0.3, scopes table, sidecar fold-in,
desktop CLI + web GUI + mobile wired to the vault). The adversarial review of
the six items above runs against the implementation; its findings are recorded
at the end of this document per the CLAUDE.md gate.

## Adversarial review findings (2026-07-28, run against the implementation)

The review verified all six checklist items against code and ran the unit
suites. Items 1 (migration cannot invent a share), 2 (export round-trip),
3-as-stated (a hostile sync server cannot flip a never-shared scope: AEAD with
the header as associated data, open-verify before replace, and every
setScopeShared caller traces to a user action or the fold-in), 4 (every push
path reads the vault only; the converse containment gate fails closed), and the
CLI/web halves of 5 and 6 came back CLEAN, with the negative results recorded
in the review transcript. Findings that required action, all fixed same-day:

- **F1 (medium, fixed):** the mobile share rollback unmarked the scope
  unconditionally on push failure. If the scope was ALREADY shared (marked on
  another device, arrived via vault sync while the screen's state was stale),
  the rollback revoked a legitimate mark with no server delete — every device
  would then claim Private while the connector kept the rows. Now guarded by
  `wasShared`, same as the web route; regression test added
  (connect-flow.test.ts "never rolls back a scope that was already shared").
- **F2 (medium, fixed):** the mobile share confirmation never said the mark
  applies across devices — the exact sentence the revised Decision 3 leans on.
  Added.
- **F3 (medium, recorded as a limit 2026-07-28; follow-up specified in the
  2026-08-26 addendum below):** because this ADR made the synced blob
  the carrier of an egress control, a hostile-or-compromised SYNC server gained
  a consequence it did not have before: replaying an older AUTHENTIC blob (it
  cannot forge one) can resurrect a since-revoked share mark, and the next push
  re-uploads revoked content. The version number is a server-side header, not
  sealed inside the blob, so client-side monotonicity checks cannot beat a
  deliberate replay. A naive "refuse shorter chains" check was REJECTED because
  a legitimately behind device pulls a shorter vault in the normal diverged
  flow. Recorded in KNOWN-LIMITS until the addendum ships as 0.20.0.
- **F4 (low, fixed):** both fold-ins could lose the legacy list in a crash
  window (desktop stripped the sidecar before the vault was saved; mobile
  deleted a corrupt SecureStore value it had not folded). Both now save the
  vault first and only then strip the source; mobile leaves a corrupt value in
  place. Crash between the two now refolds (additive no-op) instead of losing
  shares.
- **F5 (low, fixed):** CLI `share add` had no push-failure rollback (web and
  mobile did). Now rolls back an unaccepted new mark, never a pre-existing one,
  with copy that says which happened.
- **F6 (info):** no automated test pins the locked contract of
  `/api/share/status` (code verified correct: null while locked, clean 423 on
  locked unshare). Acceptable gap; noted for the next e2e pass.
- **F7 (info, closed 2026-08-26):** the vendored desktop server-tree copies
  still carry pre-0038 code; they are gitignored build artifacts regenerated by
  build.sh. Closed by the 0.19.0 DMG (`v0.19.0`).

---

## Addendum 2026-08-26: F3 counter + connector tombstone enforcement (0.20.0)

- **Status:** **ACCEPTED and IMPLEMENTED** (M17, 2026-08-26). Shipped in
  0.20.0 (`v0.20.0` / `1b9f349`). `CONNECTOR_TOMBSTONE_ENFORCE=1` flipped
  on production 2026-08-26. Two adversarial reviews (2026-08-26) pinned
  B1–B4 / M1–M2 and planner N1, N3, N10 plus N4–N6, N9; those patches
  shipped with the implementation.
- **Does not change:** Decision 3 (share marks apply account-wide after sync),
  AEAD header-as-AD, open-verify-before-replace, connector crypto wording.

### Why now

0.19.0 shipped projects, Cursor Connect, and the session contract. The two
remaining 0038 windows are trust, not polish: a compromised sync server can
resurrect a revoked share by serving an older authentic blob, and a lagging
device can re-push a scope the user just unshared because `PUT /client/entries`
never consults `scope_tombstones`.

### Decision A: monotonic counter inside the sealed vault

`vault_meta` key `sync_generation` (integer, start at 0 on 0.3 → 0.4
migration and on `Vault.create`). It lives in the SQLite image, so it is
inside the AEAD ciphertext. The sync server cannot alter it without failing
open-verify. Store and compare as an integer (`parseInt`); TEXT `"10" < "9"`
is a refuse-legitimate-newer bug. Missing key reads as 0. Invalid value
fail-closed, local vault untouched.

**Increment inside the blob before upload, under the file lock, and keep the
increment even if the server returns 409.** Never increment after ACK (the
server would never see it). Never increment in `save` or `migrate`.
Unlock-to-push is mandatory and pinned per caller (planner N3):
- CLI `syncPush` resolves the key the same way `syncPull` does
  (`resolveMasterKey`, else passphrase prompt). Headless
  `northkeep sync push` without Keychain then blocks on a prompt.
- Web `POST /api/sync/push` returns 423 with unlock copy (pull already
  gates; push does not today). GUI updated.
- Mobile is already post-save with the key in memory.
The increment-open-save happens **inside** `pushVault`'s existing
`withFileLock`. That lock is non-reentrant (5s timeout). A caller that
already holds it must not call `pushVault`; pass an already-open vault or
do the increment inside the lock `pushVault` already takes. Pin: inside
`pushVault`'s lock.

**Phone LWW (planner N1).** `runSyncAfterSave` re-pushes the phone's own
bytes unchanged after a vault 409. A phone stuck at generation 5, while
the Mac has pushed 6–8, increments 5→6, loses the 409, re-pushes gen 6,
and the server now holds 6. The Mac is at 8: pull refuses, push 409s,
"pull first" loops. Ordinary two-device race, no attacker. **LWW conflict
re-push must set generation to `max(localGen, fetchedRemoteGen) + 1`
before re-uploading.** The phone already opens the remote in
`verifyBlobOpensWithKey`; read generation there. Add that scenario to the
execute-list.

**Equal generations are unordered (planner N2).** Two devices incrementing
from the same base produce two authentic blobs with the same generation.
A hostile sync server can swap those branches. A scalar counter cannot
order forks. Decision B is the egress backstop. Record in KNOWN-LIMITS.

**Compare on pull** after open-verify/migrate, before replacing the local
file, in **both** `pullVault` (`packages/sync/src/client.ts`) and
`pullVaultMobile` (`apps/mobile/src/lib/sync.ts`). The phone does not call
the desktop client. If pulled < local, refuse with clear copy, local vault
untouched. Equal or greater: accept.

Opening the local vault to read generation must not increment. Opening a
pulled 0.3 blob will migrate the temp file, insert generation 0, and
re-encrypt; that 0 is the correct compare value. Mobile
`verifyBlobOpensWithKey` currently migrates a tmp then deletes it and
installs the original unmigrated bytes; the 0.20.0 phone pull must compare
against the same generation the desktop would.

**Fresh machine (no local vault):** nothing to compare. Accept. Residual:
a first pull on a new device cannot prove the blob is the newest authentic
one.

**Export `sync_generation` (planner N9).** JSON rebuild that resets to 0
makes every peer refuse the rebuilt vault as a replay (same trap as N1).
No JSON importer ships today; pinning the field now is cheap. `.nkv`
ciphertext import keeps it. Manual Files `.nkv` import on the phone is a
deliberate user action, treated as a fresh machine (planner N8).

**Schema 0.4.** `SCHEMA_VERSION` and `northkeep_export.schema_version` move.
Enumerate every reader. A 0.3-only build cannot open a 0.4 vault.
Release notes: update every device before the first 0.20.0 push.
**Mobile EAS/TestFlight before Jay's Mac migrates a synced vault.**

Phone last-writer-wins is pinned under N1: conflict re-push bumps generation
to `max(local, remote) + 1`. A higher-generation LWW blob that restores a
revoked share mark is still a residual that Decision B covers.

Adversarial review must execute: replay an older authentic blob and show
refuse; behind and diverged pulls still succeed; local-edit-then-pull of a
newer server blob is not blocked; behind-phone LWW re-push, then Mac pull
succeeds.

### Decision B: connector push fails closed on a tombstoned scope

`PUT /client/entries` currently calls `replaceScopes` and never reads
`scope_tombstones`. Unshare already writes a content-free tombstone.

**Fail closed.** If any pushed scope has a tombstone whose latest
`unshared_at` is `>=` that scope's client-supplied `shared_at`, reject the
whole push. Name every conflicting scope in the body. The other still-shared
scopes are not permanently stuck: the user can unshare the conflicting one
locally (`DELETE /client/scope/:scope` is not gated) and push the rest.

**Correction 2026-09-24 (ADR 0061):** "is not gated" was false when
written. Until ADR 0061, `DELETE /client/scope/:scope` ran the billing gate
like every other connector route and answered 402 once an account's
entitlement stamp lapsed. ADR 0061 removes the entitlement check from that
route only; it is now covered by bearer ownership of the connector token.

**Do not reuse ADR 0020's 409. Pin 412 (planner N4).** Every client switches
on status only and never reads error bodies (`pushSharedScopes`). A "409
with a distinct error field" is unimplementable without breaking that
convention, and 0.19.0 maps connector 409 to copy that tells the user to
run `northkeep share push`. Update CLI/web/mobile. 412 on old clients is a
generic failure, not a re-push loop.

**Which timestamp.** `scope_tombstones` has no unique-on-scope; every
unshare INSERTs. Checking the oldest row loses after a second unshare.
**Dedup production rows to `MAX(unshared_at)` per `(account_hash, scope)`,
then `UNIQUE` (idempotent single statements, ADR 0010).** Runtime: upsert.
On accepted re-share, **conditionally** delete only tombstone rows whose
`unshared_at <=` the `shared_at` that justified acceptance. Check +
`replaceScopes` + that delete run in **one Neon transaction**. An
unconditional delete after accept races a concurrent unshare and erases
the new tombstone (planner N5). In-memory storage must use the same upsert
semantics as Neon so route tests mean anything (planner N11). Executable
Postgres coverage (pglite or a live staging Neon check) before the
enforcement flag flips.

**Deliberate re-share.** One connector token per account. Client sends
per-scope `shared_at`. Accept when parsed UTC `shared_at > unshared_at`.
**Only set `shared_at` on a private→shared transition, inside
`setScopeShared` (planner N6).** One choke point: if the row is already
`shared = 1` and no explicit timestamp is given, keep the old `shared_at`.
Callers (CLI, web, mobile, both fold-ins) must not each reinvent this.
Residual: a Time Machine restore of a pre-0038 `connector.json` cannot
re-stamp shares unless the vault itself is also rolled back. Fold-done is
pinned even when the sidecar was already stripped (0.19.0 upgrade) or
absent. Mobile SecureStore is this-device-only; absent key pins fold-done,
corrupt value is left unmarked (F4).

No tombstone expiry. Clock skew / user-set clock / fabricated `shared_at`
remain residual (honest-lag, not a proof). Record in KNOWN-LIMITS.

**Old clients (0.19.0 and earlier)** send no `shared_at`.
- No tombstone ⇒ 200 (first-share and never-unshared stay up).
- Tombstone + missing `shared_at` ⇒ 412.

**Enablement (planner N10).** Pushing main deploys the connector. Production
already holds stale tombstones for scopes that were unshared and later
re-shared (insert-only, never deleted). Flipping enforcement with no flag
would 412 **every** 0.19.0 user's whole shared push, not just re-shares.
**Ship the check behind `CONNECTOR_TOMBSTONE_ENFORCE` (env).** Deploy dark.
Enable after 0.20.0 clients exist. Presence of per-scope `shared_at` in the
payload is the client-version signal; no extra header. A 0.20.0 client's
first accepted push self-heals stale tombstones via the conditional delete
when `shared_at` postdates the unshare. 412 copy is written for 0.20.0
clients to render. Release notes tell 0.19.0 users to update to re-share.

Push payload change: `packages/sync/src/connector-client.ts` plus
CLI/web/mobile. Tests on `neon-storage.ts`, including the no-tombstone
0.19.0 path. A check error fails closed (500/503 on writes). Fail-open
re-opens the window. A bug that refuses every push is an outage, not a
revocation bypass; prefer the outage.

### Sequencing (completed)

ADR addendum → two adversarial reviews → Jay confirmed → M17 implementation
→ Jay's per-push OK (`f553543`, still dark) → EAS/TestFlight 25 → desktop
0.20.0 DMG (`v0.20.0` / `1b9f349`) → Jay flipped
`CONNECTOR_TOMBSTONE_ENFORCE=1` on production 2026-08-26. Phone and Mac are
both on 0.20.0.

### Execute-list coverage (2026-08-27)

Replay refuse is pinned at `packages/sync/test/sync.test.ts` (older
`sync_generation` leaves the local file unchanged). Behind-phone LWW is
pinned at `apps/mobile/test/sync-flow.test.ts`. Desktop behind-pull onto an
existing vault, and local-edit-then-pull of a newer server blob, are pinned
in `packages/sync/test/sync.test.ts`. Residuals N2 (equal-generation forks),
fresh machine (first pull has nothing to compare), and honest-lag timestamps
remain in KNOWN-LIMITS by design.

### Out of this addendum

Curator. Site funnel. Further 0038 F6 e2e. Revoking the July 11 Developer ID
certificate (private key gone; leave it, revocation would hit already-shipped
0.18.0 apps).
