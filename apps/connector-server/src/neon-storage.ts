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

  async putPairingCode(codeHash: string, accountHash: string, expiresAt: number): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO pairing_codes (code_hash, account_hash, expires_at)
      VALUES (${codeHash}, ${accountHash}, ${new Date(expiresAt).toISOString()})
      ON CONFLICT (code_hash) DO NOTHING
    `;
  }

  async consumePairingCode(codeHash: string): Promise<string | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      UPDATE pairing_codes SET consumed = true
      WHERE code_hash = ${codeHash} AND consumed = false AND expires_at > now()
      RETURNING account_hash
    `) as unknown as Array<{ account_hash: string }>;
    return rows[0]?.account_hash ?? null;
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
      INSERT INTO oauth_codes (code_hash, client_id, account_hash, pkce_challenge, redirect_uri, audience, expires_at)
      VALUES (${codeHash}, ${rec.clientId}, ${rec.accountHash}, ${rec.pkceChallenge}, ${rec.redirectUri}, ${rec.audience}, ${new Date(rec.expiresAt).toISOString()})
      ON CONFLICT (code_hash) DO NOTHING
    `;
  }

  async getCode(codeHash: string): Promise<StoredOAuthCode | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT client_id, account_hash, pkce_challenge, redirect_uri, audience, expires_at
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
      RETURNING client_id, account_hash, pkce_challenge, redirect_uri, audience, expires_at
    `) as unknown as Array<CodeSqlRow>;
    return rows[0] ? mapCodeRow(rows[0]) : null;
  }

  async putToken(tokenHash: string, rec: StoredOAuthToken): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO oauth_tokens (token_hash, client_id, account_hash, audience, kind, expires_at)
      VALUES (${tokenHash}, ${rec.clientId}, ${rec.accountHash}, ${rec.audience}, ${rec.kind}, ${rec.expiresAt})
      ON CONFLICT (token_hash) DO NOTHING
    `;
  }

  async getToken(tokenHash: string): Promise<StoredOAuthToken | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT client_id, account_hash, audience, kind, expires_at
      FROM oauth_tokens WHERE token_hash = ${tokenHash}
    `) as unknown as Array<{
      client_id: string;
      account_hash: string;
      audience: string;
      kind: string;
      expires_at: number;
    }>;
    const r = rows[0];
    if (!r) return null;
    return {
      clientId: r.client_id,
      accountHash: r.account_hash,
      audience: r.audience,
      kind: r.kind === 'refresh' ? 'refresh' : 'access',
      expiresAt: Number(r.expires_at),
    };
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`DELETE FROM oauth_tokens WHERE token_hash = ${tokenHash}`;
  }

  async putEntry(accountHash: string, entry: SharedEntry): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, entry_hash, created_at)
      VALUES (${accountHash}, ${entry.entryId}, ${entry.scope}, ${entry.type}, ${entry.content}, ${entry.entryHash ?? ''}, ${entry.createdAt})
      ON CONFLICT (account_hash, entry_id) DO UPDATE SET
        scope = EXCLUDED.scope, type = EXCLUDED.type, content = EXCLUDED.content,
        entry_hash = EXCLUDED.entry_hash, created_at = EXCLUDED.created_at
    `;
  }

  async listEntries(accountHash: string): Promise<SharedEntry[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT entry_id, scope, type, content, entry_hash, created_at
      FROM shared_entries WHERE account_hash = ${accountHash}
    `) as unknown as Array<{
      entry_id: string;
      scope: string;
      type: string;
      content: string;
      entry_hash: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      entryId: r.entry_id,
      scope: r.scope,
      type: r.type,
      content: r.content,
      entryHash: r.entry_hash ?? '',
      createdAt: new Date(r.created_at).toISOString(),
    }));
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
    for (const scope of scopes) {
      const ids = entries.filter((e) => e.scope === scope).map((e) => e.entryId);
      if (ids.length === 0) {
        // Emptied scope: clear it entirely (an unconditional NOT-IN of nothing
        // would be invalid SQL — guard it).
        statements.push(this.sql`
          DELETE FROM shared_entries WHERE account_hash = ${accountHash} AND scope = ${scope}
        `);
      } else {
        // `<> ALL(array)` is the array-safe NOT IN (no empty-list edge case).
        statements.push(this.sql`
          DELETE FROM shared_entries
          WHERE account_hash = ${accountHash} AND scope = ${scope} AND entry_id <> ALL(${ids})
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

  async appendAudit(entry: ConnectorAuditEntry): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO connector_audit (ts, account_hash, tool, query_terms, result_limit, result_count, result_ids, ok)
      VALUES (${entry.ts}, ${entry.accountHash}, ${entry.tool}, ${entry.params.query_terms ?? null}, ${entry.params.limit ?? null}, ${entry.resultCount}, ${JSON.stringify(entry.resultIds)}, ${entry.ok})
    `;
  }
}

interface CodeSqlRow {
  client_id: string;
  account_hash: string;
  pkce_challenge: string;
  redirect_uri: string;
  audience: string;
  expires_at: string;
}

function mapCodeRow(r: CodeSqlRow): StoredOAuthCode {
  return {
    clientId: r.client_id,
    accountHash: r.account_hash,
    pkceChallenge: r.pkce_challenge,
    redirectUri: r.redirect_uri,
    audience: r.audience,
    expiresAt: new Date(r.expires_at).getTime(),
  };
}
