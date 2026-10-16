import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type {
  BlobMeta,
  CommitResult,
  PartWrite,
  PutResult,
  Storage,
  StoredBlob,
  StoredSubscription,
} from './storage.js';
import { OPEN_UPLOAD_TTL_MS, SUPERSEDED_KEEP_MAX, SUPERSEDED_READABLE_MS } from './parts.js';

/**
 * Neon Postgres storage. Ciphertext is stored base64-encoded in a text column
 * (portable over the serverless HTTP driver; the value is still opaque
 * ciphertext). Optimistic concurrency is enforced with atomic SQL:
 * `INSERT ... ON CONFLICT DO NOTHING` for the first write and a conditional
 * `UPDATE ... WHERE version = $base` thereafter.
 */

/**
 * One statement per entry: Neon's serverless HTTP driver executes a single
 * statement per call, so multi-statement strings throw at runtime (this took
 * the live server down when the M5b `subscriptions` table was first added —
 * every request 500'd on ensureSchema). Never join these for execution.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sync_blobs (
  token_hash        text PRIMARY KEY,
  blob_b64          text NOT NULL,
  version           integer NOT NULL,
  ciphertext_sha256 text NOT NULL,
  size_bytes        integer NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
  token_hash             text PRIMARY KEY,
  stripe_customer_id     text NOT NULL,
  stripe_subscription_id text NOT NULL UNIQUE,
  status                 text NOT NULL,
  current_period_end     bigint NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
)`,
  // ADR 0078: a version stored in parts has upload_id set and blob_b64 empty.
  `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS upload_id text`,
  `ALTER TABLE sync_blobs ADD COLUMN IF NOT EXISTS parts integer NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS sync_uploads (
  upload_id     text PRIMARY KEY,
  token_hash    text NOT NULL,
  state         text NOT NULL CHECK (state IN ('open', 'committed', 'replaced')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_at  timestamptz,
  superseded_at timestamptz
)`,
  `CREATE INDEX IF NOT EXISTS sync_uploads_token_hash ON sync_uploads (token_hash)`,
  `CREATE TABLE IF NOT EXISTS sync_parts (
  upload_id text NOT NULL REFERENCES sync_uploads (upload_id) ON DELETE CASCADE,
  n         integer NOT NULL,
  b64       text NOT NULL,
  PRIMARY KEY (upload_id, n)
)`,
];

/** Human-readable schema (for self-hosters running psql by hand). */
export const SCHEMA_SQL = SCHEMA_STATEMENTS.map((s) => `${s};`).join('\n');

interface Row {
  blob_b64: string;
  upload_id: string | null;
  parts: number;
  version: number;
  ciphertext_sha256: string;
  size_bytes: number;
  updated_at: string;
}

export class NeonStorage implements Storage {
  private sql: NeonQueryFunction<false, false>;
  private schemaReady: Promise<void> | null = null;

  /** A connection string, or a query function with Neon's shape (tests pass PGlite). */
  constructor(database: string | NeonQueryFunction<false, false>) {
    this.sql = typeof database === 'string' ? neon(database) : database;
  }

