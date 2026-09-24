# ADR 0061: Connector fixes before release 0.22.0 (lapsed unshare, hashed client secrets, legacy plaintext purge)

- **Date:** 2026-09-24
- **Status:** Accepted and built; first released in 0.22.0
  (2026-09-24). Design CLEARED WITH WOUNDS after the
  recheck; the code review recheck CLEARED it (see Review history). Jay's
  decisions D1 to D4 were accepted as recommended on 2026-09-24 ("accept
  all the recommended defaults"). The legacy plaintext purge and the
  client-secret migration run only when the connector's Production
  environment has `NORTHKEEP_CONNECTOR_MAINTENANCE=on` (and, for the purge,
  `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT=on`); until then they have
  not run. The production push is Jay's call. All three decisions sit
  behind the CLAUDE.md review gate: Decision 1 changes who decides,
  Decision 2 changes how a credential is stored and checked (invariant #3),
  and Decision 3 exists to make a published claim true ("the connector
  holds only ciphertext").
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
and only if all of these hold: its effect on stored data is limited to
deleting the caller's own data and recording that deletion (inserting or
refreshing a tombstone, and a content-free audit row), under stated bounds;
it returns no memory content and no stored metadata beyond a count; and it
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
            AND (SELECT count(*) FROM scope_tombstones WHERE account_hash = $1) < 1000
            AND ($3::boolean OR EXISTS (
                  SELECT 1 FROM connector_accounts
                  WHERE account_hash = $1 AND entitled_until IS NOT NULL)))
     ON CONFLICT (account_hash, scope) DO UPDATE
       SET unshared_at = GREATEST(scope_tombstones.unshared_at, EXCLUDED.unshared_at)
     RETURNING (xmax = 0) AS inserted
   )
   SELECT (SELECT count(*) FROM d)::int AS deleted,
          (SELECT count(*) FROM t WHERE inserted)::int AS new_tombstones
   ```

   `$3` is true on the paid path and false on the lapsed path. On the lapsed
   path a *new* tombstone for a scope with no rows also needs the account to
   have been stamped at least once (`entitled_until IS NOT NULL`), so an
   account row minted for free by a 402'd request before this deploy (R2)
   cannot write any. Counts are cast `::int` because Neon's HTTP driver
   returns `int8` as a string; the code also wraps them in `Number(...)`,
   as it already does for `entitled_until`.

   Deletion is never refused. The tombstone is always written when rows were
   deleted, and always refreshed when one already exists. Only a *new*
   tombstone for a scope with no rows is bounded (name at most 1024 bytes,
   fewer than 1000 tombstones on the account, and on the lapsed path an
   account that was stamped at least once). The name and count caps apply on
   both paths; no real user has 1000 unshared scopes. The count check is
   not serialized: concurrent unshares on one account can each see fewer
   than 1000 and overshoot the cap slightly. The overshoot is bounded by
   how many requests run at once, which the rate limiter bounds; it is
   accepted rather than paid for with a lock (R9). The in-memory
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
tombstone, whose `scope` column is attacker-chosen text: new empty-scope
tombstones are bounded to accounts that were stamped at least once, 1000
new rows of at most 1024 bytes each (about 1 MB per account at worst), and
write-only for the caller. Tombstones are read in three places: `/mcp`
(`mcp.ts:184`), the push route (`replaceScopesAcceptingReshare`), and
`/client/pending`. All three stay gated, and none returns the list. And a fixed-size, content-free audit
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

**Order on `/token` and `/revoke` (review F1).** The first draft put the
secret check ahead of the SDK router, and so ahead of the SDK's own
`/token` and `/revoke` rate limiter (`express-rate-limit`, 50 requests per
15 minutes per IP). The app's limiter skips those paths
(`THROTTLED_PREFIXES`), so wrong-secret traffic was never throttled and
every request read the database (review a2: 60 wrong secrets, 60 storage
reads, no 429). The order is now, for `POST` on those two paths:

1. the app's existing CORS middleware (it already runs before
   `mcpAuthRouter`, so a ChatGPT web origin can read our 400 and 429);
2. **a new per-IP limiter**, built with the app's own `createRateLimiter`,
   50 requests per 15 minutes per client IP (the SDK's numbers), keyed on
   Express's `req.ip` under the app's `trust proxy 1` setting, grouped the
   way the SDK's `express-rate-limit` groups it (`ipKeyGenerator(ip, 56)`:
   IPv4 as is, an embedded IPv4 as that IPv4, other IPv6 by its /56; code
   review F1 found the build keyed on the full IPv6 address, so rotating
   inside one's own /64 escaped the limit): the address the nearest proxy
   appended, never the first `X-Forwarded-For` entry, which the client
   chooses (recheck R2-F1: the fix round's first-hop key let a rotating
   first entry bypass the limit behind a proxy). It runs before anything
   parses the body or reads storage, and answers `429` with the SDK's body
   shape (`{"error":"too_many_requests",...}`) and `retry-after`;
3. the secret check below (the only step that reads storage);
4. `mcpAuthRouter`, whose own limiter still runs. A request counts once
   against each limiter; both allow 50, so the effective limit is unchanged.

The new limiter is in-memory per instance, exactly like the SDK's, so the
bound is per IP per warm instance, the same as today. An unknown
`client_id` is throttled the same way. An admitted request costs at most
two client reads (ours, then the SDK's), so the bound is at most 50
admitted requests per IP, not 50 reads.

**Proxy configuration this key assumes.** `trust proxy 1` means "exactly
one proxy in front, and it appends the real client address to
`X-Forwarded-For`". Hosted: Vercel is that proxy and, per its
request-headers documentation, overwrites the header (not verified by a
live call). Self-host: run the connector behind exactly one reverse proxy
(nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, or
Caddy's `reverse_proxy`, which appends by default). With more than one
proxy hop the key is the second-nearest proxy, not the client, and the
connector's `trust proxy` would need to change. A connector exposed
directly with no proxy trusts the client's own header, so its key is
spoofable; that is true of the SDK's limiter today, so it is not a
regression, but it is not a supported setup. The existing app IP limiter
on `/mcp`, `/pair`, `/consent` and `/client` still keys on the first hop
(`clientIp`); that is pre-existing and out of scope (R14).

**CORS.** Our 400 and 429 carry the headers the app's CORS middleware set,
which reflects only the ChatGPT web origins. The SDK's `cors()` would have
answered any origin with `*`. So a browser page on another origin can no
longer read the body of a *failed* client authentication. Successful
requests still reach the SDK and its `cors()`. Accepted: failures only, and
no browser client other than ChatGPT web is known.

**Checking a secret.** A new middleware is mounted before `mcpAuthRouter`
on the client-authenticating endpoints, after the limiter above. It matches by method `POST` and by
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

**A sentinel with no hash fails closed.** A row whose JSON holds the
`nkcs-scrubbed:` sentinel while its hash column is NULL cannot be made by
this code (the scrub and the hash land in one statement), only by a direct
database writer. The first draft's rule would have presented it as public
(review a2: accepted with no secret). Now such a row is confidential and
unusable: the middleware answers `invalid_client` for it, and `getClient`
returns a fresh random `client_secret` on every call, which nothing can
match. The maintenance step counts such rows in its log line.

If the middleware is bypassed, the SDK compares the raw presented secret
with the bound value. They never match, so (d) holds. The SDK's expiry check
still runs on `client_secret_expires_at`, which stays in the JSON.

**Body parsing, verified by the first review.** The SDK's routers use
Express 5 with body-parser 2.3.0, whose `read()` skips a request whose
stream has already been read (`onFinished.isFinished(req)`,
`body-parser/lib/read.js:40-44`) and keeps the existing `req.body`. The app
is on Express 4.22.2 with body-parser 1.20.6. The review ran a real
confidential round trip through `mcpAuthRouter` with the middleware
simulated (authorize, `/token`, refresh, `/revoke`: all 200). Claim 9 keeps
that as a test against the real implementation.

**Migration of existing rows.** It runs in the maintenance step (Decision
5), never in `SCHEMA_STATEMENTS`. It uses one statement per call (ADR 0010)
and is safe when two cold starts run it at once:

1. `SELECT client_id, client_json, client_secret_hash FROM oauth_clients
   WHERE position('client_secret' in client_json) > 0`. This is only a
   cheap prefilter on the key name, loose on purpose so a spaced key
   still reaches the parser. It deliberately does **not** exclude rows by
   searching the text for `nkcs-scrubbed:`: the first review showed that a
   client registered with `nkcs-scrubbed:` in, say, its `client_name` would
   then be skipped for good and keep its plaintext secret (review a1, a6).
2. For each row, in JavaScript: parse. If it does not parse, skip and
   count it (such a row is already unusable: `getClient` throws on it
   today). The decision is made on the **parsed** value: if
   `client_secret` is not a non-empty string, or it starts with
   `nkcs-scrubbed:`, skip. Otherwise compute `h = sha256hex(secret)` and
   build the scrubbed JSON with a fresh sentinel.
3. `UPDATE oauth_clients SET client_json = $new, client_secret_hash = $h
   WHERE client_id = $id AND client_json = $old`. This is a compare-and-swap
   on the old JSON: a concurrent migrator or a re-registration makes it
   match zero rows, and the next run re-reads. The hash and the scrub land in
   the same statement, so a row can never be scrubbed without a matching
   hash. The hash is taken from the JSON, because before the scrub the JSON
   holds the secret the client actually has.
4. A second run updates zero rows (idempotent). It still re-reads every
   row that has the key, scrubbed or not, and re-counts unparsable rows,
   on every process start. That is one small read per start, sized by
   part B's `confidential_clients`.

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

**When it runs (changed in the fix round, review note 9).** The purge is
destructive and cannot be undone, and on a self-host it is not true that
legacy rows are "already undeliverable": a self-hoster who once ran with
`NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1` was serving them, and a
pending app-written row may exist nowhere else. One restart without that
flag must not destroy them. So:

- **Everywhere, hosted included,** the purge runs only when **both**
  explicit flags are on: `NORTHKEEP_CONNECTOR_MAINTENANCE=on` (Decision 5)
  and `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT=on`. There is no
  environment inference (no `VERCEL`, no `VERCEL_ENV`). Jay sets both in
  the connector's Vercel **Production** environment only.
- **Always skipped** when `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1`
  (that operator has chosen to keep and serve the rows), even with both
  flags on.
- **A self-host,** on its own Vercel project or anywhere else, therefore
  never purges by default (recheck note 5: the fix round's "hosted
  production" test also matched a self-hoster's own Vercel production).
  The connector's self-host documentation gets one prominent line: the
  purge is off unless you set both flags, and it is permanent.

Why explicit flags rather than a default: a purge that runs by default
deletes data an operator may not know they have, which a self-hoster cannot
recover from, and an environment test cannot tell our production from
anyone else's. A flag has one meaning everywhere. The purge flag is
separate from the maintenance flag so the purge can be held back on its own
while the secret migration and the cleanup run (recheck note 4).

**The statement,** one call (ADR 0010):

```sql
WITH d AS (
  DELETE FROM shared_entries WHERE NOT starts_with(content, 'nkc1:') RETURNING 1
) SELECT count(*)::int AS purged FROM d
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
the gate (never served, never synced) until the next start deletes it. The
test suite runs off Vercel with no opt-in, so the purge is off there by
default and the existing legacy-gate test in `crypto-review.test.ts` is not
made order-dependent. The new purge tests turn it on explicitly.

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

