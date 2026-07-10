import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { PutResult, Storage, StoredBlob, StoredSubscription } from './storage.js';

/**
 * Neon Postgres storage. Ciphertext is stored base64-encoded in a text column
 * (portable over the serverless HTTP driver; the value is still opaque
 * ciphertext). Optimistic concurrency is enforced with atomic SQL:
 * `INSERT ... ON CONFLICT DO NOTHING` for the first write and a conditional
 * `UPDATE ... WHERE version = $base` thereafter.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_blobs (
  token_hash        text PRIMARY KEY,
  blob_b64          text NOT NULL,
  version           integer NOT NULL,
  ciphertext_sha256 text NOT NULL,
  size_bytes        integer NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscriptions (
  token_hash             text PRIMARY KEY,
  stripe_customer_id     text NOT NULL,
  stripe_subscription_id text NOT NULL UNIQUE,
  status                 text NOT NULL,
  current_period_end     bigint NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
`;

interface Row {
  blob_b64: string;
  version: number;
  ciphertext_sha256: string;
  size_bytes: number;
  updated_at: string;
}

export class NeonStorage implements Storage {
  private sql: NeonQueryFunction<false, false>;
  private schemaReady: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  /**
   * Create the table if absent, once per instance. Lets a fresh deployment
   * self-provision on the first request — no manual migration step, and the
   * connection string never has to leave the deploy environment.
   */
  async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.sql(SCHEMA_SQL).then(() => undefined);
    await this.schemaReady;
  }

  async get(tokenHash: string): Promise<StoredBlob | null> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT blob_b64, version, ciphertext_sha256, size_bytes, updated_at
      FROM sync_blobs WHERE token_hash = ${tokenHash}
    `) as unknown as Row[];
    const row = rows[0];
    if (!row) return null;
    return {
      blob: Buffer.from(row.blob_b64, 'base64'),
      version: row.version,
      sha256: row.ciphertext_sha256,
      size: row.size_bytes,
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
    const updated = (await this.sql`
      UPDATE sync_blobs
      SET blob_b64 = ${b64}, version = version + 1, ciphertext_sha256 = ${sha256},
          size_bytes = ${blob.length}, updated_at = now()
      WHERE token_hash = ${tokenHash} AND version = ${baseVersion}
      RETURNING version
    `) as unknown as Array<{ version: number }>;
    if (updated[0]) return { ok: true, version: updated[0].version };
    return { ok: false, version: await this.currentVersion(tokenHash) };
  }

  private async currentVersion(tokenHash: string): Promise<number> {
    const rows = (await this.sql`
      SELECT version FROM sync_blobs WHERE token_hash = ${tokenHash}
    `) as unknown as Array<{ version: number }>;
    return rows[0]?.version ?? 0;
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
    await this.sql`
      INSERT INTO subscriptions (token_hash, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
      VALUES (${sub.tokenHash}, ${sub.stripeCustomerId}, ${sub.stripeSubscriptionId}, ${sub.status}, ${sub.currentPeriodEnd}, now())
      ON CONFLICT (token_hash) DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        status = EXCLUDED.status,
        current_period_end = EXCLUDED.current_period_end,
        updated_at = now()
    `;
  }

  async updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: number,
  ): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      UPDATE subscriptions
      SET status = ${status}, current_period_end = ${currentPeriodEnd}, updated_at = now()
      WHERE stripe_subscription_id = ${stripeSubscriptionId}
    `;
  }
}
