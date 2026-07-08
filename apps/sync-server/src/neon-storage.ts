import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { PutResult, Storage, StoredBlob } from './storage.js';

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

  constructor(databaseUrl: string) {
    this.sql = neon(databaseUrl);
  }

  async ensureSchema(): Promise<void> {
    await this.sql(SCHEMA_SQL);
  }

  async get(tokenHash: string): Promise<StoredBlob | null> {
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
}
