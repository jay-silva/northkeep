/**
 * Storage abstraction for the hosted shareable-scope connector (Track C, phase
 * C1). Every OAuth/auth artifact the connector issues is persisted here so ANY
 * serverless instance can serve ANY request — this is the whole point of C1 and
 * the exact failure mode of the C0 in-memory spike (a token minted on one Vercel
 * worker 401'd on the next).
 *
 * Two implementations mirror the sync server: `InMemoryConnectorStorage` (tests
 * and local dev) and `NeonConnectorStorage` (production). The interface is the
 * seam; the handlers/provider are written against it and never touch a Map or a
 * SQL string directly.
 *
 * Storage discipline (invariant #2 spirit + ADR 0016/0020 threat model):
 *  - Token, authorization-code, and pairing-code values are stored as sha256 hex
 *    ONLY. The raw value lives only in the client's possession. A DB thief gets
 *    hashes, never a usable credential.
 *  - `shared_entries.content` holds CIPHERTEXT only (ADR 0020): the "nkc1:"
 *    envelope encrypted under a per-account DEK. The DEK itself is stored only
 *    WRAPPED ("nkw1:", in the `dek_wrap` column of each credential row), under
 *    KEKs derived from credentials the server sees only transiently. Storage is
 *    a dumb string store: it NEVER imports crypto.ts and never sees a key —
 *    encryption/decryption happens strictly above this layer.
 *  - `connector_audit` is content-free: what was asked and how many rows came
 *    back, never what they said (mirrors packages/mcp-server/src/log.ts).
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

/** An authorization-code record, bound to an account once the pairing code is accepted. */
export interface StoredOAuthCode {
  clientId: string;
  /** sha256(connector_token) — the anonymous account key. Never a raw secret. */
  accountHash: string;
  /** PKCE S256 code_challenge captured at authorize; verified by the SDK at token. */
  pkceChallenge: string;
  redirectUri: string;
  /** RFC 8707 resource this code is bound to (always <PUBLIC_URL>/mcp). */
  audience: string;
  /** ms since epoch. */
  expiresAt: number;
  /** The account DEK wrapped under the auth-code KEK ("nkw1:...", ADR 0020). '' if absent. */
  dekWrap: string;
}

/** An access- or refresh-token record. `expiresAt` is SECONDS since epoch (matches AuthInfo). */
export interface StoredOAuthToken {
  clientId: string;
  accountHash: string;
  audience: string;
  /** seconds since epoch. */
  expiresAt: number;
  kind: 'access' | 'refresh';
  /** The account DEK wrapped under this token's KEK ("nkw1:...", ADR 0020). '' if absent. */
  dekWrap: string;
}

/**
 * One shared-scope entry, scoped to a single account. PK is (accountHash, entryId).
 * Since ADR 0020, `content` is the "nkc1:" ciphertext envelope (which also
 * carries the encrypted `type`) and the `type` column is '' — the scope label,
 * ids, and entry_hash stay plaintext metadata for diffing/reconciliation.
 */
export interface SharedEntry {
  entryId: string;
  scope: string;
  type: string;
  content: string;
  /** The vault entry_hash (BLAKE2b chain hash) — lets the client diff cheaply
   * via /client/manifest. Optional so C1 seeded rows (no hash) still typecheck. */
  entryHash?: string;
  /**
   * Where the row came from (C3 write-back). 'vault' = pushed from the desktop
   * (the C1/C2 default). 'connector' = born INSIDE an AI flow via memory_remember,
   * not yet in the user's vault. Optional (absent ⇒ 'vault') so pre-C3 rows read.
   */
  origin?: 'vault' | 'connector';
  /**
   * A connector-born row that has NOT yet been delivered to the client by a
   * down-sync. It is served on /client/pending and must survive an intervening
   * push reconcile-delete. Cleared (false) once the client acks it. Absent ⇒ false.
   */
  pending?: boolean;
  createdAt: string;
}

/** A content-free record that a scope was unshared (ADR 0019 retention/deletion). */
export interface ScopeTombstone {
  scope: string;
  unsharedAt: string;
}

/**
 * A content-free audit row, mirroring the CallLogEntry shape from
 * packages/mcp-server/src/log.ts. NEVER carries content — only counts and ids.
 */
