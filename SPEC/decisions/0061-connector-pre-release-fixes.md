# ADR 0061: Connector fixes before release 0.22.0 (lapsed unshare, hashed client secrets, legacy plaintext purge)

- **Date:** 2026-09-24
- **Status:** Proposed. Design only, NOT reviewed, no product code on this
  branch yet. All three decisions sit behind the CLAUDE.md review gate:
  Decision 1 changes who decides (it adds a way to reach a route without the
  billing gate), Decision 2 changes how a credential is stored and checked
  (invariant #3 requires an explicit adversarial review before merge), and
  Decision 3 exists to make a published claim true ("the connector holds
  only ciphertext"). An adversarial review runs against the implementation,
  not against this prose, before merge. Merge and the production push are
  Jay's calls.
- **Deciders:** Jay (product owner; approved items 1 to 3 for 0.22.0 on
  2026-09-24), Claude Code
- **Branch:** `fix022/connector` (base `6d67dd2`)
- **Rules:** `~/Claude/Claude Context/RULES.md`, Version 2026-09-23.1
- **Depends on:** ADR 0010 (one statement per Neon HTTP call), ADR 0016 and
  0019 (the hosted connector and its billing gate), ADR 0020 (encryption at
  rest, the legacy gate), ADR 0038 addendum (tombstones), ADR 0050 (hosted
  project creation, pending rows)
- **Source of the defects:** `Reviews/release-0.22.0/legal-redlines.md`,
  code defects C1 to C6 and judgment calls J2, J3, J7, J8
- **Does not touch:** the vault, sync server, KEK derivation, row
  encryption, the DEK custody chain, redaction, or any client network path
  other than the copy shown on a failed or refused connector call. No new
  dependency.

## Context

Three connector defects make release 0.22.0's privacy text either false or
dependent on a qualifier. Every line reference below is to `6d67dd2`.

### C1: unshare is refused once the entitlement stamp lapses

`DELETE /client/scope/:scope` (`apps/connector-server/src/create-server.ts:648-676`)
runs the same billing gate as every other route: `upsertAccount`, then
`stampEntitlement`, then `isEntitled`, then 402 (lines 659-664). An
entitlement stamp lasts 7 days from the last request that carried a valid
`X-NB-Entitlement` header (`entitlement.ts:26`). `unshareScope` in
`packages/sync/src/connector-client.ts:172-188` sends no entitlement header
at all, so unshare works only while a stamp from some earlier push, pair or
sync is still live. Seven days after a subscription ends, a user cannot
delete a shared scope from our server. Invariant #1 promises sharing that is
"reversible with server-side deletion". This breaks it.

All three clients already do the right thing on failure: server delete
first, local unmark only on success (`apps/web/src/api.ts:936-953`,
`packages/cli/src/shareCmd.ts:204-235`, `apps/mobile/src/lib/connect-flow.ts:254-266`).
So the scope honestly stays marked Shared, but the user is stuck. The
desktop shows the raw "Connector server returned HTTP 402 on unshare." and
the phone shows the subscription copy ("Cloud Connect requires a NorthKeep
subscription. ...") on a failed unshare, which reads as a sales prompt when
the user is trying to delete.

Two existing documents are wrong about this. The errors are recorded here;
dated correction notes go into ADR 0038 and ADR 0019 when this ADR lands
(not in this design-only commit):
ADR 0038, Decision B says "`DELETE /client/scope/:scope` is not gated".
That is false in code. ADR 0019, Retention / deletion, promises "An
account-delete endpoint wipes everything" and "Entitlement lapse freezes
reads, then deletes after a stated grace period". Neither exists (C4, J3).

A related gap found while reading the gate: every gated route calls
`upsertAccount` *before* the gate (`create-server.ts:314, 508, 531, 659,
689, 759`). Any string of 16 or more characters used as a bearer token
creates a `connector_accounts` row, even when the request then gets 402. So
"this account exists" says nothing about whether it was ever a customer.

### C2: OAuth client secrets are stored in plaintext

The MCP SDK's registration handler (SDK 1.29.0,
`server/auth/handlers/register.js:38-49`) makes a client confidential
whenever `token_endpoint_auth_method` is anything other than `'none'`,
**including when it is absent**, and generates a 32-byte hex
`client_secret`. `ConnectorClientsStore.registerClient`
(`provider.ts:63-67`) hashes it into `client_secret_hash`, but
`NeonConnectorStorage.registerClient` (`neon-storage.ts:245-253`) also
stores `JSON.stringify(client)`, secret included, in `client_json`. The
in-memory store keeps the same object (`storage.ts:320-322`). Nothing reads
`client_secret_hash`. The header comment in `storage.ts:14-16` says the
database holds only hashes. For client secrets, it does not.

The SDK's check is the reason this is not a one-line fix.
`server/auth/middleware/clientAuth.js` does:

```js
const client = await clientsStore.getClient(client_id);
if (client.client_secret) {
  if (!client_secret) throw new InvalidClientError('Client secret is required');
  if (client.client_secret !== client_secret) throw new InvalidClientError('Invalid client_secret');
  if (client.client_secret_expires_at && ...) throw ...;
}
```

The only thing that makes the SDK authenticate a client is a truthy
`client_secret` on the object `getClient` returns. **If we simply delete the
secret from `client_json`, every confidential client silently becomes a
public client and `/token` and `/revoke` stop checking any secret.** That
downgrade is the main trap in this fix. The comparison is also `!==`, not
constant-time. It runs on `/token` (`handlers/token.js:42`) and `/revoke`
(`handlers/revoke.js:30`).

What a stolen confidential secret buys today is limited: every authorization
code is PKCE-bound and needs a pairing code the user typed, and a refresh
token is needed to refresh. It is still a credential stored in the clear
against our own stated discipline, and it is the kind of detail a security
reviewer checks first.

### C3: pre-ADR-0020 plaintext rows are hidden but never deleted

ADR 0020 made every `shared_entries.content` an `nkc1:` envelope. A row
without the prefix is legacy plaintext. `isEncryptedRow` is exactly
`stored.startsWith('nkc1:')` (`crypto.ts:196-198`). Unless
`NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1` (self-host only; the hosted
deploy does not set it), such a row is never served on `/mcp`
(`mcp.ts:173`) or `/client/pending` (`create-server.ts:715-717`). It is
also never deleted. ADR 0020's Migration section says production was wiped
at that deploy, so the count is probably 0, but no code enforces it, and
the privacy draft's "the connector holds only ciphertext" is true only if
the count is 0. Jay will run a read-only count. This design is correct
either way.

Every writer to `shared_entries` on this branch encrypts: the push route
(`create-server.ts:602-607`), `memory_remember` (`mcp.ts:377-381`),
`project_create` (`mcp.ts:756-760`) and `project_update` (`mcp.ts:931-948`)
all call `encryptRow`. `ackEntry` renames ids and never touches `content`.
`putEntry` is otherwise used only by tests. So once the legacy rows are
purged, no code path on this branch can write a new one. This must be
re-checked against the code at review time.

### C4 to C6: triage

| id | what | connector-side and small? | in this ADR |
|---|---|---|---|
| C4a | Consumed and expired `oauth_codes`, and expired `oauth_tokens`, are never deleted (their `dek_wrap` column lingers with them) | Yes. The pairing-code table already does exactly this GC (`neon-storage.ts:221`). | **Included, Decision 4.** No retention question: an expired or consumed code or token can never be used again (`getCode`, `consumeCode`, `consumeToken` all require unexpired, and codes unconsumed). |
| C4b | No deletion path for `connector_audit`, `scope_tombstones`, `oauth_clients`, whole accounts; no delete on the sync server | Not small, and it is a retention policy (how long, what the user can ask for), which is Jay's J3 decision | Out of scope. Decision 1 fixes the rule such a route must follow when it is built: it joins the lapsed-safe set. |
| C5 | A memory an app forgets stays on the connector until the device next syncs and acks | Connector-side but it is designed behavior: the forget queue exists so the forget reaches the vault (ADR 0019 C3). Deleting early would lose the forget. | Out of scope. Already disclosed (privacy redline R12). |
| C6 | The local mirror writes project files at mode 0644 | No. It is `packages/mcp-server/src/fs-safe.ts`, not the connector. | Out of scope for this branch. Small (`0600` on write plus a test); belongs on the mirror's own branch. |

## Decisions

### 1. Revocation never needs a live entitlement

**The rule.** A connector route is available without a live entitlement if
and only if all of these hold: its only effect on stored data is to delete
the caller's own data (or refresh a tombstone that records a deletion), it
returns no memory content and no stored metadata beyond a count, and it
cannot cause new content to be stored or served. Everything else stays
behind the gate. This is the test any future route (account deletion, C4b)
is held to.

**Route by route after this change:**

| route | gate | why |
|---|---|---|
| `DELETE /client/scope/:scope` (unshare) | **Bearer ownership of the connector token only.** No entitlement. | Deletes the caller's rows, returns a count. The fix for C1. |
| `PUT /client/entries` (push) | Entitlement | Stores content, which is the paid service. A lapsed user who forgets one memory reaches the server by unsharing the scope (residual R1). |
| `GET /client/manifest` | Entitlement | Returns stored metadata (ids, hashes, scopes). No client needs it to revoke. |
| `GET /client/pending` | Entitlement | Returns decrypted content. See Jay decision D1. |
| `POST /client/ack` | Entitlement | Paired with pending. See D1. |
| `POST /pair/start` | Entitlement | Connects a new app, which is service. |
| `POST /mcp` | Entitlement (unchanged) | The service itself. A lapsed account's apps get 402, so no new content can appear on a lapsed account. |
| `POST /revoke` (SDK, token revocation) | Client authentication, never entitlement-gated (unchanged) | Already revocation. |
| account deletion | Does not exist (C4b, J3) | When it is built, it is lapsed-safe by the rule above. |

Jay's two examples, answered: **pending rows** in the scope being unshared
are already removed, because `deleteScope` deletes every row in the scope
regardless of `origin` or `pending` (`neon-storage.ts:461`,
`storage.ts:403-413`). Queued forgets (`pending_forgets`, ids only) are
intentionally kept, because each one carries an app's forget to the vault
on the next down-sync. **Account deletion** has no route to exempt.

**The unshare handler, in order:**

1. Bearer token to `accountHash`, as today. Missing or short token: 401.
   Empty scope: 400, as today.
2. `stampEntitlement` as today (a valid header still refreshes the grace).
3. If `isEntitled`: `upsertAccount`, then the unshare (step 5).
4. If not entitled: look the account up with a new read-only
   `storage.hasAccount(accountHash)`. If there is no account row, answer
   `200 {"ok": true, "scope": ..., "deleted": 0}` and **write nothing**: no
   account row, no tombstone, no audit row. If the row exists, do the
   unshare (step 5).
5. The unshare is one statement (ADR 0010), a data-modifying CTE, so rows
   and tombstone move together:

   ```sql
   WITH d AS (
     DELETE FROM shared_entries WHERE account_hash = $1 AND scope = $2 RETURNING 1
   ), t AS (
     INSERT INTO scope_tombstones (account_hash, scope, unshared_at)
     SELECT $1, $2, now()
     WHERE EXISTS (SELECT 1 FROM d)
        OR EXISTS (SELECT 1 FROM scope_tombstones WHERE account_hash = $1 AND scope = $2)
        OR (octet_length($2) <= 1024
            AND (SELECT count(*) FROM scope_tombstones WHERE account_hash = $1) < 1000)
     ON CONFLICT (account_hash, scope) DO UPDATE
       SET unshared_at = GREATEST(scope_tombstones.unshared_at, EXCLUDED.unshared_at)
     RETURNING (xmax = 0) AS inserted
   )
   SELECT (SELECT count(*) FROM d) AS deleted,
          (SELECT count(*) FROM t WHERE inserted) AS new_tombstones
   ```

   Deletion is never refused. The tombstone is always written when rows were
   deleted, and always refreshed when one already exists. Only a *new*
   tombstone for a scope with no rows is bounded (name at most 1024 bytes,
   fewer than 1000 tombstones on the account). This applies on both paths,
   paid and lapsed; no real user has 1000 unshared scopes. The in-memory
   store gets identical semantics (ADR 0038 N11).
6. Append the content-free `client_unshare` audit row, and answer
   `200 {"ok": true, "scope": ..., "deleted": n}`. On the paid path the
   audit row is written as today. On the lapsed path it is written only
   when `deleted > 0` or `new_tombstones > 0`, so repeating an unshare that
   changes nothing (or only refreshes a tombstone) adds no audit row.

There is deliberately no length check that returns 400. The vault puts no
maximum on a scope name, and the push route accepts any length, so a 400 on
a long name would block revoking a scope the server already holds.

**Move `upsertAccount` after the gate** on every gated route
(`/pair/start`, `/client/manifest`, `PUT /client/entries`,
`/client/pending`, `/client/ack`). `stampEntitlement` still inserts the row
when a valid header arrives (`setEntitledUntil` is an upsert), and an
allowlisted account is upserted once it passes. After this, a new account
row means "this token passed the gate at least once". Rows created for free
before this deploy remain (residual R2). `ensureAccountDekWrap` requires
the row, and every caller runs after the gate, so nothing depends on the old
order. Verify at implementation: nothing else reads an account row between
the old and new positions.

**Why this cannot be abused for free service.** The lapsed path only
deletes. It returns a count and nothing else: no content, no ids, no
tombstone list. It cannot store content. It writes two kinds of row. A
tombstone, whose `scope` column is attacker-chosen text: bounded to existing
accounts, 1000 new rows of at most 1024 bytes each (about 1 MB per account
at worst), and write-only (tombstones are read back only through
`/client/pending`, which stays gated). And a fixed-size, content-free audit
row, written only when rows were deleted or a new tombstone was inserted, so
bounded by the same 1000 plus the rows the account had pushed while it was
paying (audit rows have no deletion path yet, C4b). All of it is throttled
by the existing `/client` rate limiter (120 requests per 5 minutes per
token, 480 per IP).
An unknown token writes nothing at all. Neither can it keep an app working:
`/mcp` stays gated, so a lapsed account's apps get 402 whatever unshare
does.

**What the client shows.** No client change is *required*. All three
clients already call the server first and unmark only on success, so the
connector deploy alone makes unshare work on every shipped client, with
today's success copy ("Scope 'x' unshared. Deleted N memories from the
connector server." on the CLI; the same facts on web and phone). The 0.22.0
clients get two copy changes, with no em dashes, no price, no link and no
purchase verb (App Store steering, `connect-flow.ts:21-24`):

- **A failed unshare** (any status) says what is true: "Could not delete
  this scope from the connector server, so it is still marked Shared. Try
  again. If it keeps failing, contact support and we will delete it." On the
  phone this replaces the subscription copy for the unshare outcome only.
  The raw "HTTP 402" string is no longer shown on the desktop.
- **A 402 on push, pair or sync** keeps its current copy and adds one
  sentence: "You can still unshare scopes, which deletes them from the
  connector."

After the connector is deployed and verified, the privacy draft's R12
parenthetical ("If your subscription has ended, the app may not be able to
unshare on its own ...") can be deleted. Not before.

### 2. Client secrets are stored only as a hash and checked in constant time by our code

Four properties, each with a test in the claims table:

- **(a) Always confidential.** A client that has a secret hash is never
  presented to the SDK as a public client.
- **(b) No pass-the-hash.** Nothing stored in the database, used as
  `client_secret`, authenticates a client.
- **(c) Constant time, in our code.** The only comparison an attacker's
  value ever reaches is ours: libsodium `sodium.memcmp` on two 32-byte
  digests.
- **(d) Bypass fails closed.** If our check is ever skipped (a route
  variant, an SDK upgrade that adds a path), authentication fails. It never
  succeeds.

**Storage.** `client_secret_hash` stays `sha256hex(secret)` (the existing
function in `hash.ts`, the same one used for every token and code hash, so
rows written since `03d7e28` already hold the right value). The secret is
SDK-generated, 256 bits of randomness, so a fast hash is the right hash;
there is nothing to grind. `client_json` never holds the real secret again.
In its place it holds a sentinel: `"client_secret":
"nkcs-scrubbed:<64 random hex>"`, fresh per row. The sentinel is what makes
rollback safe (see Rollback): code that predates this ADR compares a
presented secret against the sentinel and rejects every request, which
fails closed. Deleting the field would instead downgrade every confidential
client to public under the old code.

**Registration.** `registerClient` returns the full client, real secret
included, to the SDK, which echoes it once in the RFC 7591 response. That is
required by the spec and never stored. The stored JSON carries the sentinel
and the hash column carries `sha256hex(secret)`. Both stores behave the
same.

**Reading a client.** `getClient(clientId)` computes the effective hash:
the `client_secret_hash` column if set, else `sha256hex` of a non-sentinel
`client_secret` still in the JSON (a row the migration has not reached
yet). If there is an effective hash, the returned object's `client_secret`
is a **per-process bound value**, `"nkcsb1:" +
hex(crypto_generichash(32, effectiveHash, processKey))`. `processKey` is
32 bytes from `randombytes_buf`, made once per process and never stored or
logged. If there is no effective hash, the client is public and
`client_secret` is absent, as today. The bound value is not in the
database, so a database thief cannot present it (b), and the object is
never public when a hash exists (a).

**Checking a secret.** A new middleware is mounted before `mcpAuthRouter`
on the client-authenticating endpoints. It matches by method `POST` and by
the path normalized the way Express routes it (lowercased, trailing slashes
stripped) against the pathnames of the advertised `token_endpoint` and
`revocation_endpoint`. It parses the urlencoded body itself (same 100 KB
default limit as the SDK) and then:

- no `client_id`, or a client with no effective hash: pass through
  untouched (public-client behavior is the SDK's, unchanged);
- confidential client, no `client_secret`: pass through, and the SDK
  refuses with "Client secret is required" because the object has a
  `client_secret`;
- confidential client, `client_secret` present:
  `sodium.memcmp(sha256(presented), effectiveHash)`. On a match, replace
  `req.body.client_secret` with the bound value, so the SDK's `!==` compares
  two copies of our own value. On a mismatch, answer `400
  {"error":"invalid_client","error_description":"Invalid client_secret"}`
  (the SDK's status and body) and stop.

If the middleware is bypassed, the SDK compares the raw presented secret
with the bound value. They never match, so (d) holds. The SDK's expiry check
still runs on `client_secret_expires_at`, which stays in the JSON.

**Unverified assumption the tests must settle.** The SDK's routers use
Express 5 with body-parser 2.3.0, whose `read()` skips a request whose
stream has already been read (`onFinished.isFinished(req)`,
`body-parser/lib/read.js:40-44`) and keeps the existing `req.body`. The app
itself is on Express 4.22.2 with body-parser 1.20.6. I have not run it. A
real confidential round trip through `mcpAuthRouter` (register, authorize,
consent, `/token` with the secret, refresh, `/revoke`) is in the claims
table so this is proven by execution, not by reading.

**Migration of existing rows.** It runs in the maintenance step (Decision
5), never in `SCHEMA_STATEMENTS`. It uses one statement per call (ADR 0010)
and is safe when two cold starts run it at once:

1. `SELECT client_id, client_json FROM oauth_clients WHERE
   position('"client_secret":' in client_json) > 0 AND
   position('nkcs-scrubbed:' in client_json) = 0`.
2. For each row, in JavaScript: parse. If it does not parse, skip and
   count it (such a row is already unusable: `getClient` throws on it
   today). If `client_secret` is not a non-empty string, skip. Otherwise
   compute `h = sha256hex(secret)` and build the scrubbed JSON with a fresh
   sentinel.
3. `UPDATE oauth_clients SET client_json = $new, client_secret_hash = $h
   WHERE client_id = $id AND client_json = $old`. This is a compare-and-swap
   on the old JSON: a concurrent migrator or a re-registration makes it
   match zero rows, and the next run re-reads. The hash and the scrub land in
   the same statement, so a row can never be scrubbed without a matching
   hash. The hash is taken from the JSON, because before the scrub the JSON
   holds the secret the client actually has.
4. A second run matches zero rows (idempotent).

**Clients registered before the change** keep working with the secret they
already hold, whether or not the migration has reached their row: before,
the effective hash comes from the JSON; after, from the column. No
re-registration and no user action.

**Invariant #3.** This does not touch KEKs, DEKs, wraps, or row
encryption. It does change how a credential is stored and verified, and it
adds a per-process key, so it is treated as key handling: an explicit
adversarial-review session on the implementation before merge. Primitives:
libsodium (`crypto_generichash`, `randombytes_buf`, `memcmp`) through the
connector's existing `libsodium-wrappers`; `sha256hex` is the existing
credential hash from `hash.ts` and is kept for continuity with the stored
column. Nothing is hand-rolled. The review is asked to attack (a) to (d)
directly: route variants (`/TOKEN`, `/token/`, `/revoke`, a percent-encoded
path), a missing secret, the raw hash as the secret, the sentinel as the
secret, a JSON body instead of urlencoded, a duplicated `client_secret`
field, and a client whose JSON and column disagree.

### 3. Legacy plaintext rows are purged by an idempotent startup step

**Where.** It runs in the maintenance step (Decision 5) at the first request
of each server process. It is **not** added to `SCHEMA_STATEMENTS`, because
`SCHEMA_SQL` is exported for self-hosters to run by hand, and a delete in
there would wipe an opted-in self-host's data. No admin route: that would
be a new network-facing route needing its own gate, for a job that needs no
input.

**Skipped** entirely when `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1`.
That self-hoster has chosen to keep and serve those rows.

**The statement,** one call (ADR 0010):

```sql
WITH d AS (
  DELETE FROM shared_entries WHERE NOT starts_with(content, 'nkc1:') RETURNING 1
) SELECT count(*) AS purged FROM d
```

`starts_with` is used instead of `LIKE` so no wildcard or escape rule can
widen the match. `content` is `NOT NULL`, so there is no NULL case. The
predicate is the exact complement of `isEncryptedRow`, and a PGlite parity
test proves it over hostile inputs: `''`, `'nkc1'`, `'nkc1:'` with an empty
body, `'NKC1:x'`, `' nkc1:x'`, `'nkc1;x'`, `'nkc1:'` preceded by a BOM or a
zero-width space, a lookalike Cyrillic `с`, and valid envelopes. Only rows
`isEncryptedRow` rejects are deleted, and every one of them is deleted.

**Correct whether the production count is 0 or not.** If it is 0, the
statement deletes nothing on every run. If it is N, the first run deletes N
and every later run deletes 0 (idempotent). Nothing any user can reach is
lost either way: on the hosted deploy these rows are already never served
(`mcp.ts:173`, `create-server.ts:715-717`). A pending (app-written) legacy
row would be deleted undelivered. It was already undeliverable.

**The ADR 0020 read gate stays.** The purge runs once per process start,
so a plaintext row injected into the database afterwards is stopped only by
the gate (never served, never synced) until the next start deletes it. For
the implementer: with maintenance running at the first request, the
existing legacy-gate test in `crypto-review.test.ts` becomes
order-dependent. That test must either disable maintenance or seed its
legacy row before the server's first request, and say which.

**Logged** as a count only: `connector maintenance: purged N legacy
plaintext rows`. No content, no account hash, no ids (invariant #5, ADR 0019
content-free logs). This line is how Jay confirms the purge in production.

**What this does not reach.** Neon point-in-time recovery keeps history for
its retention window, so purged rows stay in backups until that window
passes (J7). The purge makes the claim true for the live database. A row
whose content starts with `nkc1:` but is not a valid envelope (only a
direct database writer could make one) is not purged. It is never served
either, because decryption fails and the route answers 409 or skips it.
`isEncryptedRow` checks the format, not proof of ciphertext.

### 4. Garbage-collect used and expired OAuth codes and tokens

In the same maintenance step, two single statements:
`DELETE FROM oauth_codes WHERE consumed = true OR expires_at <= now()` and
`DELETE FROM oauth_tokens WHERE expires_at <= $nowSec` (`expires_at` there
is seconds, bigint, as `consumeToken` already compares). Each row removed
also takes its `dek_wrap` with it. None of these rows can authenticate
anything (every reader requires unexpired, and codes unconsumed), so this
changes no behavior, only what a database copy holds. Counts are logged
the same way as the purge.

### 5. One maintenance step, run once per process

A new `ConnectorStorage.maintenance(opts: { purgeLegacyPlaintext: boolean })`
returns `{ purged, clientsMigrated, clientsUnparsable, codesGc, tokensGc }`.
Each part is independent. `createConnectorServer` runs it through a
memoized promise before the first request is handled (it awaits it). A
failure is logged (message only) and does not fail the request: every
reader already copes with un-migrated state (legacy rows are hidden, and
`getClient` handles both JSON forms). The promise is not cached on failure,
so the next request retries, matching `ensureSchema`'s discipline.
`missingDbStorage` in `index.ts` gets the same method (it throws, like the
rest).

## Claims and the tests that prove them

"Fails on old code" means the test is run against `6d67dd2` and fails
there. It is recorded in the review. Tests marked *guard* pass on old code
too; they pin a property that must not regress.

| # | claim | test (new file unless noted) | fails on old code? |
|---|---|---|---|
| 1 | A lapsed account (stamp expired, not allowlisted, gate on) can unshare: 200, `deleted` equals the rows it had, the rows are gone, the tombstone exists | `adr0061-lapsed-unshare.test.ts` (in-memory and PGlite) | Yes (402) |
| 2 | A lapsed unshare also deletes that scope's undelivered app-written rows and leaves `pending_forgets` intact | same | Yes (402) |
| 3 | An unknown token's unshare returns 200 `deleted: 0` and writes nothing (`dumpState` unchanged) | same | Yes (old code upserts an account row) |
| 4 | A 402 on a gated route no longer creates an account row | same | Yes |
| 5 | Lapsed: manifest, push, pending, ack, pair/start and /mcp still answer 402 | same | *guard* |
| 6 | A new empty-scope tombstone is refused past 1000 on the account or past 1024 bytes of name. Deletion and a refresh of an existing tombstone are never refused. A long-named scope with rows is still unshared and tombstoned. | same, plus `tombstone-pg.test.ts` extended | Yes (no cap) |
| 7 | Tombstone semantics of ADR 0038 and 0050 unchanged (re-share accepted, stale re-push refused with the flag on, pending purge order) | existing `tombstone-*.test.ts`, `adr0050-*.test.ts` | *guard* |
| 8 | After `/register` of a confidential client, no stored value (in-memory `dumpState`, PGlite `oauth_clients`) contains the secret | `adr0061-client-secret.test.ts` | Yes |
| 9 | Full confidential round trip through `mcpAuthRouter`: register, authorize, consent, `/token` with the secret, refresh, `/revoke`, all succeed | same | No (works today). It proves the body-parser assumption under the new code. |
| 10 | `/token` and `/revoke` refuse, with `invalid_client`: a missing secret, a wrong secret, the stored hash, the sentinel, and the bound value from another process, on `/token`, `/TOKEN`, `/token/` and `/revoke` | same | Yes (the hash and sentinel cases do not exist on old code, and old code has no hash check) |
| 11 | Bypass fails closed: calling the SDK's `authenticateClient` directly with our store and the raw correct secret (no middleware) fails | same | Yes (old code accepts) |
| 12 | Rollback fails closed: the SDK's check run against a migrated row's raw `client_json` (old `getClient` semantics) rejects every presented secret | same | n/a (proves the rollback property) |
| 13 | Migration: a seeded pre-0061 row (plaintext in JSON, hash present, or hash null) ends with the sentinel and `hash = sha256hex(secret)`, the client still authenticates with its old secret, a second run changes nothing, two concurrent runs leave one consistent row, and an unparsable row is skipped and counted | same, PGlite | Yes |
| 14 | The purge deletes exactly the rows `isEncryptedRow` rejects, over the hostile corpus, and a second run deletes 0 | `adr0061-legacy-purge.test.ts`, PGlite | Yes (no purge exists) |
| 15 | With `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1`, nothing is purged | same | Yes |
| 16 | `SCHEMA_SQL` contains no `DELETE FROM shared_entries` | same | *guard* |
| 17 | Every writer to `shared_entries` stores `nkc1:` (the ADR 0020 canary property test, `c3-property.test.ts`, run unchanged, plus a grep-based review check) | existing | *guard* |
| 18 | GC removes consumed and expired codes and expired tokens only; a live code and a live refresh token still work afterwards | `adr0061-maintenance.test.ts`, PGlite | Yes |
| 19 | Maintenance logs counts only: the captured log line contains no seeded content, account hash, or id | same | Yes |
| 20 | Clients: a failed unshare shows the new copy on CLI, web and phone; the phone no longer shows subscription copy for an unshare; a 402 on push adds the unshare sentence; no em dash | CLI, web and mobile unit tests beside the existing ones | Yes |

The full ladder must also stay green: `pnpm -r build`, `pnpm test`, and the
e2e leak test.

## Deploy order

Pushing `main` deploys the connector (and the sync server) to production.
Every push needs Jay's explicit OK for that push.

1. **Before anything ships, Jay runs read-only counts** against the
   connector's production database (queries in Acceptance, part B). They
   return numbers only, never content or secrets.
2. Implementation on this branch. Full ladder green. Adversarial review of
   the implementation (Decisions 1 to 4; Decision 2 as the invariant #3
   session), with findings written into this ADR.
3. Merge to `main`, then **the push, with Jay's OK**. This is the connector
   deploy. It must land before any client release that relies on it.
   Nothing in 0.22.0 clients *requires* it (the copy is correct either way),
   but the privacy text does.
4. Verify in production (Acceptance, part C): the maintenance log line, and
   the same read-only counts now showing 0 legacy rows and 0 plaintext
   secrets.
5. Only then: drop the R12 parenthetical from the privacy draft. The same
   deploy is what makes these existing sentences true again for a lapsed
   subscriber, so they must not ship ahead of it: `legal/TERMS.md:74` and
   `site/terms.html:50` ("You can unshare a scope at any time, which deletes
   its content"), `legal/PRIVACY.md:113` and `:283` with `site/privacy.html`
   (deletion on unshare, "unshare or delete it at any time"), and
   KNOWN-LIMITS "Unshare deletes server-side" (line 1164). Add the dated
   correction notes to ADR 0038 and ADR 0019.
6. Ship the 0.22.0 desktop and CLI with the new copy. The phone copy
   (claim 20) does not ride the connector push: it ships only in the next
   batched EAS build, which Jay cuts. Until then the phone shows the old
   subscription copy on a failed unshare, which after the deploy should
   only happen on a real error.

## Rollback

- **Decision 1:** reverting restores the 402 on a lapsed unshare. No data
  problem: tombstones written meanwhile are ordinary tombstones.
- **Decision 2:** reverting after the migration has run does **not**
  restore plaintext secrets (by design, they are gone). Old code sees the
  sentinel as the secret and rejects every confidential client with
  `invalid_client`. It fails closed: no client is ever treated as public.
  Affected apps must reconnect (re-register) until the fix is redeployed.
  Public clients (PKCE only) are unaffected. The alternative, a split deploy
  (A: verify against the hash while leaving the JSON alone; soak; B: scrub),
  keeps a clean rollback during A at the cost of two production pushes. I
  recommend the sentinel with one deploy (Jay decision D2).
- **Decision 3:** irreversible by nature. The deleted rows were already
  unreachable on the hosted deploy, and they remain in Neon point-in-time
  history until its window passes.
- **Decision 4:** irreversible and harmless (the rows could not be used).

## Residuals (documented, not closed)

- **R1.** A lapsed user who forgets a single memory does not reach the
  server (push is gated). Unsharing the scope does. Disclosed as today.
- **R2.** Account rows created for free before this deploy (by a 402'd
  request) remain. They can use the lapsed unshare path to write up to 1000
  bounded tombstones each, plus one content-free audit row per new
  tombstone, and nothing else.
- **R3.** Unsharing while lapsed deletes app-written rows that were never
  delivered to the vault. Paid unshare does the same today. See D1.
- **R4.** Purged rows persist in Neon backups for the retention window.
- **R5.** `isEncryptedRow` is a format check. A malformed `nkc1:` row
  injected by a database writer is not purged; it is also never served.
- **R6.** Decision 2 depends on the SDK keeping `client_secret` truthiness
  as its confidentiality test. Tests 10 to 12 pin it; an SDK upgrade that
  changes `clientAuth` fails them, which is intended.
- **R7.** Retention of audit rows, tombstones, clients and accounts (C4b,
  J3) is unchanged.
- **R8.** The per-account tombstone cap also applies to paying accounts.
  Past 1000, an unshare of a scope with no rows writes no new tombstone.

## Decisions Jay must make

- **D1. Should a lapsed user still be able to down-sync and ack?**
  (`GET /client/pending`, `POST /client/ack`.) It returns their own
  app-written memories, and no new ones can appear while `/mcp` is gated,
  so it is data return, not service. It does serve decrypted content
  without a subscription and widens the ungated set. **Recommendation:** not
  in 0.22.0. Keep this ADR's ungated set to revocation only, and revisit
  with the J3 retention work.
- **D2. Sentinel with one deploy, or a split deploy?** **Recommendation:**
  the sentinel (Rollback above).
- **D3. The caps:** 1000 tombstones per account and 1024 bytes per new
  empty-scope tombstone name. **Recommendation:** accept.
- **D4. Include Decision 4 (code and token GC)?** **Recommendation:** yes.
  It is small, and it shrinks what a database copy holds.
- **D5. Run the part B read-only counts** before step 3 of the deploy, and
  send Claude the numbers (numbers only).

## Acceptance (Jay)

### A. Local, from the worktree (no network, no real vault)

```sh
cd /private/tmp/claude-501/-Users-jsilva-Claude-Projects-NorthKeep/d780fa81-47b7-4048-90e5-bbb028459c89/scratchpad/wt-fix022-connector
ls -la .env                      # must print "No such file or directory"
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
pnpm -r build
pnpm exec vitest run apps/connector-server/test/adr0061-
pnpm test
ls -A "$NORTHKEEP_HOME"; rm -rf "$NORTHKEEP_HOME"   # prints nothing
```

Success: every `adr0061-` file passes, the full suite passes, and the
temporary home is empty. To see the new tests fail on the old code (claims
table), put the old connector source back, keep the new tests, run them,
then restore:

```sh
git diff --name-only --diff-filter=A 6d67dd2 HEAD -- apps/connector-server/src | xargs rm -f
git checkout 6d67dd2 -- apps/connector-server/src
pnpm exec vitest run apps/connector-server/test/adr0061-   # expect failures
git checkout HEAD -- apps/connector-server/src
git status --short apps/connector-server/src               # prints nothing
```

The first line removes source files the implementation added (a new
middleware module, for example), so a test that imports one directly
cannot pass against "old code".

Expect the connector claims 1 to 4, 6, 8, 10, 11, 13 to 15, 18 and 19 to
fail (some files may fail to compile against the old storage interface,
which also counts as failing).

### B. Production, read-only, before the deploy

In the Neon SQL editor for the **connector** database (not the sync
database). Every query only counts:

```sql
SELECT count(*) AS legacy_rows FROM shared_entries WHERE NOT starts_with(content, 'nkc1:');
SELECT count(*) AS confidential_clients FROM oauth_clients WHERE client_secret_hash IS NOT NULL;
SELECT count(*) AS plaintext_secrets FROM oauth_clients WHERE position('"client_secret":' in client_json) > 0 AND position('nkcs-scrubbed:' in client_json) = 0;
SELECT count(*) AS secret_without_hash FROM oauth_clients WHERE client_secret_hash IS NULL AND position('"client_secret":' in client_json) > 0;
SELECT count(*) AS never_entitled_accounts FROM connector_accounts WHERE entitled_until IS NULL;
```

Any result is fine. The design handles 0 and non-zero alike. Write them
down to compare with part C.

### C. Production, after the deploy

1. In Vercel's logs for the connector, find one `connector maintenance:`
   line. It shows counts only, and `purged` equals part B's `legacy_rows`
   (or 0 if another instance ran first).
2. Rerun part B. `legacy_rows` is 0. `plaintext_secrets` is 0.
   `confidential_clients` is at least the old `plaintext_secrets`.
These two checks are read-only and are the whole production acceptance.
The lapsed unshare itself is proven locally (part A, claims 1 to 4); it is
not exercised in production, because that would mean deleting a real scope
or pushing test data (RULES delivery #5), and Jay's own stamp is live, so
it would not take the lapsed path anyway.

3. Optional, and only if it is a scope you actually want unshared:
   `northkeep share remove <scope>` prints `✓ Scope '<scope>' unshared.
   Deleted N memories from the connector server.` This is a regression check
   of the paid path, not a test of the lapsed path.
4. Optional: use an AI app you already have connected (Claude or ChatGPT)
   for one tool call. This proves a real client still authenticates after
   the migration **only if** part B showed `confidential_clients` greater
   than 0 (that app registered with a secret). If it was 0, every client is
   public, the secret path has no production user, and this check proves
   nothing about Decision 2.

## Review history

- 2026-09-24: Proposed (design only). Not reviewed.
