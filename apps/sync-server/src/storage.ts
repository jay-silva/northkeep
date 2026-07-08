/**
 * Storage abstraction for the sync server. The handler is written against this
 * interface so it can run over an in-memory map in tests and Neon Postgres in
 * production. Every implementation stores CIPHERTEXT + version only — never
 * plaintext, never a key (invariant #2).
 */

export interface StoredBlob {
  blob: Buffer;
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
}

export interface PutResult {
  ok: boolean;
  /** New version on success; the server's current version on conflict. */
  version: number;
}

export interface Storage {
  get(tokenHash: string): Promise<StoredBlob | null>;
  /**
   * Optimistic-concurrency write. `baseVersion === 0` creates the account's
   * first blob (fails as a conflict if one already exists); otherwise updates
   * only if the current version equals `baseVersion` (else conflict).
   */
  put(tokenHash: string, blob: Buffer, sha256: string, baseVersion: number): Promise<PutResult>;
}

/** In-memory storage — tests and local/dev runs. Not durable. */
export class InMemoryStorage implements Storage {
  private rows = new Map<string, StoredBlob>();

  async get(tokenHash: string): Promise<StoredBlob | null> {
    const row = this.rows.get(tokenHash);
    return row ? { ...row, blob: Buffer.from(row.blob) } : null;
  }

  async put(tokenHash: string, blob: Buffer, sha256: string, baseVersion: number): Promise<PutResult> {
    const existing = this.rows.get(tokenHash);
    if (!existing) {
      if (baseVersion !== 0) return { ok: false, version: 0 };
      this.rows.set(tokenHash, {
        blob: Buffer.from(blob),
        version: 1,
        sha256,
        size: blob.length,
        updatedAt: new Date().toISOString(),
      });
      return { ok: true, version: 1 };
    }
    if (existing.version !== baseVersion) return { ok: false, version: existing.version };
    const version = existing.version + 1;
    this.rows.set(tokenHash, {
      blob: Buffer.from(blob),
      version,
      sha256,
      size: blob.length,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, version };
  }
}
