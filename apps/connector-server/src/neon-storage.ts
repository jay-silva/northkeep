import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  MAX_NEW_TOMBSTONE_SCOPE_BYTES,
  MAX_TOMBSTONES_PER_ACCOUNT,
  NO_VAULT_CLAIM,
  StalePushError,
  type ConnectorRowInsert,
  type VaultOrderClaim,
  type ConnectorAuditEntry,
  type ConnectorStorage,
  type OAuthGcResult,
  type ScopeTombstone,
  type StoredClientRow,
  type SharedEntry,
  type StoredOAuthCode,
  type StoredOAuthToken,
} from './storage.js';
import { findTombstoneConflicts, TombstoneConflictError } from './tombstones.js';

/**
 * Neon Postgres storage for the connector. Mirrors apps/sync-server/neon-storage.ts:
 * self-provisioning schema, and — critically — ONE statement per driver call
 * (ADR 0010, the hard constraint that once took the sync server down: Neon's
 * serverless HTTP driver executes a single statement per call, so a
 * multi-statement string throws at runtime and 500s every request). Never join
 * these for execution; add a table by appending a NEW ARRAY ENTRY.
 *
 * Single-use codes (pairing + authorization) are consumed with a single atomic
 * `UPDATE ... WHERE ... AND consumed = false AND expires_at > now() RETURNING ...`
 * so there is no read-then-write race and no double-spend.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connector_accounts (
  account_hash text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now()
)`,
  // C3 billing grace window: ms-since-epoch through which this account is
  // entitled (stamped when the desktop forwards a valid entitlement). Idempotent.
  `ALTER TABLE connector_accounts ADD COLUMN IF NOT EXISTS entitled_until bigint`,
  `CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash    text PRIMARY KEY,
  account_hash text NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id          text PRIMARY KEY,
  client_json        text NOT NULL,
  client_secret_hash text,
  created_at         timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL,
  account_hash   text NOT NULL,
  pkce_challenge text NOT NULL,
  redirect_uri   text NOT NULL,
  audience       text NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   text PRIMARY KEY,
  client_id    text NOT NULL,
  account_hash text NOT NULL,
  audience     text NOT NULL,
  kind         text NOT NULL,
  expires_at   bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS shared_entries (
  account_hash text NOT NULL,
  entry_id     text NOT NULL,
  scope        text NOT NULL,
  type         text NOT NULL,
  content      text NOT NULL,
  entry_hash   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_hash, entry_id)
)`,
  // Migrate a pre-C2 shared_entries table (C1 shipped without entry_hash).
  // ADD COLUMN IF NOT EXISTS is idempotent and single-statement (ADR 0010).
  `ALTER TABLE shared_entries ADD COLUMN IF NOT EXISTS entry_hash text NOT NULL DEFAULT ''`,
  // C3 write-back: where a row came from and whether a connector-born row is
  // still awaiting delivery to the client. Both idempotent single-statement ALTERs.
  `ALTER TABLE shared_entries ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'vault'`,
  `ALTER TABLE shared_entries ADD COLUMN IF NOT EXISTS pending boolean NOT NULL DEFAULT false`,
  // C3 forget queue: an already-delivered entry the user forgot inside an AI
  // flow, to be tombstoned in the vault on the next down-sync.
  `CREATE TABLE IF NOT EXISTS pending_forgets (
  account_hash text NOT NULL,
  entry_id     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_hash, entry_id)
)`,
  `CREATE TABLE IF NOT EXISTS scope_tombstones (
  id           bigserial PRIMARY KEY,
  account_hash text NOT NULL,
  scope        text NOT NULL,
  unshared_at  timestamptz NOT NULL DEFAULT now()
)`,
  // ADR 0038 addendum: one tombstone per (account, scope), latest unshared_at.
  // Dedup first (keep MAX(unshared_at), then highest id on ties), then UNIQUE.
  `DELETE FROM scope_tombstones a
WHERE a.id NOT IN (
  SELECT DISTINCT ON (account_hash, scope) id
  FROM scope_tombstones
  ORDER BY account_hash, scope, unshared_at DESC, id DESC
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS scope_tombstones_account_scope
ON scope_tombstones (account_hash, scope)`,
  `CREATE TABLE IF NOT EXISTS connector_audit (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  account_hash text NOT NULL,
  tool         text NOT NULL,
  query_terms  integer,
  result_limit integer,
  result_count integer NOT NULL,
  result_ids   text NOT NULL,
  ok           boolean NOT NULL
)`,
  // ADR 0020 encryption at rest: each credential row carries the account DEK
  // wrapped ("nkw1:...") under a KEK derived from THAT credential's plaintext,
  // which the server sees only transiently. No separate wrap table: the wrap's
  // lifecycle IS the credential's lifecycle (delete/expiry/revoke cleans it up).
  // All idempotent single-statement ALTERs (ADR 0010).
  `ALTER TABLE connector_accounts ADD COLUMN IF NOT EXISTS dek_wrap text`,
  `ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS dek_wrap text`,
  `ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS dek_wrap text`,
  `ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS dek_wrap text`,
  // ADR 0063 sync guardrails. All plaintext metadata, never content. Existing
  // rows get base_revision NULL (legacy, never backfilled) and write_seq 0; a
  // constant default is a catalog-only change on Postgres 11+, no rewrite.
  `ALTER TABLE shared_entries ADD COLUMN IF NOT EXISTS base_revision text`,
  `ALTER TABLE shared_entries ADD COLUMN IF NOT EXISTS write_seq bigint NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS scope_seq (
  account_hash text NOT NULL,
  scope        text NOT NULL,
  seq          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_hash, scope)
)`,
  `ALTER TABLE connector_accounts ADD COLUMN IF NOT EXISTS vault_server text`,
  `ALTER TABLE connector_accounts ADD COLUMN IF NOT EXISTS vault_version bigint`,
];

/** Human-readable schema (for self-hosters running psql by hand). */
export const SCHEMA_SQL = SCHEMA_STATEMENTS.map((s) => `${s};`).join('\n');