export interface ConnectorAuditEntry {
  ts: string;
  accountHash: string;
  tool: string;
  params: { query_terms?: number; limit?: number };
  ok: boolean;
  resultCount: number;
  /** The entry ids disclosed by this call — the disclosure ledger, ids only. */
  resultIds: string[];
}

export interface ConnectorStorage {
  // --- accounts ---
  /** Idempotently record that an account exists (keyed by sha256(connector_token)). */
  upsertAccount(accountHash: string): Promise<void>;
  /**
   * Stamp a billing grace window (C3): the ms-since-epoch until which this
   * account is entitled, set when the desktop forwards a valid entitlement. Only
   * ever advances (a later push refreshes it); never moves backward.
   */
  setEntitledUntil(accountHash: string, untilMs: number): Promise<void>;
  /** The account's entitled-until stamp (ms since epoch), or null if never set. */
  getEntitledUntil(accountHash: string): Promise<number | null>;
  /**
   * Race-safe create of the account's DEK wrap (ADR 0020): a SINGLE statement
   * `SET dek_wrap = COALESCE(dek_wrap, candidate) ... RETURNING dek_wrap`, so two
   * concurrent first-writers converge — whatever comes back IS the account wrap
   * (the loser must unwrap the RETURNED wrap, not its own candidate). The account
   * row must already exist (call after upsertAccount); throws if it does not.
   */
  ensureAccountDekWrap(accountHash: string, candidateWrap: string): Promise<string>;
  /** The account's DEK wrapped under the connector-token KEK, or null if none yet. */
  getAccountDekWrap(accountHash: string): Promise<string | null>;

  // --- pairing codes (single-use, short TTL) ---
  putPairingCode(codeHash: string, accountHash: string, expiresAt: number, dekWrap: string): Promise<void>;
  /**
   * Atomically consume a pairing code: returns the bound accountHash + the DEK
   * wrap iff the code exists, is unconsumed, and is unexpired — and flips it
   * consumed in the SAME statement (no read-then-write race → no double-spend).
   * Otherwise null.
   */
  consumePairingCode(codeHash: string): Promise<{ accountHash: string; dekWrap: string } | null>;

  // --- OAuth clients (RFC 7591 DCR) ---
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  /**
   * Persist a registered client. `clientSecretHash` is sha256 of the SDK-issued
   * secret when the client is confidential (null for public/PKCE clients — the
   * common case for Claude/ChatGPT). See the SDK-gap note in the report re: the
   * full client JSON.
   */
  registerClient(client: OAuthClientInformationFull, clientSecretHash: string | null): Promise<void>;

  // --- OAuth authorization codes ---
  putCode(codeHash: string, rec: StoredOAuthCode): Promise<void>;
  /** Non-consuming read (unconsumed + unexpired), used for the PKCE challenge lookup. */
  getCode(codeHash: string): Promise<StoredOAuthCode | null>;
  /** Atomic single-use consume at token exchange (unconsumed + unexpired → flip + return). */
  consumeCode(codeHash: string): Promise<StoredOAuthCode | null>;

  // --- OAuth access/refresh tokens ---
  putToken(tokenHash: string, rec: StoredOAuthToken): Promise<void>;
  getToken(tokenHash: string): Promise<StoredOAuthToken | null>;
  deleteToken(tokenHash: string): Promise<void>;
  /**
   * Atomically consume a REFRESH token: a single `DELETE ... WHERE kind='refresh'
   * AND unexpired RETURNING *`. Replaces the get-then-delete rotation flow and
   * closes the pre-existing OAuth 2.1 race where two concurrent refreshes both
   * succeeded — the loser now finds nothing (invalid_grant). Returns the deleted
   * row (incl. its dekWrap) or null.
   */
  consumeToken(tokenHash: string): Promise<StoredOAuthToken | null>;