In the same maintenance step, two single statements, each counted with the
same `WITH d AS (DELETE ... RETURNING 1) SELECT count(*)::int FROM d`
shape: delete from `oauth_codes` where `consumed = true OR expires_at <=
now()`, and from `oauth_tokens` where `expires_at <= $nowSec` (`expires_at`
there is seconds, bigint, as `consumeToken` already compares). The code
also wraps every count in `Number(...)`. Each row removed
also takes its `dek_wrap` with it. None of these rows can authenticate
anything (every reader requires unexpired, and codes unconsumed), so this
changes no behavior, only what a database copy holds. Counts are logged
the same way as the purge.

### 5. One maintenance step, run once per process

A new `ConnectorStorage.maintenance(opts: { purgeLegacyPlaintext: boolean })`
returns `{ purged, clientsMigrated, clientsUnparsable, clientsCasMissed,
clientsSentinelNoHash, clientsPlaintextRemaining, codesGc, tokensGc }`.
`clientsCasMissed` counts rows whose compare-and-swap matched nothing (a
row that misses on every run is no longer silent, recheck note 8).
`clientsPlaintextRemaining` is computed after the migration from the parsed
JSON of every row that has the key; it is the authoritative number for
Acceptance C.2.

**Whether it runs at all** is decided once per process, from two explicit
flags and nothing else (recheck R2-F2: the fix round's `VERCEL_ENV` test
missed the very case it named, because a project that hides `VERCEL_ENV`
hides `VERCEL` too, so it fell into the off-Vercel branch and ran):

