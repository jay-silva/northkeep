import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  ConnectorAuditEntry,
  ConnectorStorage,
  ScopeTombstone,
  SharedEntry,
  StoredOAuthCode,
  StoredOAuthToken,
} from './storage.js';

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
];

/** Human-readable schema (for self-hosters running psql by hand). */
export const SCHEMA_SQL = SCHEMA_STATEMENTS.map((s) => `${s};`).join('\n');

export class NeonConnectorStorage implements ConnectorStorage {
  private sql: NeonQueryFunction<false, false>;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
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
    const rows = (await this.sql`
      UPDATE pairing_codes SET consumed = true
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
      INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash, origin, pending, created_at)
      VALUES (${accountHash}, ${entry.entryId}, ${entry.scope}, ${entry.type}, ${entry.content}, ${entry.entryHash ?? ''}, ${entry.origin ?? 'vault'}, ${entry.pending ?? false}, ${entry.createdAt})
      ON CONFLICT (account_hash, entry_id) DO UPDATE SET
        scope = EXCLUDED.scope, type = EXCLUDED.type, content = EXCLUDED.content,
        entry_hash = EXCLUDED.entry_hash, origin = EXCLUDED.origin, pending = EXCLUDED.pending,
        created_at = EXCLUDED.created_at
    `;
  }

  async listEntries(accountHash: string): Promise<SharedEntry[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id, scope, type, content, entry_hash, origin, pending, created_at
      FROM shared_entries WHERE account_hash = ${accountHash}
    `) as unknown as Array<SharedEntrySqlRow>;
    return rows.map(mapSharedEntryRow);
  }

  async replaceScopes(accountHash: string, scopes: string[], entries: SharedEntry[]): Promise<void> {
    await this.ensureSchema();
    // One non-interactive transaction: N upserts + one delete-reconcile per
    // scope. Each element is a single statement (ADR 0010); the neon driver
    // submits them together atomically so a mid-push failure leaves no partial
    // "make-scopes-match" state.
    const statements = [];
    for (const e of entries) {
      statements.push(this.sql`
        INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash)
        VALUES (${accountHash}, ${e.entryId}, ${e.scope}, ${e.type}, ${e.content}, ${e.entryHash ?? ''})
        ON CONFLICT (account_hash, entry_id) DO UPDATE SET
          scope = EXCLUDED.scope, type = EXCLUDED.type, content = EXCLUDED.content,
          entry_hash = EXCLUDED.entry_hash
      `);
    }
    // The reconcile-delete NEVER touches an undelivered connector-born row
    // (origin='connector' AND pending): a push racing ahead of the down-sync must
    // not destroy a memory the AI created that the user hasn't pulled yet (C3
    // critical fix). The `NOT (origin='connector' AND pending)` guard shields it.
    for (const scope of scopes) {
      const ids = entries.filter((e) => e.scope === scope).map((e) => e.entryId);
      if (ids.length === 0) {
        // Emptied scope: clear it entirely (an unconditional NOT-IN of nothing
        // would be invalid SQL — guard it).
        statements.push(this.sql`
          DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND scope = ${scope}
            AND NOT (origin = 'connector' AND pending = true)
        `);
      } else {
        // `<> ALL(array)` is the array-safe NOT IN (no empty-list edge case).
        statements.push(this.sql`
          DELETE FROM shared_entries
          WHERE account_hash = ${accountHash} AND scope = ${scope} AND entry_id <> ALL(${ids})
            AND NOT (origin = 'connector' AND pending = true)
        `);
      }
    }
    if (statements.length > 0) await this.sql.transaction(statements);
  }

  async deleteScope(accountHash: string, scope: string): Promise<number> {
    await this.ensureSchema();
    const results = await this.sql.transaction([
      this.sql`DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND scope = ${scope} RETURNING entry_id`,
      this.sql`INSERT INTO scope_tombstones (account_hash, scope) VALUES (${accountHash}, ${scope})`,
    ]);
    const deleted = results[0] as unknown as unknown[];
    return Array.isArray(deleted) ? deleted.length : 0;
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
      SELECT entry_id, scope, type, content, entry_hash, origin, pending, created_at
      FROM shared_entries WHERE account_hash = ${accountHash} AND entry_id = ${entryId}
    `) as unknown as Array<SharedEntrySqlRow>;
    return rows[0] ? mapSharedEntryRow(rows[0]) : null;
  }

  async deleteEntry(accountHash: string, entryId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND entry_id = ${entryId}`;
  }

  async listPendingEntries(accountHash: string): Promise<SharedEntry[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id, scope, type, content, entry_hash, origin, pending, created_at
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
    await this.sql.transaction([
      this.sql`DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND entry_id = ${localEntryId}`,
      this.sql`
        UPDATE shared_entries SET entry_id = ${localEntryId}, pending = false
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
      this.sql`DELETE FROM pending_forgets WHERE account_hash = ${accountHash} AND entry_id = ${entryId}`,
      this.sql`DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND entry_id = ${entryId}`,
    ]);
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