  // --- shared entries (the opt-in plaintext carve-out) ---
  /** Seed/replace a single shared entry (C1 seeding + the /debug/seed route). */
  putEntry(accountHash: string, entry: SharedEntry): Promise<void>;
  /** Every shared entry for exactly this account — the scope-isolation boundary. */
  listEntries(accountHash: string): Promise<SharedEntry[]>;
  /**
   * C2 "make these scopes match" push: upsert every entry in `entries`, then
   * DELETE any existing row in one of `scopes` whose entryId is not in `entries`.
   * After this call the account's rows for each scope in `scopes` are EXACTLY the
   * provided ones (a forgotten/removed vault entry disappears server-side). A
   * scope in `scopes` with no entries in the payload is cleared entirely. Callers
   * must guarantee every entry.scope ∈ scopes (the server route validates this).
   */
  replaceScopes(accountHash: string, scopes: string[], entries: SharedEntry[]): Promise<void>;
  /**
   * Unshare: delete every row in `scope` for this account and write a
   * content-free `scope_tombstones` row. Returns how many rows were deleted.
   */
  deleteScope(accountHash: string, scope: string): Promise<number>;
  /** The account's unshare tombstones (audit / inspection). */
  listTombstones(accountHash: string): Promise<ScopeTombstone[]>;

  // --- write-back down-sync (C3) ---
  /** A single row by id, or null. memory_forget reads this to decide cancel-vs-enqueue. */
  getEntry(accountHash: string, entryId: string): Promise<SharedEntry | null>;
  /** Delete one row outright — cancel-before-delivery of a still-pending connector row. */
  deleteEntry(accountHash: string, entryId: string): Promise<void>;
  /** Connector-born rows not yet delivered to the client (origin='connector' AND pending). */
  listPendingEntries(accountHash: string): Promise<SharedEntry[]>;
  /**
   * Queue a forget of an already-delivered entry so the client tombstones it on
   * the next down-sync. Idempotent (re-queuing the same id is a no-op).
   */
  enqueueForget(accountHash: string, entryId: string): Promise<void>;
  /** Entry ids with a queued forget — hidden from retrieve/list, sent on /client/pending. */
  listPendingForgets(accountHash: string): Promise<string[]>;
  /**
   * Ack a delivered connector row: remap its server id → the client's local
   * entry id and clear `pending`. Collision-safe (drops any pre-existing row
   * already under the local id first). No-op if the server id no longer exists.
   */
  ackEntry(accountHash: string, serverId: string, localEntryId: string): Promise<void>;
  /** Apply an acked forget: delete BOTH the pending_forgets row and the shared_entries row. */
  applyForget(accountHash: string, entryId: string): Promise<void>;

  // --- audit ---
  appendAudit(entry: ConnectorAuditEntry): Promise<void>;
}

interface PairingRow {
  accountHash: string;
  expiresAt: number;
  consumed: boolean;
  dekWrap: string;
}
interface CodeRow extends StoredOAuthCode {
  consumed: boolean;
}
interface ClientRow {
  info: OAuthClientInformationFull;
  clientSecretHash: string | null;
}

/**
 * In-memory storage — tests and local/dev runs. Not durable and NOT shared
 * across processes. Two `createConnectorServer()` instances built over the SAME
 * instance of this class share state, which is how the e2e simulates a
 * serverless cold start hitting a warm token.
 */
export class InMemoryConnectorStorage implements ConnectorStorage {
  /** accountHash -> DEK wrap (null until first created). */
  private accounts = new Map<string, string | null>();
  /** accountHash -> entitled-until (ms since epoch). */
  private entitledUntil = new Map<string, number>();
  private pairings = new Map<string, PairingRow>();
  private clients = new Map<string, ClientRow>();
  private codes = new Map<string, CodeRow>();
  private tokens = new Map<string, StoredOAuthToken>();
  /** accountHash -> (entryId -> entry) */
  private entries = new Map<string, Map<string, SharedEntry>>();
  /** accountHash -> tombstones */
  private tombstones = new Map<string, ScopeTombstone[]>();
  /** accountHash -> set of entry ids queued to be forgotten by the client (C3). */
  private pendingForgets = new Map<string, Set<string>>();
  private audit: ConnectorAuditEntry[] = [];

  async upsertAccount(accountHash: string): Promise<void> {
    if (!this.accounts.has(accountHash)) this.accounts.set(accountHash, null);
  }

