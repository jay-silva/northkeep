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

/**
 * A subscription record (M5b). Keyed by the account's `token_hash` — the SAME
 * anonymous key the blob is stored under. We deliberately store NO email or
 * card here (invariant #2 spirit): those live only in Stripe. This links a
 * paying customer to an *encrypted* vault, never to its contents.
 */
export interface StoredSubscription {
  tokenHash: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  /** Stripe subscription status, e.g. 'active' | 'trialing' | 'canceled' | 'past_due'. */
  status: string;
  /** Unix seconds; access is allowed only while status is active/trialing and this is in the future. */
  currentPeriodEnd: number;
}

export interface Storage {
  get(tokenHash: string): Promise<StoredBlob | null>;
  /**
   * Optimistic-concurrency write. `baseVersion === 0` creates the account's
   * first blob (fails as a conflict if one already exists); otherwise updates
   * only if the current version equals `baseVersion` (else conflict).
   */
  put(tokenHash: string, blob: Buffer, sha256: string, baseVersion: number): Promise<PutResult>;

  // --- billing (M5b) ---
  /** The subscription for this account, or null. */
  getSubscription(tokenHash: string): Promise<StoredSubscription | null>;
  /** Upsert from a completed Checkout (we know the token hash here). */
  upsertSubscription(sub: StoredSubscription): Promise<void>;
  /**
   * Update status/period by Stripe subscription id — used by
   * subscription.updated/deleted webhooks, which don't carry the token hash.
   * No-op if we've never seen that subscription id.
   */
  updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: number,
  ): Promise<void>;
}

/** In-memory storage — tests and local/dev runs. Not durable. */
export class InMemoryStorage implements Storage {
  private rows = new Map<string, StoredBlob>();
  private subs = new Map<string, StoredSubscription>();

  async get(tokenHash: string): Promise<StoredBlob | null> {
    const row = this.rows.get(tokenHash);
    return row ? { ...row, blob: Buffer.from(row.blob) } : null;
  }

  async getSubscription(tokenHash: string): Promise<StoredSubscription | null> {
    const s = this.subs.get(tokenHash);
    return s ? { ...s } : null;
  }

  async upsertSubscription(sub: StoredSubscription): Promise<void> {
    this.subs.set(sub.tokenHash, { ...sub });
  }

  async updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: number,
  ): Promise<void> {
    for (const s of this.subs.values()) {
      if (s.stripeSubscriptionId === stripeSubscriptionId) {
        s.status = status;
        s.currentPeriodEnd = currentPeriodEnd;
      }
    }
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