  /**
   * Create the tables if absent, once per instance. Lets a fresh deployment
   * self-provision on the first request — no manual migration step, and the
   * connection string never has to leave the deploy environment. Statements
   * run ONE per call (Neon HTTP driver limit), and a failed attempt is not
   * cached — the next request retries instead of 500ing forever on a
   * transient DB error.
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

  async get(tokenHash: string): Promise<StoredBlob | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT blob_b64, version, ciphertext_sha256, size_bytes, updated_at, upload_id, parts
      FROM sync_blobs WHERE token_hash = ${tokenHash}
    `) as unknown as Row[];
    const row = rows[0];
    if (!row) return null;
    return {
      blob: Buffer.from(row.blob_b64, 'base64'),
      uploadId: row.upload_id,
      parts: Number(row.parts),
      version: Number(row.version),
      sha256: row.ciphertext_sha256,
      size: Number(row.size_bytes),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async put(tokenHash: string, blob: Buffer, sha256: string, baseVersion: number): Promise<PutResult> {
    await this.ensureSchema();
    const b64 = blob.toString('base64');
    if (baseVersion === 0) {
      const inserted = (await this.sql`
        INSERT INTO sync_blobs (token_hash, blob_b64, version, ciphertext_sha256, size_bytes, updated_at)
        VALUES (${tokenHash}, ${b64}, 1, ${sha256}, ${blob.length}, now())
        ON CONFLICT (token_hash) DO NOTHING
        RETURNING version
      `) as unknown as Array<{ version: number }>;
      if (inserted[0]) return { ok: true, version: 1 };
      return { ok: false, version: await this.currentVersion(tokenHash) };
    }
    // One statement: the version check, the swap back to a single row, and
    // starting the readable window of any upload this replaces (ADR 0078).
    const updated = (await this.sql`
      WITH prev AS (
        SELECT upload_id FROM sync_blobs WHERE token_hash = ${tokenHash}
      ), bumped AS (
        UPDATE sync_blobs
        SET blob_b64 = ${b64}, version = version + 1, ciphertext_sha256 = ${sha256},
            size_bytes = ${blob.length}, upload_id = NULL, parts = 0, updated_at = now()
        WHERE token_hash = ${tokenHash} AND version = ${baseVersion}
        RETURNING version
      ), marked AS (
        UPDATE sync_uploads SET superseded_at = now()
        WHERE upload_id = (SELECT upload_id FROM prev) AND EXISTS (SELECT 1 FROM bumped)
      )
      SELECT version FROM bumped
    `) as unknown as Array<{ version: number }>;
    if (updated[0]) return { ok: true, version: Number(updated[0].version) };
    return { ok: false, version: await this.currentVersion(tokenHash) };
  }

  async getMeta(tokenHash: string): Promise<BlobMeta | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT version, ciphertext_sha256, size_bytes, updated_at, upload_id, parts
      FROM sync_blobs WHERE token_hash = ${tokenHash}
    `) as unknown as Array<{
      version: number;
      ciphertext_sha256: string;
      size_bytes: number;
      updated_at: string;
      upload_id: string | null;
      parts: number;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      version: Number(row.version),
      sha256: row.ciphertext_sha256,
      size: Number(row.size_bytes),
      updatedAt: new Date(row.updated_at).toISOString(),
      uploadId: row.upload_id,
      parts: Number(row.parts),
    };
  }

  async createUpload(tokenHash: string, uploadId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      WITH replaced AS (
        UPDATE sync_uploads SET state = 'replaced'
        WHERE token_hash = ${tokenHash} AND state = 'open'
      )
      INSERT INTO sync_uploads (upload_id, token_hash, state, created_at)
      VALUES (${uploadId}, ${tokenHash}, 'open', now())
    `;
  }

  async putPart(tokenHash: string, uploadId: string, n: number, bytes: Buffer): Promise<PartWrite> {
    await this.ensureSchema();
    const rows = (await this.sql`
      WITH owner AS (
        SELECT upload_id FROM sync_uploads
        WHERE upload_id = ${uploadId} AND token_hash = ${tokenHash} AND state = 'open'
      ), written AS (
        INSERT INTO sync_parts (upload_id, n, b64)
        SELECT upload_id, ${n}::int, ${bytes.toString('base64')} FROM owner
        ON CONFLICT (upload_id, n) DO NOTHING
      )
      SELECT count(*) AS owned FROM owner
    `) as unknown as Array<{ owned: number | string }>;
    return Number(rows[0]?.owned ?? 0) === 1 ? 'ok' : 'unknown_upload';
  }

  async readOpenParts(tokenHash: string, uploadId: string): Promise<Array<[number, Buffer]> | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT u.upload_id, p.n, p.b64
      FROM sync_uploads u LEFT JOIN sync_parts p ON p.upload_id = u.upload_id
      WHERE u.upload_id = ${uploadId} AND u.token_hash = ${tokenHash} AND u.state = 'open'
      ORDER BY p.n
    `) as unknown as Array<{ upload_id: string; n: number | null; b64: string | null }>;
    if (rows.length === 0) return null;
    return rows
      .filter((r) => r.b64 !== null && r.n !== null)
      .map((r) => [Number(r.n), Buffer.from(r.b64 as string, 'base64')]);
  }

  async commitUpload(
    tokenHash: string,
    uploadId: string,
    base: number,
    sha256: string,
    size: number,
    parts: number,
  ): Promise<CommitResult> {
    await this.ensureSchema();
    // One statement, so it is atomic on the HTTP driver: claim the open upload
    // (row lock shared with createUpload's replace), then install it only if
    // the account is still at base. A claim whose install loses a race is
    // never current and ages out in pruneUploads.
    const rows = (await this.sql`
      WITH prev AS (
        SELECT upload_id FROM sync_blobs WHERE token_hash = ${tokenHash}
      ), claim AS (
        UPDATE sync_uploads SET state = 'committed', committed_at = now()
        WHERE upload_id = ${uploadId} AND token_hash = ${tokenHash} AND state = 'open'
          AND (SELECT count(*) FROM sync_parts WHERE upload_id = ${uploadId}) = ${parts}::int
          AND COALESCE((SELECT version FROM sync_blobs WHERE token_hash = ${tokenHash}), 0) = ${base}::int
        RETURNING upload_id
      ), bumped AS (
        UPDATE sync_blobs
        SET blob_b64 = '', version = version + 1, ciphertext_sha256 = ${sha256},
            size_bytes = ${size}::int, upload_id = ${uploadId}, parts = ${parts}::int, updated_at = now()
        WHERE token_hash = ${tokenHash} AND version = ${base}::int AND ${base}::int > 0
          AND EXISTS (SELECT 1 FROM claim)
        RETURNING version
      ), inserted AS (
        INSERT INTO sync_blobs (token_hash, blob_b64, version, ciphertext_sha256, size_bytes, upload_id, parts, updated_at)
        SELECT ${tokenHash}, '', 1, ${sha256}, ${size}::int, ${uploadId}, ${parts}::int, now()
        WHERE ${base}::int = 0 AND EXISTS (SELECT 1 FROM claim)
        ON CONFLICT (token_hash) DO NOTHING
        RETURNING version
      ), marked AS (
        UPDATE sync_uploads SET superseded_at = now()
        WHERE upload_id = (SELECT upload_id FROM prev) AND EXISTS (SELECT 1 FROM bumped)
      )
      SELECT (SELECT version FROM bumped) AS bumped,
             (SELECT version FROM inserted) AS inserted,
             (SELECT count(*) FROM claim) AS claimed
    `) as unknown as Array<{ bumped: number | null; inserted: number | null; claimed: number | string }>;
    const r = rows[0];
    const installed = r?.bumped ?? r?.inserted ?? null;
    if (installed !== null && installed !== undefined) return { ok: true, version: Number(installed) };
    if (Number(r?.claimed ?? 0) === 1) {
      return { ok: false, reason: 'conflict', version: await this.currentVersion(tokenHash) };
    }
    const state = (await this.sql`
      SELECT state FROM sync_uploads WHERE upload_id = ${uploadId} AND token_hash = ${tokenHash}
    `) as unknown as Array<{ state: string }>;
    if (state[0]?.state !== 'open') return { ok: false, reason: 'replaced' };
    const version = await this.currentVersion(tokenHash);
    if (version !== base) return { ok: false, reason: 'conflict', version };
    // Still open at the right base: the part count did not match.
    return { ok: false, reason: 'replaced' };
  }

  async getPart(tokenHash: string, uploadId: string, n: number): Promise<Buffer | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT p.b64 FROM sync_parts p JOIN sync_uploads u ON u.upload_id = p.upload_id
      WHERE u.upload_id = ${uploadId} AND u.token_hash = ${tokenHash} AND u.state = 'committed'
        AND p.n = ${n}::int
    `) as unknown as Array<{ b64: string }>;
    return rows[0] ? Buffer.from(rows[0].b64, 'base64') : null;
  }

  async pruneUploads(tokenHash: string): Promise<void> {
    await this.ensureSchema();
    // Parts go with their upload (ON DELETE CASCADE).
    await this.sql`
      WITH cur AS (
        SELECT upload_id FROM sync_blobs WHERE token_hash = ${tokenHash}
      ), ranked AS (
        SELECT upload_id, state, created_at,
               COALESCE(superseded_at, committed_at) AS since,
               row_number() OVER (
                 PARTITION BY state ORDER BY COALESCE(superseded_at, committed_at) DESC NULLS LAST
               ) AS rn
        FROM sync_uploads
        WHERE token_hash = ${tokenHash}
          AND upload_id IS DISTINCT FROM (SELECT upload_id FROM cur)
      )
      DELETE FROM sync_uploads WHERE upload_id IN (
        SELECT upload_id FROM ranked
        WHERE state = 'replaced'
           OR (state = 'open' AND created_at < now() - ${`${OPEN_UPLOAD_TTL_MS} milliseconds`}::interval)
           OR (state = 'committed' AND (rn > ${SUPERSEDED_KEEP_MAX}
               OR since < now() - ${`${SUPERSEDED_READABLE_MS} milliseconds`}::interval))
      )
    `;
  }

  private async currentVersion(tokenHash: string): Promise<number> {
    const rows = (await this.sql`
      SELECT version FROM sync_blobs WHERE token_hash = ${tokenHash}
    `) as unknown as Array<{ version: number }>;
    return Number(rows[0]?.version ?? 0);
  }

  // --- billing (M5b): stores only the token hash + Stripe ids + status.
  // No email, no card — those live in Stripe (ADR 0010). ---

  async getSubscription(tokenHash: string): Promise<StoredSubscription | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT token_hash, stripe_customer_id, stripe_subscription_id, status, current_period_end
      FROM subscriptions WHERE token_hash = ${tokenHash}
    `) as unknown as Array<{
      token_hash: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
      status: string;
      current_period_end: number;
    }>;
    const r = rows[0];
    if (!r) return null;
    return {
      tokenHash: r.token_hash,
      stripeCustomerId: r.stripe_customer_id,
      stripeSubscriptionId: r.stripe_subscription_id,
      status: r.status,
      currentPeriodEnd: Number(r.current_period_end),
    };
  }

  async upsertSubscription(sub: StoredSubscription): Promise<void> {
    await this.ensureSchema();
    // A late completion for an old, ended subscription must not replace a live one.
    await this.sql`
      INSERT INTO subscriptions (token_hash, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
      VALUES (${sub.tokenHash}, ${sub.stripeCustomerId}, ${sub.stripeSubscriptionId}, ${sub.status}, ${sub.currentPeriodEnd}, now())
      ON CONFLICT (token_hash) DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        status = EXCLUDED.status,
        current_period_end = EXCLUDED.current_period_end,
        updated_at = now()
      WHERE subscriptions.stripe_subscription_id = EXCLUDED.stripe_subscription_id
         OR subscriptions.status IN ('canceled', 'incomplete_expired')
         OR EXCLUDED.status NOT IN ('canceled', 'incomplete_expired')
    `;
  }

  async updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: number,
  ): Promise<void> {
    await this.ensureSchema();
    // An ended subscription stays ended: a late update cannot revive it.
    await this.sql`
      UPDATE subscriptions
      SET status = ${status}, current_period_end = ${currentPeriodEnd}, updated_at = now()
      WHERE stripe_subscription_id = ${stripeSubscriptionId}
        AND status NOT IN ('canceled', 'incomplete_expired')
    `;
  }
}