- `NORTHKEEP_CONNECTOR_MAINTENANCE`: on means the secret migration and the
  code and token cleanup run. Absent, empty, or any other value means
  nothing runs.
- `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT`: on (together with the
  maintenance flag, and without `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1`)
  means the purge also runs.
- **Accepted values**, after trimming whitespace and ignoring case: `on`,
  `true`, `1`, `yes`. Everything else, including `off`, `false`, `0`, `no`
  and typos, means off. An unknown value is logged as ignored, by flag
  name only.

Jay sets both flags in the connector's Vercel **Production** environment
only, never Preview or Development. A skipped run logs one line with the
reason (for example `connector maintenance: skipped
(NORTHKEEP_CONNECTOR_MAINTENANCE not on)`), never a database name, a URL or
a flag's value beyond on or off.
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
| 9 | Full confidential round trip through `mcpAuthRouter`: register, authorize, consent, `/token` with the secret, refresh, `/revoke`, all succeed | same | No, *guard*: it works today. A compile failure of this file against old code does not count as failing for this row. Under the new code it proves the body-parser interplay. |
| 10 | `/token` and `/revoke` refuse, with `invalid_client`: a missing secret, a wrong secret, the stored hash, the sentinel, and the bound value from another process, on `/token`, `/TOKEN`, `/token/` and `/revoke` | same | No, *guard*: the first review ran every input on old code and each already returned `invalid_client`. It pins that the new check keeps refusing them. |
| 11 | Bypass fails closed: calling the SDK's `authenticateClient` directly with our store and the raw correct secret (no middleware) fails | same | Yes (old code accepts) |
| 12 | Rollback fails closed: the SDK's check run against a migrated row's raw `client_json` (old `getClient` semantics) rejects every presented secret | same | n/a (proves the rollback property) |
| 13 | Migration: a seeded pre-0061 row (plaintext in JSON, hash present, or hash null) ends with the sentinel and `hash = sha256hex(secret)`, the client still authenticates with its old secret, a second run changes nothing, two concurrent runs leave one consistent row, and an unparsable row is skipped and counted | same, PGlite | Yes |
| 14 | The purge deletes exactly the rows `isEncryptedRow` rejects, over the hostile corpus, and a second run deletes 0 | `adr0061-legacy-purge.test.ts`, PGlite | Yes (no purge exists) |
| 15 | Nothing is purged with `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT=1` (even with both flags on), or without the purge flag, or without the maintenance flag | same | No, *guard* (old code never purges). It pins the default. |
| 16 | `SCHEMA_SQL` contains no `DELETE FROM shared_entries` | same | *guard* |
| 17 | Every writer to `shared_entries` stores `nkc1:` (the ADR 0020 canary property test, `c3-property.test.ts`, run unchanged, plus a grep-based review check) | existing | *guard* |
| 18 | GC removes consumed and expired codes and expired tokens only; a live code and a live refresh token still work afterwards | `adr0061-maintenance.test.ts`, PGlite | Yes |
| 19 | Maintenance logs counts only: the captured log line contains no seeded content, account hash, or id, and the line exists | same | Yes, but only because old code has no line at all (the "line exists" assertion). The privacy half would pass vacuously on old code. |
| 20 | Clients: a failed unshare shows the new copy on CLI, web and phone; the phone no longer shows subscription copy for an unshare; a 402 on push adds the unshare sentence; no em dash | CLI, web and mobile unit tests beside the existing ones | Yes |
| 21 | Review F1: 60 `POST /token` requests with a wrong secret for a known confidential `client_id`, from one IP (the review's `a2-secret.mjs` case): at most 50 are admitted (at most two client reads each), and every request after the 50th gets 429 with `retry-after`. Same on `/revoke`. An unknown `client_id` is throttled the same way. | `adr0061-client-secret.test.ts` | No on `6d67dd2` (the SDK limiter throttles). **Fails on the first-draft order** (review: 60 reads, 0 × 429), which is what this row exists to catch. |
| 22 | A row with the sentinel in its JSON and a NULL hash column is refused with and without a secret, and is counted by maintenance | same | No, *guard* (old `getClient` shows the sentinel as the secret and refuses). Fails on the first-draft rule (review: accepted with no secret). |
| 23 | A confidential client registered with `nkcs-scrubbed:` in its `client_name` (or any other metadata) is still migrated, and part B's `plaintext_secrets` query counts it before migration and not after | same, PGlite | Yes (no migration on old code). Fails on the first-draft text filter (review a6). |
| 24 | Lapsed path: an account row with `entitled_until` NULL still gets its rows deleted and tombstoned, but cannot create a new tombstone for a scope with no rows | `adr0061-lapsed-unshare.test.ts`, PGlite | Yes (402 on old code) |
| 25 | The flag parser and gate: maintenance runs only for `on`, `true`, `1`, `yes` in any case with surrounding spaces; it does not run when the flag is absent, empty, `off`, `OFF`, `false`, `0`, `no` or a typo, whatever `VERCEL` and `VERCEL_ENV` say (including `VERCEL_ENV=production` with no flag, and neither `VERCEL` nor `VERCEL_ENV` set, the recheck's R2-F2 case); the purge needs its own flag as well, and is skipped with the purge flag off while the migration and cleanup still run; every skip logs its reason | `adr0061-maintenance.test.ts` | Yes (no maintenance on old code) |
| 27 | Recheck R2-F1: behind one appending proxy, 60 wrong-secret `POST /token` requests whose first `X-Forwarded-For` entry rotates on every request while the appended entry stays constant: at most 50 admitted, then 429 | `adr0061-client-secret.test.ts` | No on `6d67dd2` (the SDK keys on `req.ip`). **Fails on the fix-round keying** (`clientIp`, first hop): 60 admitted, no 429. |
| 29 | `ipRateLimitKey` partitions addresses exactly as the SDK's `express-rate-limit` `ipKeyGenerator(ip, 56)` does, over IPv4, IPv6, compressed, uppercase and IPv4-embedded forms | `adr0061-code-r1.test.ts` | n/a (new module; parity against the SDK's own function) |
| 30 | Code review F1: 120 wrong-secret `POST /token` requests rotating inside one /64, and across /64s inside one /56: 50 admitted, 70 refused with 429; distinct /56s are distinct clients | `adr0061-code-r1.test.ts` | **Yes on the build's full-address keying** (120 admitted, verified by restoring the pre-fix `create-server.ts`). No on `6d67dd2` (the SDK limiter grouped by /56). |
| 31 | Code review F2: `DELETE /client/scope/a%00b` answers 400 for a lapsed and a paying account with no storage call, over InMemory and PGlite; a NUL in a pushed scope, entry id or hash, a `shared_at` key, an ack id, or a `client_id` on `/token` or `/consent` is 400; the process keeps serving | `adr0061-code-r1.test.ts` | Yes (pre-fix: 200 or no response, and an unhandled rejection that printed the account hash) |
| 32 | A storage error inside any async route becomes a 500 JSON `{"error":"Internal server error."}`, logged by message only (no account hash), and the process keeps serving | `adr0061-code-r1.test.ts` | Yes (pre-fix: no response, unhandled rejection) |
| 28 | A registration whose `client_name` contains a NUL (`\u0000`) or a lone surrogate does not break the migration (it is migrated or skipped on its parsed value) or the text-based part B queries (they run and return numbers) | `adr0061-client-secret.test.ts`, PGlite | Yes (no migration on old code) |
| 26 | Counts reach clients as numbers: with a driver stub that returns `int8` as strings (as Neon's HTTP driver does), the unshare answers `"deleted": 2`, a JSON number | `adr0061-lapsed-unshare.test.ts` | Yes (old code 402s a lapsed unshare) |

The full ladder must also stay green: `pnpm -r build`, `pnpm test`, and the
e2e leak test.

## Deploy safety: never push a fix branch before merge

The connector is a GitHub-connected Vercel project. Pushing `main` is the
production deploy, and a push of any other branch may build a **preview**
deployment. Whether a preview can reach the production connector database
depends on how the Postgres URL is scoped in Vercel's environment
settings, and the repo cannot answer that: `apps/connector-server/vercel.json`
sets only `buildCommand` and `regions`, and `db-url.ts` takes whatever
Postgres URL the environment injects. Previews are known to build for this
account (the sync server's entry-point fix was verified on a preview), so
the risk is real. If a preview of this branch ran against the production
connector database, its first request would run the purge and the
client-secret scrub before the merge and before Jay's part B counts, and
the old production code would then reject every confidential client.

Two controls, both required:

1. **Process.** No `fix022/*` branch (and no branch carrying this change)
   is pushed to GitHub before it is merged. The only push is `main`, with
   Jay's OK. Local commits only until then.
2. **Code.** Maintenance runs only when `NORTHKEEP_CONNECTOR_MAINTENANCE`
   is on, and the purge only when its own flag is on too (Decision 5). Jay
   sets them in the Production environment only, so an accidental branch
   push builds a preview without them and cannot run either, whatever
   database it can reach and whatever Vercel's system-variable setting is.
   The new unshare path and secret check would still run in such a
   preview; they do not delete anything a user has not asked to delete, and
   they do not rewrite rows.

Jay can check the scoping himself, read-only: Vercel dashboard, the
connector project, Settings, Environment Variables, and look at which
environments (Production, Preview, Development) the Postgres URL and
`CONNECTOR_KEK_PEPPER` are ticked for. If the URL is ticked for Preview,
consider unticking it; a preview with no pepper and a Neon URL refuses to
start anyway (ADR 0020 pepper guard), which is another fail-safe.

## Deploy order

Pushing `main` deploys the connector (and the sync server) to production.
Every push needs Jay's explicit OK for that push.

0. Nothing on this branch is pushed before merge (Deploy safety above).
1. **Before anything ships, Jay runs read-only counts** against the
   connector's production database (queries in Acceptance, part B). They
   return numbers only, never content or secrets.
2. Implementation on this branch. Full ladder green. Adversarial review of
   the implementation (Decisions 1 to 4; Decision 2 as the invariant #3
   session), with findings written into this ADR.
3. Jay sets, in the connector's Vercel project, Settings, Environment
   Variables, **Production only** (untick Preview and Development):
   `NORTHKEEP_CONNECTOR_MAINTENANCE=on` and
   `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT=on`. Confirm
   `NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT` is not set there. Then
   merge to `main`, then **the push, with Jay's OK**. This is the connector
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
  request) remain. Since the fix round they cannot create any new
  tombstone on the lapsed path (`entitled_until IS NOT NULL` is required),
  so the first review's aggregate (1 MB times the number of such rows) is
  closed. Accounts that were stamped once can still write up to 1000
  bounded tombstones each after lapsing.
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
- **R9.** The 1000 cap is checked without a lock, so concurrent unshares on
  one account can overshoot it by roughly the number running at once.
  Bounded by the rate limiter. Not executed (PGlite has one connection).
- **R10.** Our 400 and 429 on `/token` and `/revoke` carry only the app's
  CORS headers (ChatGPT web origins), not the SDK's `*`, so another browser
  origin cannot read a failed-authentication body.
- **R11.** Whether a Vercel preview of this project can reach the
  production connector database is not answerable from the repo (Deploy
  safety). The explicit Production-only flags and the no-branch-push rule
  cover it.
- **R12.** Out of scope, recorded from the first review (note 11): an
  `X-NB-Entitlement` attestation carries no account, so one valid
  attestation stamps any connector account. It predates this ADR and bears
  on what "passed the gate once" means in Decision 1. It belongs with the
  billing bridge (ADR 0019 C3), not here.
- **R13.** The SDK's 30-day confidential secret expiry is pre-existing and
  unchanged; see Acceptance C.4.
- **R14.** The existing app IP limiter (`/mcp`, `/pair`, `/consent`,
  `/client`) keys on the first `X-Forwarded-For` hop (`clientIp`), which a
  client behind a self-hoster's proxy can choose. Pre-existing, recorded by
  the recheck (note 9), out of scope.
- **R16.** A connector entry point (`src/index.ts`) also logs and survives
  any unhandled rejection that escapes the route catch. It is not
  unit-tested (the module listens on import); the route-level catch is.
- **R17.** `/token` and `/revoke` with a non-UTF-8 `charset` now get a 415
  from our body parser before the SDK runs (code review note 4). No known
  MCP client sends one.
- **R18.** A maintenance part that fails on every run makes every request
  re-run the whole maintenance until the next deploy (code review note 3),
  as designed ("not cached on failure").
- **R15.** Rows only a direct database writer can make (a spaced or
  escaped `client_secret` key; a BOM prefix that a driver strips on read)
  may escape the migration prefilter or lose every compare-and-swap. The
  first is counted by part B, the second by `clientsCasMissed`; both fail
  loudly, not silently. Neon's handling of BOM and NUL is unverified.

## Decisions Jay must make

All four are **pending** as of the fix round (2026-09-24). The
recommendations stand.

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
  send Claude the numbers (numbers only). Optionally also check, read-only,
  which Vercel environments the connector's Postgres URL is scoped to
  (Deploy safety).

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

Expect claims 1 to 4, 6, 8, 11, 13, 14, 18 to 20, 23 to 26 and 28 to fail.
Claims 5, 7, 9, 10, 12, 15 to 17, 21, 22 and 27 are guards and may pass.
Claim 20 lives in the CLI, web and mobile test files, not the connector
ones, so check it with those suites against the old client source the
same way. A test
file that fails to compile against the old storage interface counts as
failing only for rows marked Yes; for a guard row in the same file, rerun
that row alone after restoring the new code. Claims 21, 22 and 27 are the ones
that fail on earlier drafts of this design, which never existed as code.

### B. Production, read-only, before the deploy

In the Neon SQL editor for the **connector** database (not the sync
database). Every query only counts:

```sql
SELECT count(*)::int AS legacy_rows FROM shared_entries WHERE NOT starts_with(content, 'nkc1:');
SELECT count(*)::int AS confidential_clients FROM oauth_clients WHERE client_secret_hash IS NOT NULL;
SELECT count(*)::int AS plaintext_secrets FROM oauth_clients WHERE position('"client_secret":"' in client_json) > 0 AND position('"client_secret":"nkcs-scrubbed:' in client_json) = 0;
SELECT count(*)::int AS secret_without_hash FROM oauth_clients WHERE client_secret_hash IS NULL AND position('"client_secret":"' in client_json) > 0;
SELECT count(*)::int AS secret_unexpired FROM oauth_clients WHERE position('"client_secret":"' in client_json) > 0 AND (coalesce(substring(client_json from '"client_secret_expires_at":([0-9]+)')::bigint, 0) = 0 OR substring(client_json from '"client_secret_expires_at":([0-9]+)')::bigint > extract(epoch from now()));
SELECT count(*)::int AS never_entitled_accounts FROM connector_accounts WHERE entitled_until IS NULL;
```

These queries compare text and never cast to `jsonb`. The recheck showed
that one anonymous `/register` with a NUL or a lone surrogate in its
`client_name` makes every `::jsonb` query fail with **"unsupported Unicode
escape sequence"**, so the part B and C queries do not use `jsonb` at all.
If any of them errors anyway, that message (or any other) is the thing to
report; do not substitute a different query.

Why the text patterns are safe to read: the store writes `client_json`
with `JSON.stringify`, which escapes every `"` inside a string value, so
`"client_secret":"` (quote, key, quote, colon, quote) can only match a real
key, never text inside `client_name`. Their one limit: a registrant who
puts a nested object with its own `client_secret` key into their own
metadata can move the count for their own row only. The migration never
relies on these counts; it decides on the parsed top-level value. The
authoritative after-deploy number is `clientsPlaintextRemaining` in the
maintenance log line (Decision 5).

Any result is fine for the migration and the purge; the design handles 0
and non-zero alike. `never_entitled_accounts` is no longer a tombstone risk
either: those rows cannot create new tombstones (Decision 1). Write the
numbers down to compare with part C.

### C. Production, after the deploy

1. In Vercel's logs for the connector, find one `connector maintenance:`
   line. It must not say `skipped` (if it does, the reason is on the line;
   stop and tell Claude). It shows counts only; `clientsPlaintextRemaining`
   is 0, and `purged` equals part B's `legacy_rows` (or 0 if another
   instance ran first).
2. Rerun part B. `plaintext_secrets` is 0. `legacy_rows` is 0 if
   `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT=on` was set in Production;
   if you deliberately left that flag off, `legacy_rows` is unchanged and
   the privacy sentence "holds only ciphertext" must wait until you set it
   and redeploy.
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
   the migration **only if** part B showed `secret_unexpired` greater than 0
   and that app is one of them. If `confidential_clients` was 0, every
   client is public and this proves nothing about Decision 2.
   **Do not read a "Client secret has expired" error as a migration
   failure.** The SDK gives every confidential secret a 30-day life
   (`client_secret_expires_at`; `create-server.ts` does not override it), so
   a client registered more than 30 days ago already fails today with that
   exact message. Rolling back for it would make things worse: per Rollback,
   old code then rejects *every* confidential client. The fix for an
   expired secret is that the app re-registers, which it does on reconnect.
   The 30-day expiry itself is pre-existing and out of scope here.

## Review history

- 2026-09-24: Proposed (design only), commit `5f60999`.
- 2026-09-24, first review
  (`Reviews/adr-0061/r1-first-review.md`, scripts in the review worktree's
  `.adversarial/0061-r1/`): **CLEARED WITH WOUNDS.** Executed against the
  real app and real SDK 1.29.0 with the design simulated, PGlite and
  in-memory storage only. Held: the SDK facts, the body-parser double read
  (full confidential round trip green), the refusal matrix on every path
  that reaches the SDK, bypass and rollback both fail closed, migration
  compare-and-swap, the unshare CTE and caps, an unknown token writes
  nothing, purge parity over 23 hostile strings, GC keeps live rows.
  - Flesh wound F1: the secret check ran before the SDK's `/token` and
    `/revoke` rate limiter, so wrong secrets were unthrottled and each read
    the database (60 of 60 reads, no 429).
  - Notes: claims 9, 10 and 19 mislabelled; the text filter
    `nkcs-scrubbed:` let crafted metadata hide a plaintext secret from the
    migration and from part B; a sentinel with a NULL hash read as public;
    the 30-day SDK secret expiry could be misread in acceptance C.4; the R2
    aggregate was unbounded and the Decision 1 rule text denied the
    tombstone inserts; tombstone readers were misstated; Neon returns
    `int8` as strings; cap overshoot under concurrency; self-hosters' rows
    purged irreversibly; CORS on the new 400; entitlement attestations are
    not account-bound (out of scope); preview deployments against the
    production database unaddressed.
- 2026-09-24, design fix round (this revision; design only, no code):
  - F1: a per-IP limiter (50 per 15 minutes, the SDK's numbers) now runs
    before the secret check, which is the only step that reads storage;
    order restated in Decision 2; claim 21 reproduces the review's case and
    fails on the draft order.
  - Claims 9, 10, 15 relabelled as guards, 19 qualified; acceptance A's
    expected-failure list rewritten.
  - Migration and part B decide on the parsed `client_secret`, not a text
    search (claim 23). Unparsable rows are stated as re-read each run.
  - Sentinel with NULL hash is confidential and unusable (claim 22).
  - Acceptance C.4 explains the 30-day expiry and warns against rolling
    back for it; part B adds `secret_unexpired`.
  - Lapsed new empty-scope tombstones need `entitled_until IS NOT NULL`
    (claim 24); the Decision 1 rule text now admits tombstone and audit
    inserts; R2 narrowed.
  - All three tombstone readers listed. Counts cast `::int` and wrapped in
    `Number(...)` (claim 26). Cap overshoot recorded (R9).
  - Self-host purge is now explicit opt-in; hosted production purges by
    default; reasons in Decision 3.
  - CORS on the new 400 and 429 stated (R10). Attestation binding recorded
    as out of scope (R12).
  - New Deploy safety section: no branch push before merge, and
    maintenance runs on Vercel only when `VERCEL_ENV === 'production'`
    (claim 25), because the repo cannot show whether previews reach the
    production database (R11).
  - D1 to D4 still pending with Jay.
- 2026-09-24, recheck (`Reviews/adr-0061/r2-recheck.md`): **CLEARED WITH
  WOUNDS.** F1 closed on the hosted deploy; ten of eleven notes closed or
  recorded.
  - Flesh wound R2-F1: the new limiter keyed on the first
    `X-Forwarded-For` hop, so behind a self-hoster's appending proxy a
    rotating first hop bypassed it (60 reads, no 429), a regression from
    the SDK's `req.ip` key.
  - Flesh wound R2-F2: the `VERCEL_ENV` fail-safe was unreachable in the
    case it named (hidden system variables hide `VERCEL` too), and claim 25
    tested a combination that case never produces.
  - Notes: part B `::jsonb` queries broken by a NUL in an anonymous
    registration; claim 21 read count; flag spelling and no purge-only
    opt-out; self-host on Vercel purged by default; purge and cleanup
    counts uncast; claim 20 missing from acceptance A; malformed
    writer-only rows; first-hop keying on the older app limiter.
- 2026-09-24, final design pass (this revision; **not re-reviewed**):
  - R2-F1: the limiter keys on `req.ip` under `trust proxy 1`, like the
    SDK; the self-host proxy setup is stated; claim 27.
  - R2-F2: no environment inference. Maintenance needs
    `NORTHKEEP_CONNECTOR_MAINTENANCE=on`, the purge also needs
    `NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT=on`, accepted values
    documented, Jay sets both in Production only; claim 25 rewritten.
  - Notes: purge and cleanup counts cast `::int`; claim 20 back in
    acceptance A; part B and C queries are text-only and the real error
    message is named; claim 28 covers NUL and lone surrogates; migration
    prefilter loosened and `clientsCasMissed` and
    `clientsPlaintextRemaining` added; claim 21 counts admitted requests;
    self-host (Vercel or not) never purges by default; R14 and R15 added.
  - D1 to D4 still pending; the build uses the recommendations.
- 2026-09-24, build (branch `fix022/connector`, not pushed): commits
  `9225882` (connector), `cc4311e` (connector tests), `9234946` and `47f0a69`
  (client copy and tests), `61b8975` (KNOWN-LIMITS, ADR 0038 and 0019
  corrections). Built with D1 to D4 as recommended. Awaiting the full
  adversarial review of the code.
  - Implementation notes, where the code differs in shape (not behavior)
    from the text above: the maintenance step is `runMaintenance(storage,
    config)` in `src/maintenance.ts` over storage primitives
    (`purgeLegacyPlaintext`, `gcOAuth`, `listClientSecretCandidates`,
    `casClientRow`), not a single `ConnectorStorage.maintenance` method; the
    migration lives in `src/client-secrets.ts` so storage never imports
    crypto. The unshare CTE is `ConnectorStorage.unshareScope`, and
    `deleteScope` now delegates to it with `paid: true`. There is no
    connector README, so the self-host line sits in the `src/index.ts`
    header and in KNOWN-LIMITS. The flag parser also accepts `yes`, as the
    design lists.
  - Claims to tests: 1-6, 24, 26 in
    `apps/connector-server/test/adr0061-lapsed-unshare.test.ts`; 8-13, 21-23,
    27, 28 in `adr0061-client-secret.test.ts`; 14-16 in
    `adr0061-legacy-purge.test.ts`; 18, 19, 25 in `adr0061-maintenance.test.ts`;
    7 and 17 are the existing tombstone, ADR 0050 and `c3-property` suites; 20
    in `apps/web/test/adr0061-copy.test.ts`, `packages/cli/test/adr0061-copy.test.ts`,
    `packages/sync/test/adr0061-connector-copy.test.ts` and
    `apps/mobile/test/connect-flow.test.ts`.
  - Fail-on-old, executed: with `apps/connector-server/src` at `6d67dd2`
    (added files removed), every Yes row failed and claim 5 (guard) passed;
    with the five client source files at `6d67dd2`, the claim 20 tests
    failed. Mutations: the fix-round first-hop key fails claim 27 only; no
    limiter of ours (the first-draft order) fails claims 21 and 27.
  - Ladder: `pnpm -r build`, mobile `tsc --noEmit`, full suite (2,174 of
    2,175 pass, 1 skipped; one 5 s timeout in
    `packages/mcp-server/test/project-export-run.test.ts` passed 37 of 37
    rerun alone), e2e 149 of 149. All with no database URL or pepper in the
    environment and `NORTHKEEP_HOME` in a temporary directory.
- 2026-09-24, code review (`Reviews/adr-0061/code-r1.md`, against the
  integrated build): **CLEARED WITH WOUNDS.** Credential handling held on
  every path attacked (bypass, rollback and migration fail closed, also
  against the real `6d67dd2` code on a shared database); maintenance deleted
  exactly the intended rows over a nine-table diff; 22 of 24 source
  mutations were caught.
  - Flesh wound F1: the `/token` limiter keyed IPv6 on the full address, so
    rotating inside one /64 escaped it (120 reads, no 429), a regression
    from `6d67dd2`, where the SDK grouped by /56.
  - Flesh wound F2: `DELETE /client/scope/a%00b` crashed the process (an
    unhandled rejection from Postgres), printing the account hash, and the
    ungated unshare put that in non-customers' hands.
  - Notes: claim 4 covered three of five gated routes (two mutations
    survived); the unshare failure copy was false when the server delete
    succeeded and only the local save failed; KNOWN-LIMITS "an unknown
    credential writes nothing" ignored R12; maintenance retries every
    request on a permanent part failure; a non-UTF-8 charset gets 415.
- 2026-09-24, code fix round (not re-reviewed):
  - F1: `src/ip-key.ts` groups like `ipKeyGenerator(ip, 56)`; claim 29
    proves the same partition against the SDK's own function, claim 30 the
    /64 and /56 floods.
  - F2: a NUL in any scope, id, hash, `shared_at` key or `client_id` is a
    400 before storage; every async route is wrapped so a rejection becomes
    a 500 logged by message only; the entry point logs and survives an
    unhandled rejection (R16). Claims 31 and 32.
  - Notes: claim 4 now covers all five gated routes; a new
    `UNSHARE_LOCAL_SAVE_FAILED_MESSAGE` on CLI, desktop and phone when the
    server delete succeeded but the local save failed (claim 20 tests);
    KNOWN-LIMITS corrected for R12 and the /56 grouping; R17 and R18 record
    the charset and retry notes.
- 2026-09-24, code recheck (`Reviews/adr-0061/code-r2-recheck.md`):
  **CLEARED**, no findings. Follow-up on its notes (not re-reviewed): the
  phone no longer appends "The server copies were not removed" to an
  unshare failure (it contradicted the local-save message); `/consent`
  refuses a control character or a duplicated value in any field it reads
  with a 400 before storage, so a NUL cannot spend the pairing code and
  then 500; tests now catch the five mutations that survived the recheck
  (NUL in entry fields, `shared_at` and ack `forgets`, the IPv6 zone-id
  strip, and an error handler that logs the whole error object).
