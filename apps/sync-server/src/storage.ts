import { OPEN_UPLOAD_TTL_MS, SUPERSEDED_KEEP_MAX, SUPERSEDED_READABLE_MS } from './parts.js';

/**
 * Storage abstraction for the sync server. The handler is written against this
 * interface so it can run over an in-memory map in tests and Neon Postgres in
 * production. Every implementation stores CIPHERTEXT + version only — never
 * plaintext, never a key (invariant #2).
 */

export interface StoredBlob {
  /** Empty when the version is stored in parts (uploadId set). */
  blob: Buffer;
  uploadId: string | null;
  parts: number;
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
}

/** Status metadata only: never the blob (ADR 0078 D2). */
export interface BlobMeta {
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
  /** Set when the current version is stored in parts (ADR 0078 D1), else null. */
  uploadId: string | null;
  /** Part count when uploadId is set, else 0. */
  parts: number;
}

export type PartWrite = 'ok' | 'unknown_upload';

export type CommitResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'conflict'; version: number }
  | { ok: false; reason: 'replaced' };

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

/** Stripe statuses after which a subscription never bills again; final per subscription id. */
export const ENDED: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export interface Storage {
  get(tokenHash: string): Promise<StoredBlob | null>;
  /**
   * Optimistic-concurrency write. `baseVersion === 0` creates the account's
   * first blob (fails as a conflict if one already exists); otherwise updates
   * only if the current version equals `baseVersion` (else conflict).
   */
  put(tokenHash: string, blob: Buffer, sha256: string, baseVersion: number): Promise<PutResult>;

  // --- parts (ADR 0078 D1) ---
  getMeta(tokenHash: string): Promise<BlobMeta | null>;
  /** Opens an upload for this account; any other open upload becomes replaced. */
  createUpload(tokenHash: string, uploadId: string): Promise<void>;
  /** Write-once: a part already written keeps its first bytes. */
  putPart(tokenHash: string, uploadId: string, n: number, bytes: Buffer): Promise<PartWrite>;
  /** [index, bytes] of this account's OPEN upload in index order, or null. */
  readOpenParts(tokenHash: string, uploadId: string): Promise<Array<[number, Buffer]> | null>;
  /**
   * One atomic step: claims the open upload and installs it as version base+1
   * only if the account is still at `base` and the part count matches.
   */
  commitUpload(
    tokenHash: string,
    uploadId: string,
    base: number,
    sha256: string,
    size: number,
    parts: number,
  ): Promise<CommitResult>;
  /** Part n of a committed upload of this account still kept, or null. */
  getPart(tokenHash: string, uploadId: string, n: number): Promise<Buffer | null>;
  /** Drops expired, replaced and superseded uploads for this account. */
  pruneUploads(tokenHash: string): Promise<void>;

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

interface MemUpload {
  tokenHash: string;
  state: 'open' | 'committed' | 'replaced';
  createdAt: number;
  committedAt: number | null;
  /** When a newer version replaced this one as current. */
  supersededAt: number | null;
  parts: Map<number, Buffer>;
}

/** In-memory storage: tests and local/dev runs. Not durable. */
export class InMemoryStorage implements Storage {
  private rows = new Map<string, StoredBlob>();
  private subs = new Map<string, StoredSubscription>();
  private uploads = new Map<string, MemUpload>();
  /** Injectable clock for retention tests. */
  now: () => number = Date.now;

  async get(tokenHash: string): Promise<StoredBlob | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;
    return { ...row, blob: Buffer.from(row.blob) };
  }

  async getMeta(tokenHash: string): Promise<BlobMeta | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;
    return {
      version: row.version,
      sha256: row.sha256,
      size: row.size,
      updatedAt: row.updatedAt,
      uploadId: row.uploadId,
      parts: row.parts,
    };
  }

  async getSubscription(tokenHash: string): Promise<StoredSubscription | null> {
    const s = this.subs.get(tokenHash);
    return s ? { ...s } : null;
  }

  async upsertSubscription(sub: StoredSubscription): Promise<void> {
    const cur = this.subs.get(sub.tokenHash);
    // A late completion for an old, ended subscription must not replace a live one.
    if (cur && cur.stripeSubscriptionId !== sub.stripeSubscriptionId && !ENDED.has(cur.status) && ENDED.has(sub.status)) return;
    this.subs.set(sub.tokenHash, { ...sub });
  }

  async updateSubscriptionByStripeId(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: number,
  ): Promise<void> {
    for (const s of this.subs.values()) {
      // An ended subscription stays ended: a late update cannot revive it.
      if (s.stripeSubscriptionId === stripeSubscriptionId && !ENDED.has(s.status)) {
        s.status = status;
        s.currentPeriodEnd = currentPeriodEnd;
      }
    }
  }

  async put(tokenHash: string, blob: Buffer, sha256: string, baseVersion: number): Promise<PutResult> {
    const existing = this.rows.get(tokenHash);
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== baseVersion) return { ok: false, version: currentVersion };
    const version = currentVersion + 1;
    this.supersede(existing?.uploadId ?? null);
    this.rows.set(tokenHash, {
      blob: Buffer.from(blob),
      version,
      sha256,
      size: blob.length,
      updatedAt: new Date(this.now()).toISOString(),
      uploadId: null,
      parts: 0,
    });
    return { ok: true, version };
  }

  async createUpload(tokenHash: string, uploadId: string): Promise<void> {
    for (const u of this.uploads.values()) {
      if (u.tokenHash === tokenHash && u.state === 'open') u.state = 'replaced';
    }
    this.uploads.set(uploadId, { tokenHash, state: 'open', createdAt: this.now(), committedAt: null, supersededAt: null, parts: new Map() });
  }

  async putPart(tokenHash: string, uploadId: string, n: number, bytes: Buffer): Promise<PartWrite> {
    const u = this.uploads.get(uploadId);
    if (!u || u.tokenHash !== tokenHash || u.state !== 'open') return 'unknown_upload';
    if (!u.parts.has(n)) u.parts.set(n, Buffer.from(bytes));
    return 'ok';
  }

  async readOpenParts(tokenHash: string, uploadId: string): Promise<Array<[number, Buffer]> | null> {
    const u = this.uploads.get(uploadId);
    if (!u || u.tokenHash !== tokenHash || u.state !== 'open') return null;
    return [...u.parts.entries()].sort((a, b) => a[0] - b[0]).map(([n, b]) => [n, Buffer.from(b)]);
  }

  async commitUpload(
    tokenHash: string,
    uploadId: string,
    base: number,
    sha256: string,
    size: number,
    parts: number,
  ): Promise<CommitResult> {
    const u = this.uploads.get(uploadId);
    if (!u || u.tokenHash !== tokenHash || u.state !== 'open' || u.parts.size !== parts) {
      return { ok: false, reason: 'replaced' };
    }
    const existing = this.rows.get(tokenHash);
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== base) return { ok: false, reason: 'conflict', version: currentVersion };
    u.state = 'committed';
    u.committedAt = this.now();
    this.supersede(existing?.uploadId ?? null);
    const version = currentVersion + 1;
    this.rows.set(tokenHash, {
      blob: Buffer.alloc(0),
      version,
      sha256,
      size,
      updatedAt: new Date(this.now()).toISOString(),
      uploadId,
      parts,
    });
    return { ok: true, version };
  }

  async getPart(tokenHash: string, uploadId: string, n: number): Promise<Buffer | null> {
    const u = this.uploads.get(uploadId);
    if (!u || u.tokenHash !== tokenHash || u.state !== 'committed') return null;
    const bytes = u.parts.get(n);
    return bytes ? Buffer.from(bytes) : null;
  }

  async pruneUploads(tokenHash: string): Promise<void> {
    const now = this.now();
    const current = this.rows.get(tokenHash)?.uploadId ?? null;
    const superseded: Array<[string, MemUpload]> = [];
    for (const [id, u] of this.uploads) {
      if (u.tokenHash !== tokenHash || id === current) continue;
      if (u.state === 'replaced' || (u.state === 'open' && now - u.createdAt > OPEN_UPLOAD_TTL_MS)) {
        this.uploads.delete(id);
      } else if (u.state === 'committed') {
        superseded.push([id, u]);
      }
    }
    // A claimed upload that lost its version race was never current: it ages from its claim.
    const since = (u: MemUpload): number => u.supersededAt ?? u.committedAt ?? 0;
    superseded.sort((a, b) => since(b[1]) - since(a[1]));
    superseded.forEach(([id, u], i) => {
      if (i >= SUPERSEDED_KEEP_MAX || now - since(u) > SUPERSEDED_READABLE_MS) this.uploads.delete(id);
    });
  }

  /** Starts the readable window of the upload a new version replaces. */
  private supersede(uploadId: string | null): void {
    const u = uploadId ? this.uploads.get(uploadId) : undefined;
    if (u) u.supersededAt = this.now();
  }
}