export class NeonConnectorStorage implements ConnectorStorage {
  private sql: NeonQueryFunction<false, false>;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string, injectedSql?: NeonQueryFunction<false, false>) {
    this.sql = injectedSql ?? neon(databaseUrl);
  }

  /**
   * Create tables if absent, once per instance. A failed attempt is NOT cached —
   * the next request retries instead of 500ing forever on a transient DB error
   * (same discipline as the sync server).
   */
  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      const attempt = (async () => {
        for (const statement of SCHEMA_STATEMENTS) await this.sql(statement);
      })();
      this.schemaReady = attempt;
      attempt.catch(() => {
        if (this.schemaReady === attempt) this.schemaReady = null;
      });
    }
    await this.schemaReady;
  }

  async upsertAccount(accountHash: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO connector_accounts (account_hash) VALUES (${accountHash})
      ON CONFLICT (account_hash) DO NOTHING
    `;
  }

  async hasAccount(accountHash: string): Promise<boolean> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT 1 AS present FROM connector_accounts WHERE account_hash = ${accountHash}
    `) as unknown as unknown[];
    return rows.length > 0;
  }

  async setEntitledUntil(accountHash: string, untilMs: number): Promise<void> {
    await this.ensureSchema();
    // Upsert + only ever advance the stamp (GREATEST guards a stale re-stamp).
    await this.sql`
      INSERT INTO connector_accounts (account_hash, entitled_until) VALUES (${accountHash}, ${untilMs})
      ON CONFLICT (account_hash) DO UPDATE SET
        entitled_until = GREATEST(connector_accounts.entitled_until, EXCLUDED.entitled_until)
    `;
  }

  async getEntitledUntil(accountHash: string): Promise<number | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entitled_until FROM connector_accounts WHERE account_hash = ${accountHash}
    `) as unknown as Array<{ entitled_until: string | number | null }>;
    const v = rows[0]?.entitled_until;
    return v === null || v === undefined ? null : Number(v);
  }

  async ensureAccountDekWrap(accountHash: string, candidateWrap: string): Promise<string> {
    await this.ensureSchema();
    // Race-safe create in ONE statement: COALESCE keeps an existing wrap, so two
    // concurrent first-writers converge on whichever landed first — the RETURNED
    // wrap is the truth, never the caller's candidate.
    const rows = (await this.sql`
      UPDATE connector_accounts SET dek_wrap = COALESCE(dek_wrap, ${candidateWrap})
      WHERE account_hash = ${accountHash}
      RETURNING dek_wrap
    `) as unknown as Array<{ dek_wrap: string }>;
    const wrap = rows[0]?.dek_wrap;
    if (!wrap) throw new Error('ensureAccountDekWrap: unknown account (upsertAccount first)');
    return wrap;
  }

  async getAccountDekWrap(accountHash: string): Promise<string | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT dek_wrap FROM connector_accounts WHERE account_hash = ${accountHash}
    `) as unknown as Array<{ dek_wrap: string | null }>;
    return rows[0]?.dek_wrap ?? null;
  }

  async putPairingCode(codeHash: string, accountHash: string, expiresAt: number, dekWrap: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO pairing_codes (code_hash, account_hash, expires_at, dek_wrap)
      VALUES (${codeHash}, ${accountHash}, ${new Date(expiresAt).toISOString()}, ${dekWrap})
      ON CONFLICT (code_hash) DO NOTHING
    `;
  }

  async consumePairingCode(codeHash: string): Promise<{ accountHash: string; dekWrap: string } | null> {
    await this.ensureSchema();
    // Opportunistic GC of expired codes first: a stale unconsumed code must not
    // linger as a brute-force oracle (ADR 0020 crypto review). One statement.
    await this.sql`DELETE FROM pairing_codes WHERE expires_at <= now()`;
    // DELETE-on-consume (not UPDATE consumed=true): once used, the row AND its
    // stored KEK wrap are gone, so a consumed pairing code is no longer an
    // offline brute-force oracle against the DB. Single atomic statement.
    const rows = (await this.sql`
      DELETE FROM pairing_codes
      WHERE code_hash = ${codeHash} AND consumed = false AND expires_at > now()
      RETURNING account_hash, dek_wrap
    `) as unknown as Array<{ account_hash: string; dek_wrap: string | null }>;
    const row = rows[0];
    if (!row) return null;
    return { accountHash: row.account_hash, dekWrap: row.dek_wrap ?? '' };
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT client_json FROM oauth_clients WHERE client_id = ${clientId}
    `) as unknown as Array<{ client_json: string }>;
    const row = rows[0];
    if (!row) return undefined;
    return JSON.parse(row.client_json) as OAuthClientInformationFull;
  }

  async registerClient(client: OAuthClientInformationFull, clientSecretHash: string | null): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO oauth_clients (client_id, client_json, client_secret_hash)
      VALUES (${client.client_id}, ${JSON.stringify(client)}, ${clientSecretHash})
      ON CONFLICT (client_id) DO UPDATE SET
        client_json = EXCLUDED.client_json,
        client_secret_hash = EXCLUDED.client_secret_hash
    `;
  }

  async getClientRecord(
    clientId: string,
  ): Promise<{ info: OAuthClientInformationFull; clientSecretHash: string | null } | undefined> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT client_json, client_secret_hash FROM oauth_clients WHERE client_id = ${clientId}
    `) as unknown as Array<{ client_json: string; client_secret_hash: string | null }>;
    const row = rows[0];
    if (!row) return undefined;
    return {
      info: JSON.parse(row.client_json) as OAuthClientInformationFull,
      clientSecretHash: row.client_secret_hash ?? null,
    };
  }

  async listClientSecretCandidates(): Promise<StoredClientRow[]> {
    await this.ensureSchema();
    // Loose text prefilter only; the caller decides on the parsed JSON (ADR 0061).
    const rows = (await this.sql`
      SELECT client_id, client_json, client_secret_hash FROM oauth_clients
      WHERE position('client_secret' in client_json) > 0
    `) as unknown as Array<{ client_id: string; client_json: string; client_secret_hash: string | null }>;
    return rows.map((r) => ({
      clientId: r.client_id,
      clientJson: r.client_json,
      clientSecretHash: r.client_secret_hash ?? null,
    }));
  }

  async casClientRow(clientId: string, oldJson: string, newJson: string, clientSecretHash: string): Promise<boolean> {
    await this.ensureSchema();
    const rows = (await this.sql`
      UPDATE oauth_clients SET client_json = ${newJson}, client_secret_hash = ${clientSecretHash}
      WHERE client_id = ${clientId} AND client_json = ${oldJson}
      RETURNING client_id
    `) as unknown as unknown[];
    return rows.length > 0;
  }

  async putCode(codeHash: string, rec: StoredOAuthCode): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO oauth_codes (code_hash, client_id, account_hash, pkce_challenge, redirect_uri, audience, expires_at, dek_wrap)
      VALUES (${codeHash}, ${rec.clientId}, ${rec.accountHash}, ${rec.pkceChallenge}, ${rec.redirectUri}, ${rec.audience}, ${new Date(rec.expiresAt).toISOString()}, ${rec.dekWrap})
      ON CONFLICT (code_hash) DO NOTHING
    `;
  }

  async getCode(codeHash: string): Promise<StoredOAuthCode | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT client_id, account_hash, pkce_challenge, redirect_uri, audience, expires_at, dek_wrap
      FROM oauth_codes
      WHERE code_hash = ${codeHash} AND consumed = false AND expires_at > now()
    `) as unknown as Array<CodeSqlRow>;
    return rows[0] ? mapCodeRow(rows[0]) : null;
  }

  async consumeCode(codeHash: string): Promise<StoredOAuthCode | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      UPDATE oauth_codes SET consumed = true
      WHERE code_hash = ${codeHash} AND consumed = false AND expires_at > now()
      RETURNING client_id, account_hash, pkce_challenge, redirect_uri, audience, expires_at, dek_wrap
    `) as unknown as Array<CodeSqlRow>;
    return rows[0] ? mapCodeRow(rows[0]) : null;
  }

  async putToken(tokenHash: string, rec: StoredOAuthToken): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO oauth_tokens (token_hash, client_id, account_hash, audience, kind, expires_at, dek_wrap)
      VALUES (${tokenHash}, ${rec.clientId}, ${rec.accountHash}, ${rec.audience}, ${rec.kind}, ${rec.expiresAt}, ${rec.dekWrap})
      ON CONFLICT (token_hash) DO NOTHING
    `;
  }

  async getToken(tokenHash: string): Promise<StoredOAuthToken | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT client_id, account_hash, audience, kind, expires_at, dek_wrap
      FROM oauth_tokens WHERE token_hash = ${tokenHash}
    `) as unknown as Array<TokenSqlRow>;
    return rows[0] ? mapTokenRow(rows[0]) : null;
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`DELETE FROM oauth_tokens WHERE token_hash = ${tokenHash}`;
  }

  async consumeToken(tokenHash: string): Promise<StoredOAuthToken | null> {
    await this.ensureSchema();
    // ONE atomic statement: two concurrent refresh exchanges cannot both win
    // (the pre-existing get-then-delete race this replaces). expires_at is
    // SECONDS since epoch (bigint), so compare against a JS-computed now.
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = (await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash} AND kind = 'refresh' AND expires_at > ${nowSec}
      RETURNING client_id, account_hash, audience, kind, expires_at, dek_wrap
    `) as unknown as Array<TokenSqlRow>;
    return rows[0] ? mapTokenRow(rows[0]) : null;
  }

  async putEntry(accountHash: string, entry: SharedEntry): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq, created_at)
      VALUES (${accountHash}, ${entry.entryId}, ${entry.scope}, ${entry.type}, ${entry.content}, ${entry.entryHash ?? ''}, ${entry.origin ?? 'vault'}, ${entry.pending ?? false}, ${entry.baseRevision ?? null}, ${entry.writeSeq ?? 0}, ${entry.createdAt})
      ON CONFLICT (account_hash, entry_id) DO UPDATE SET
        scope = EXCLUDED.scope, type = EXCLUDED.type, content = EXCLUDED.content,
        entry_hash = EXCLUDED.entry_hash, origin = EXCLUDED.origin, pending = EXCLUDED.pending,
        base_revision = EXCLUDED.base_revision, write_seq = EXCLUDED.write_seq,
        created_at = EXCLUDED.created_at
    `;
  }

  async listEntries(accountHash: string): Promise<SharedEntry[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq, created_at
      FROM shared_entries WHERE account_hash = ${accountHash}
    `) as unknown as Array<SharedEntrySqlRow>;
    return rows.map(mapSharedEntryRow);
  }

  async replaceScopes(
    accountHash: string,
    scopes: string[],
    entries: SharedEntry[],
    claim: VaultOrderClaim = NO_VAULT_CLAIM,
  ): Promise<void> {
    await this.ensureSchema();
    await this.runPush(this.pushStatements(accountHash, scopes, entries, claim, null));
  }

  async replaceScopesAcceptingReshare(
    accountHash: string,
    scopes: string[],
    entries: SharedEntry[],
    sharedAt: Record<string, string | undefined>,
    claim: VaultOrderClaim = NO_VAULT_CLAIM,
  ): Promise<void> {
    await this.ensureSchema();
    const tombs = await this.listTombstones(accountHash);
    const conflicts = findTombstoneConflicts(tombs, scopes, sharedAt);
    if (conflicts.length > 0) throw new TombstoneConflictError(conflicts);
    try {
      await this.runPush(this.pushStatements(accountHash, scopes, entries, claim, sharedAt));
    } catch (err) {
      if (err instanceof StalePushError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/division by zero|tombstone/i.test(msg)) {
        const again = findTombstoneConflicts(await this.listTombstones(accountHash), scopes, sharedAt);
        throw new TombstoneConflictError(again.length > 0 ? again : scopes);
      }
      throw err;
    }
  }

  /** Run a push transaction; its first statement is the vault-order guard, and an empty guard result is a stale push. */
  private async runPush(statements: ReturnType<NeonConnectorStorage['pushStatements']>): Promise<void> {
    const results = (await this.sql.transaction(statements)) as unknown as unknown[][];
    if ((results[0] ?? []).length === 0) throw new StalePushError();
  }

  /**
   * One push as a non-interactive transaction (ADR 0010: one statement per
   * element). The first element is the ADR 0063 D5 guard: it records the claim
   * only when it is not older, taking the account row's lock. Every later
   * element runs only while the account row still holds this push's pair, so a
   * refused push writes nothing. With `sharedAt` set it is the ADR 0038
   * accepting push: the tombstone re-check and the tombstone clear join in.
   */
  private pushStatements(
    accountHash: string,
    scopes: string[],
    entries: SharedEntry[],
    claim: VaultOrderClaim,
    sharedAt: Record<string, string | undefined> | null,
  ) {
    const srv = claim.server;
    const ver = claim.version;
    const statements = [
      this.sql`
        INSERT INTO connector_accounts (account_hash, vault_server, vault_version)
        VALUES (${accountHash}, ${srv}::text, ${ver}::bigint)
        ON CONFLICT (account_hash) DO UPDATE
          SET vault_server = EXCLUDED.vault_server, vault_version = EXCLUDED.vault_version
          WHERE ${claim.reset}::boolean
             OR (EXCLUDED.vault_server IS NULL AND connector_accounts.vault_server IS NULL)
             OR (EXCLUDED.vault_server IS NOT NULL AND (
                   connector_accounts.vault_server IS NULL
                   OR connector_accounts.vault_server <> EXCLUDED.vault_server
                   OR connector_accounts.vault_version <= EXCLUDED.vault_version))
        RETURNING 1 AS accepted
      `,
    ];
    if (sharedAt !== null) {
      const sharedAtJson = JSON.stringify(
        Object.fromEntries(Object.entries(sharedAt).filter((e): e is [string, string] => typeof e[1] === 'string')),
      );
      // Re-check inside the transaction (planner N5). 1/0 aborts the whole
      // batch if a concurrent unshare landed a blocking tombstone.
      statements.push(this.sql`
        SELECT 1 / CASE WHEN EXISTS (
          SELECT 1 FROM connector_accounts
          WHERE account_hash = ${accountHash}
            AND vault_server IS NOT DISTINCT FROM ${srv}::text AND vault_version IS NOT DISTINCT FROM ${ver}::bigint
        ) AND EXISTS (
          SELECT 1 FROM scope_tombstones t
          WHERE t.account_hash = ${accountHash}
            AND t.scope = ANY(${scopes})
            AND (
              NOT (${sharedAtJson}::jsonb ? t.scope)
              OR ((${sharedAtJson}::jsonb ->> t.scope)::timestamptz) <= t.unshared_at
            )
        ) THEN 0 ELSE 1 END
      `);
    }
    for (const scope of new Set(scopes)) {
      statements.push(this.sql`
        INSERT INTO scope_seq (account_hash, scope, seq)
        SELECT ${accountHash}, ${scope}, 1
        WHERE EXISTS (
          SELECT 1 FROM connector_accounts
          WHERE account_hash = ${accountHash}
            AND vault_server IS NOT DISTINCT FROM ${srv}::text AND vault_version IS NOT DISTINCT FROM ${ver}::bigint)
        ON CONFLICT (account_hash, scope) DO UPDATE SET seq = scope_seq.seq + 1
      `);
    }
    for (const e of entries) {
      statements.push(this.sql`
        INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq)
        SELECT ${accountHash}, ${e.entryId}, ${e.scope}, ${e.type}, ${e.content}, ${e.entryHash ?? ''}, 'vault', false, NULL, q.seq
        FROM scope_seq q
        WHERE q.account_hash = ${accountHash} AND q.scope = ${e.scope}
          AND EXISTS (
            SELECT 1 FROM connector_accounts
            WHERE account_hash = ${accountHash}
              AND vault_server IS NOT DISTINCT FROM ${srv}::text AND vault_version IS NOT DISTINCT FROM ${ver}::bigint)
        ON CONFLICT (account_hash, entry_id) DO UPDATE SET
          scope = EXCLUDED.scope, type = EXCLUDED.type, content = EXCLUDED.content,
          entry_hash = EXCLUDED.entry_hash, origin = EXCLUDED.origin, pending = EXCLUDED.pending,
          base_revision = EXCLUDED.base_revision, write_seq = EXCLUDED.write_seq
      `);
    }
    // The reconcile-delete NEVER touches an undelivered connector-born row
    // (origin='connector' AND pending): a push racing ahead of the down-sync must
    // not destroy a memory the AI created that the user hasn't pulled yet (C3
    // critical fix). `<> ALL(array)` is the array-safe NOT IN; an empty array
    // clears the scope.
    for (const scope of scopes) {
      const ids = entries.filter((e) => e.scope === scope).map((e) => e.entryId);
      statements.push(this.sql`
        DELETE FROM shared_entries
        WHERE account_hash = ${accountHash} AND scope = ${scope} AND entry_id <> ALL(${ids}::text[])
          AND NOT (origin = 'connector' AND pending = true)
          AND EXISTS (
            SELECT 1 FROM connector_accounts
            WHERE account_hash = ${accountHash}
              AND vault_server IS NOT DISTINCT FROM ${srv}::text AND vault_version IS NOT DISTINCT FROM ${ver}::bigint)
      `);
    }
    if (sharedAt !== null) {
      for (const scope of scopes) {
        const accepted = sharedAt[scope];
        if (accepted === undefined) continue;
        statements.push(this.sql`
          DELETE FROM scope_tombstones
          WHERE account_hash = ${accountHash}
            AND scope = ${scope}
            AND unshared_at <= ${accepted}::timestamptz
            AND EXISTS (
              SELECT 1 FROM connector_accounts
              WHERE account_hash = ${accountHash}
                AND vault_server IS NOT DISTINCT FROM ${srv}::text AND vault_version IS NOT DISTINCT FROM ${ver}::bigint)
        `);
      }
    }
    return statements;
  }

  async getVaultOrder(accountHash: string): Promise<{ server: string | null; version: number | null }> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT vault_server, vault_version FROM connector_accounts WHERE account_hash = ${accountHash}
    `) as unknown as Array<{ vault_server: string | null; vault_version: string | number | null }>;
    const r = rows[0];
    return {
      server: r?.vault_server ?? null,
      version: r?.vault_version === null || r?.vault_version === undefined ? null : Number(r.vault_version),
    };
  }

  async deleteScope(accountHash: string, scope: string): Promise<number> {
    return (await this.unshareScope(accountHash, scope, { paid: true })).deleted;
  }

  async unshareScope(
    accountHash: string,
    scope: string,
    opts: { paid: boolean },
  ): Promise<{ deleted: number; newTombstones: number }> {
    await this.ensureSchema();
    // ONE statement (ADR 0010): rows and tombstone move together. Counts are
    // cast ::int and wrapped in Number() because Neon returns int8 as a string.
    const rows = (await this.sql`
      WITH d AS (
        DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND scope = ${scope} RETURNING 1
      ), b AS (
        UPDATE scope_seq SET seq = seq + 1 WHERE account_hash = ${accountHash} AND scope = ${scope} RETURNING 1
      ), t AS (
        INSERT INTO scope_tombstones (account_hash, scope, unshared_at)
        SELECT ${accountHash}, ${scope}, now()
        WHERE EXISTS (SELECT 1 FROM d)
           OR EXISTS (SELECT 1 FROM scope_tombstones WHERE account_hash = ${accountHash} AND scope = ${scope})
           OR (octet_length(${scope}::text) <= ${MAX_NEW_TOMBSTONE_SCOPE_BYTES}
               AND (SELECT count(*) FROM scope_tombstones WHERE account_hash = ${accountHash}) < ${MAX_TOMBSTONES_PER_ACCOUNT}
               AND (${opts.paid}::boolean OR EXISTS (
                     SELECT 1 FROM connector_accounts
                     WHERE account_hash = ${accountHash} AND entitled_until IS NOT NULL)))
        ON CONFLICT (account_hash, scope) DO UPDATE
          SET unshared_at = GREATEST(scope_tombstones.unshared_at, EXCLUDED.unshared_at)
        RETURNING (xmax = 0) AS inserted
      )
      SELECT (SELECT count(*) FROM d)::int AS deleted,
             (SELECT count(*) FROM t WHERE inserted)::int AS new_tombstones
    `) as unknown as Array<{ deleted: number | string; new_tombstones: number | string }>;
    const r = rows[0];
    return { deleted: Number(r?.deleted ?? 0), newTombstones: Number(r?.new_tombstones ?? 0) };
  }

  async listTombstones(accountHash: string): Promise<ScopeTombstone[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT scope, unshared_at FROM scope_tombstones
      WHERE account_hash = ${accountHash} ORDER BY unshared_at ASC
    `) as unknown as Array<{ scope: string; unshared_at: string }>;
    return rows.map((r) => ({ scope: r.scope, unsharedAt: new Date(r.unshared_at).toISOString() }));
  }

  async getEntry(accountHash: string, entryId: string): Promise<SharedEntry | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq, created_at
      FROM shared_entries WHERE account_hash = ${accountHash} AND entry_id = ${entryId}
    `) as unknown as Array<SharedEntrySqlRow>;
    return rows[0] ? mapSharedEntryRow(rows[0]) : null;
  }

  async readScopeSeq(accountHash: string, scope: string): Promise<number> {
    await this.ensureSchema();
    // The CTE's insert is invisible to the outer read in the same statement,
    // hence the UNION: exactly one branch returns the row.
    const rows = (await this.sql`
      WITH ins AS (
        INSERT INTO scope_seq (account_hash, scope, seq) VALUES (${accountHash}, ${scope}, 0)
        ON CONFLICT (account_hash, scope) DO NOTHING
        RETURNING seq
      )
      SELECT seq FROM ins
      UNION ALL
      SELECT seq FROM scope_seq WHERE account_hash = ${accountHash} AND scope = ${scope}
    `) as unknown as Array<{ seq: string | number }>;
    return Number(rows[0]!.seq);
  }

  async writeConnectorRows(
    accountHash: string,
    scope: string,
    write: { expectedSeq: number | null; rows: ConnectorRowInsert[]; replacedId: string | null },
  ): Promise<number | null> {
    await this.ensureSchema();
    const ids = write.rows.map((r) => r.entryId);
    const contents = write.rows.map((r) => r.content);
    const bases = write.rows.map((r) => r.baseRevision);
    // ADR 0063 D2: one statement, serialized on the scope_seq row. The delete
    // names one id, never a predicate, so a held stale row is never removed.
    const rows = (write.expectedSeq !== null
      ? await this.sql`
          WITH cas AS (
            UPDATE scope_seq SET seq = seq + 1
            WHERE account_hash = ${accountHash} AND scope = ${scope} AND seq = ${write.expectedSeq}::bigint
            RETURNING seq),
          ins AS (
            INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq)
            SELECT ${accountHash}, x.entry_id, ${scope}, '', x.content, '', 'connector', true, x.base, cas.seq
            FROM cas, unnest(${ids}::text[], ${contents}::text[], ${bases}::text[]) AS x(entry_id, content, base)
            RETURNING entry_id),
          del AS (
            DELETE FROM shared_entries
            WHERE account_hash = ${accountHash} AND entry_id = ${write.replacedId}::text AND pending
              AND EXISTS (SELECT 1 FROM ins))
          SELECT seq FROM cas`
      : await this.sql`
          WITH cas AS (
            INSERT INTO scope_seq (account_hash, scope, seq) VALUES (${accountHash}, ${scope}, 1)
            ON CONFLICT (account_hash, scope) DO UPDATE SET seq = scope_seq.seq + 1
            RETURNING seq),
          ins AS (
            INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq)
            SELECT ${accountHash}, x.entry_id, ${scope}, '', x.content, '', 'connector', true, x.base, cas.seq
            FROM cas, unnest(${ids}::text[], ${contents}::text[], ${bases}::text[]) AS x(entry_id, content, base)
            RETURNING entry_id),
          del AS (
            DELETE FROM shared_entries
            WHERE account_hash = ${accountHash} AND entry_id = ${write.replacedId}::text AND pending
              AND EXISTS (SELECT 1 FROM ins))
          SELECT seq FROM cas`) as unknown as Array<{ seq: string | number }>;
    return rows[0] ? Number(rows[0].seq) : null;
  }

  async discardPending(accountHash: string, entryIds: string[]): Promise<number> {
    await this.ensureSchema();
    const ids = [...new Set(entryIds)];
    if (ids.length === 0) return 0;
    const results = (await this.sql.transaction([
      this.sql`
        INSERT INTO scope_seq (account_hash, scope, seq)
        SELECT DISTINCT account_hash, scope, 1 FROM shared_entries
        WHERE account_hash = ${accountHash} AND entry_id = ANY(${ids}::text[]) AND pending
        ON CONFLICT (account_hash, scope) DO UPDATE SET seq = scope_seq.seq + 1
      `,
      this.sql`
        WITH d AS (
          DELETE FROM shared_entries
          WHERE account_hash = ${accountHash} AND entry_id = ANY(${ids}::text[]) AND pending
          RETURNING 1
        ) SELECT count(*)::int AS n FROM d
      `,
    ])) as unknown as Array<Array<{ n?: string | number }>>;
    return Number(results[1]?.[0]?.n ?? 0);
  }

  async listPendingEntries(accountHash: string): Promise<SharedEntry[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id, scope, type, content, entry_hash, origin, pending, base_revision, write_seq, created_at
      FROM shared_entries WHERE account_hash = ${accountHash} AND origin = 'connector' AND pending = true
    `) as unknown as Array<SharedEntrySqlRow>;
    return rows.map(mapSharedEntryRow);
  }

  async enqueueForget(accountHash: string, entryId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO pending_forgets (account_hash, entry_id) VALUES (${accountHash}, ${entryId})
      ON CONFLICT (account_hash, entry_id) DO NOTHING
    `;
  }

  async listPendingForgets(accountHash: string): Promise<string[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id FROM pending_forgets WHERE account_hash = ${accountHash}
    `) as unknown as Array<{ entry_id: string }>;
    return rows.map((r) => r.entry_id);
  }

  async ackEntry(accountHash: string, serverId: string, localEntryId: string): Promise<void> {
    await this.ensureSchema();
    // Collision-safe remap: drop any row already under the local id (the dedupe
    // path re-maps onto an existing vault entry), then rename the delivered
    // connector row and clear its pending flag. Also re-point any forget queued
    // against the server id onto the vault-local id, so a forget that raced in
    // between the client's fetch and this ack still tombstones the delivered
    // vault entry (never orphaned). Each element is one statement, all atomic.
    // ADR 0063: the drop happens only when the server row still exists (an ack
    // of a row replaced meanwhile must not delete the pushed head), and the
    // renamed row carries a new scope counter value.
    await this.sql.transaction([
      this.sql`
        INSERT INTO scope_seq (account_hash, scope, seq)
        SELECT account_hash, scope, 1 FROM shared_entries
        WHERE account_hash = ${accountHash} AND entry_id = ${serverId}
        ON CONFLICT (account_hash, scope) DO UPDATE SET seq = scope_seq.seq + 1
      `,
      this.sql`
        DELETE FROM shared_entries
        WHERE account_hash = ${accountHash} AND entry_id = ${localEntryId} AND entry_id <> ${serverId}
          AND EXISTS (SELECT 1 FROM shared_entries s WHERE s.account_hash = ${accountHash} AND s.entry_id = ${serverId})
      `,
      this.sql`
        UPDATE shared_entries SET entry_id = ${localEntryId}, pending = false,
          write_seq = (SELECT q.seq FROM scope_seq q WHERE q.account_hash = ${accountHash} AND q.scope = shared_entries.scope)
        WHERE account_hash = ${accountHash} AND entry_id = ${serverId}
      `,
      this.sql`
        INSERT INTO pending_forgets (account_hash, entry_id)
        SELECT account_hash, ${localEntryId} FROM pending_forgets
        WHERE account_hash = ${accountHash} AND entry_id = ${serverId}
        ON CONFLICT (account_hash, entry_id) DO NOTHING
      `,
      this.sql`DELETE FROM pending_forgets WHERE account_hash = ${accountHash} AND entry_id = ${serverId}`,
    ]);
  }

  async applyForget(accountHash: string, entryId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql.transaction([
      this.sql`
        INSERT INTO scope_seq (account_hash, scope, seq)
        SELECT account_hash, scope, 1 FROM shared_entries
        WHERE account_hash = ${accountHash} AND entry_id = ${entryId}
        ON CONFLICT (account_hash, scope) DO UPDATE SET seq = scope_seq.seq + 1
      `,
      this.sql`DELETE FROM pending_forgets WHERE account_hash = ${accountHash} AND entry_id = ${entryId}`,
      this.sql`DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND entry_id = ${entryId}`,
    ]);
  }

  async purgeLegacyPlaintext(): Promise<number> {
    await this.ensureSchema();
    // The exact complement of isEncryptedRow (startsWith 'nkc1:'); starts_with,
    // not LIKE, so no wildcard can widen it. Never part of SCHEMA_STATEMENTS.
    const rows = (await this.sql`
      WITH d AS (
        DELETE FROM shared_entries WHERE NOT starts_with(content, 'nkc1:') RETURNING 1
      ) SELECT count(*)::int AS purged FROM d
    `) as unknown as Array<{ purged: number | string }>;
    return Number(rows[0]?.purged ?? 0);
  }

  async gcOAuth(nowSec: number): Promise<OAuthGcResult> {
    await this.ensureSchema();
    const codes = (await this.sql`
      WITH d AS (
        DELETE FROM oauth_codes WHERE consumed = true OR expires_at <= to_timestamp(${nowSec}) RETURNING 1
      ) SELECT count(*)::int AS n FROM d
    `) as unknown as Array<{ n: number | string }>;
    const tokens = (await this.sql`
      WITH d AS (
        DELETE FROM oauth_tokens WHERE expires_at <= ${nowSec} RETURNING 1
      ) SELECT count(*)::int AS n FROM d
    `) as unknown as Array<{ n: number | string }>;
    return { codes: Number(codes[0]?.n ?? 0), tokens: Number(tokens[0]?.n ?? 0) };
  }

  async appendAudit(entry: ConnectorAuditEntry): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO connector_audit (ts, account_hash, tool, query_terms, result_limit, result_count, result_ids, ok)
      VALUES (${entry.ts}, ${entry.accountHash}, ${entry.tool}, ${entry.params.query_terms ?? null}, ${entry.params.limit ?? null}, ${entry.resultCount}, ${JSON.stringify(entry.resultIds)}, ${entry.ok})
    `;
  }
}

interface SharedEntrySqlRow {
  entry_id: string;
  scope: string;
  type: string;
  content: string;
  entry_hash: string;
  origin: string;
  pending: boolean;
  base_revision: string | null;
  /** int8: a string over Neon's HTTP driver. */
  write_seq: string | number;
  created_at: string;
}

function mapSharedEntryRow(r: SharedEntrySqlRow): SharedEntry {
  return {
    entryId: r.entry_id,
    scope: r.scope,
    type: r.type,
    content: r.content,
    entryHash: r.entry_hash ?? '',
    origin: r.origin === 'connector' ? 'connector' : 'vault',
    pending: r.pending === true,
    ...(r.base_revision === null || r.base_revision === undefined ? {} : { baseRevision: r.base_revision }),
    writeSeq: Number(r.write_seq ?? 0),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

interface CodeSqlRow {
  client_id: string;
  account_hash: string;
  pkce_challenge: string;
  redirect_uri: string;
  audience: string;
  expires_at: string;
  dek_wrap: string | null;
}

function mapCodeRow(r: CodeSqlRow): StoredOAuthCode {
  return {
    clientId: r.client_id,
    accountHash: r.account_hash,
    pkceChallenge: r.pkce_challenge,
    redirectUri: r.redirect_uri,
    audience: r.audience,
    expiresAt: new Date(r.expires_at).getTime(),
    dekWrap: r.dek_wrap ?? '',
  };
}

interface TokenSqlRow {
  client_id: string;
  account_hash: string;
  audience: string;
  kind: string;
  expires_at: number;
  dek_wrap: string | null;
}

function mapTokenRow(r: TokenSqlRow): StoredOAuthToken {
  return {
    clientId: r.client_id,
    accountHash: r.account_hash,
    audience: r.audience,
    kind: r.kind === 'refresh' ? 'refresh' : 'access',
    expiresAt: Number(r.expires_at),
    dekWrap: r.dek_wrap ?? '',
  };
}