  async ensureAccountDekWrap(accountHash: string, candidateWrap: string): Promise<string> {
    if (!this.accounts.has(accountHash)) {
      throw new Error('ensureAccountDekWrap: unknown account (upsertAccount first)');
    }
    const existing = this.accounts.get(accountHash);
    if (existing) return existing; // COALESCE semantics: first write wins
    this.accounts.set(accountHash, candidateWrap);
    return candidateWrap;
  }

  async getAccountDekWrap(accountHash: string): Promise<string | null> {
    return this.accounts.get(accountHash) ?? null;
  }

  async setEntitledUntil(accountHash: string, untilMs: number): Promise<void> {
    const prev = this.entitledUntil.get(accountHash) ?? 0;
    if (untilMs > prev) this.entitledUntil.set(accountHash, untilMs);
  }

  async getEntitledUntil(accountHash: string): Promise<number | null> {
    return this.entitledUntil.get(accountHash) ?? null;
  }

  async putPairingCode(codeHash: string, accountHash: string, expiresAt: number, dekWrap: string): Promise<void> {
    this.pairings.set(codeHash, { accountHash, expiresAt, consumed: false, dekWrap });
  }

  async consumePairingCode(codeHash: string): Promise<{ accountHash: string; dekWrap: string } | null> {
    const row = this.pairings.get(codeHash);
    if (!row || row.consumed || row.expiresAt <= Date.now()) return null;
    row.consumed = true;
    return { accountHash: row.accountHash, dekWrap: row.dekWrap };
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId)?.info;
  }

  async registerClient(client: OAuthClientInformationFull, clientSecretHash: string | null): Promise<void> {
    this.clients.set(client.client_id, { info: client, clientSecretHash });
  }

  async putCode(codeHash: string, rec: StoredOAuthCode): Promise<void> {
    this.codes.set(codeHash, { ...rec, consumed: false });
  }

  async getCode(codeHash: string): Promise<StoredOAuthCode | null> {
    const row = this.codes.get(codeHash);
    if (!row || row.consumed || row.expiresAt <= Date.now()) return null;
    const { consumed: _consumed, ...rec } = row;
    return rec;
  }

  async consumeCode(codeHash: string): Promise<StoredOAuthCode | null> {
    const row = this.codes.get(codeHash);
    if (!row || row.consumed || row.expiresAt <= Date.now()) return null;
    row.consumed = true;
    const { consumed: _consumed, ...rec } = row;
    return rec;
  }

  async putToken(tokenHash: string, rec: StoredOAuthToken): Promise<void> {
    this.tokens.set(tokenHash, { ...rec });
  }

  async getToken(tokenHash: string): Promise<StoredOAuthToken | null> {
    const row = this.tokens.get(tokenHash);
    return row ? { ...row } : null;
  }

  async deleteToken(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash);
  }

  async consumeToken(tokenHash: string): Promise<StoredOAuthToken | null> {
    const row = this.tokens.get(tokenHash);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!row || row.kind !== 'refresh' || row.expiresAt <= nowSec) return null;
    this.tokens.delete(tokenHash);
    return { ...row };
  }

  async putEntry(accountHash: string, entry: SharedEntry): Promise<void> {
    let byId = this.entries.get(accountHash);
    if (!byId) {
      byId = new Map();
      this.entries.set(accountHash, byId);
    }
    byId.set(entry.entryId, { ...entry });
  }

  async listEntries(accountHash: string): Promise<SharedEntry[]> {
    const byId = this.entries.get(accountHash);
    return byId ? [...byId.values()].map((e) => ({ ...e })) : [];
  }

  async replaceScopes(accountHash: string, scopes: string[], entries: SharedEntry[]): Promise<void> {
    let byId = this.entries.get(accountHash);
    if (!byId) {
      byId = new Map();
      this.entries.set(accountHash, byId);
    }
    // Upsert everything provided, tracking which ids should survive per scope.
    const keepByScope = new Map<string, Set<string>>();
    for (const s of scopes) keepByScope.set(s, new Set());
    for (const e of entries) {
      byId.set(e.entryId, { ...e });
      keepByScope.get(e.scope)?.add(e.entryId);
    }
    // Delete any pre-existing row in a pushed scope that the payload omitted —
    // EXCEPT an undelivered connector-born row (origin='connector' AND pending).
    // That row is a memory the AI created that the user hasn't pulled yet; a push
    // racing ahead of the down-sync must not destroy it (C3 critical fix).
    for (const [id, e] of [...byId.entries()]) {
      if (e.origin === 'connector' && e.pending === true) continue;
      if (keepByScope.has(e.scope) && !keepByScope.get(e.scope)!.has(id)) {
        byId.delete(id);
      }
    }
  }

  async deleteScope(accountHash: string, scope: string): Promise<number> {
    const byId = this.entries.get(accountHash);
    let n = 0;
    if (byId) {
      for (const [id, e] of [...byId.entries()]) {
        if (e.scope === scope) {
          byId.delete(id);
          n++;
        }
      }
    }
    const list = this.tombstones.get(accountHash) ?? [];
    list.push({ scope, unsharedAt: new Date().toISOString() });
    this.tombstones.set(accountHash, list);
    return n;
  }

  async listTombstones(accountHash: string): Promise<ScopeTombstone[]> {
    return (this.tombstones.get(accountHash) ?? []).map((t) => ({ ...t }));
  }

  async getEntry(accountHash: string, entryId: string): Promise<SharedEntry | null> {
    const e = this.entries.get(accountHash)?.get(entryId);
    return e ? { ...e } : null;
  }

  async deleteEntry(accountHash: string, entryId: string): Promise<void> {
    this.entries.get(accountHash)?.delete(entryId);
  }

  async listPendingEntries(accountHash: string): Promise<SharedEntry[]> {
    const byId = this.entries.get(accountHash);
    if (!byId) return [];
    return [...byId.values()].filter((e) => e.origin === 'connector' && e.pending === true).map((e) => ({ ...e }));
  }

  async enqueueForget(accountHash: string, entryId: string): Promise<void> {
    let set = this.pendingForgets.get(accountHash);
    if (!set) {
      set = new Set();
      this.pendingForgets.set(accountHash, set);
    }
    set.add(entryId);
  }

  async listPendingForgets(accountHash: string): Promise<string[]> {
    return [...(this.pendingForgets.get(accountHash) ?? [])];
  }

  async ackEntry(accountHash: string, serverId: string, localEntryId: string): Promise<void> {
    // Re-point any forget queued against the server id onto the vault-local id,
    // so a forget that raced in between the client's fetch and this ack still
    // tombstones the delivered vault entry (never orphaned).
    const forgets = this.pendingForgets.get(accountHash);
    if (forgets?.has(serverId)) {
      forgets.delete(serverId);
      forgets.add(localEntryId);
    }
    const byId = this.entries.get(accountHash);
    const row = byId?.get(serverId);
    if (!byId || !row) return;
    byId.delete(serverId);
    // Collision-safe: overwrite any row already under the local id (the dedupe path).
    byId.set(localEntryId, { ...row, entryId: localEntryId, pending: false });
  }

  async applyForget(accountHash: string, entryId: string): Promise<void> {
    this.pendingForgets.get(accountHash)?.delete(entryId);
    this.entries.get(accountHash)?.delete(entryId);
  }

  async appendAudit(entry: ConnectorAuditEntry): Promise<void> {
    this.audit.push({ ...entry });
  }

  /** Test-only accessor for the audit ledger. */
  auditRows(): ConnectorAuditEntry[] {
    return this.audit.map((e) => ({ ...e }));
  }

  /**
   * Test-only: serialize EVERY value this store holds — accounts, wraps, codes,
   * tokens, entries, tombstones, forgets, audit. The ADR 0020 canary test walks
   * this after every operation to prove no plaintext ever touches storage.
   */
  dumpState(): string {
    return JSON.stringify({
      accounts: [...this.accounts.entries()],
      entitledUntil: [...this.entitledUntil.entries()],
      pairings: [...this.pairings.entries()],
      clients: [...this.clients.entries()],
      codes: [...this.codes.entries()],
      tokens: [...this.tokens.entries()],
      entries: [...this.entries.entries()].map(([a, m]) => [a, [...m.entries()]]),
      tombstones: [...this.tombstones.entries()],
      pendingForgets: [...this.pendingForgets.entries()].map(([a, s]) => [a, [...s]]),
      audit: this.audit,
    });
  }
}
