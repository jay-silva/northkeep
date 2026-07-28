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
- **F3 (medium, recorded as a limit):** because this ADR made the synced blob
  the carrier of an egress control, a hostile-or-compromised SYNC server gained
  a consequence it did not have before: replaying an older AUTHENTIC blob (it
  cannot forge one) can resurrect a since-revoked share mark, and the next push
  re-uploads revoked content. The version number is a server-side header, not
  sealed inside the blob, so client-side monotonicity checks cannot beat a
  deliberate replay. Real fix — a monotonic counter inside the AEAD-sealed
  vault, compared on pull — is future hardening; a naive "refuse shorter
  chains" check was REJECTED because a legitimately behind device pulls a
  shorter vault in the normal diverged flow. Recorded in KNOWN-LIMITS.
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
- **F7 (info):** the vendored desktop server-tree copies still carry pre-0038
  code; they are gitignored build artifacts regenerated by build.sh. The
  installed desktop app keeps sidecar behavior until the next DMG build.
