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
 * Storage discipline (invariant #2 spirit + ADR 0016 threat model):
 *  - Token, authorization-code, and pairing-code values are stored as sha256 hex
 *    ONLY. The raw value lives only in the client's possession. A DB thief gets
 *    hashes, never a usable credential.
 *  - `shared_entries` holds the plaintext of scopes the user EXPLICITLY marked
 *    Shared (the opt-in carve-out) and nothing derived from it — no embeddings,
 *    no analytics.
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
}

/** An access- or refresh-token record. `expiresAt` is SECONDS since epoch (matches AuthInfo). */
export interface StoredOAuthToken {
  clientId: string;
  accountHash: string;
  audience: string;
  /** seconds since epoch. */
  expiresAt: number;
  kind: 'access' | 'refresh';
}

/** One shared-scope entry, scoped to a single account. PK is (accountHash, entryId). */
export interface SharedEntry {
  entryId: string;
  scope: string;
  type: string;
  content: string;
  /** The vault entry_hash (BLAKE2b chain hash) — lets the client diff cheaply
   * via /client/manifest. Optional so C1 seeded rows (no hash) still typecheck. */
  entryHash?: string;
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

  // --- pairing codes (single-use, short TTL) ---
  putPairingCode(codeHash: string, accountHash: string, expiresAt: number): Promise<void>;
  /**
   * Atomically consume a pairing code: returns the bound accountHash iff the code
   * exists, is unconsumed, and is unexpired — and flips it consumed in the SAME
   * statement (no read-then-write race → no double-spend). Otherwise null.
   */
  consumePairingCode(codeHash: string): Promise<string | null>;

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

  // --- audit ---
  appendAudit(entry: ConnectorAuditEntry): Promise<void>;
}

interface PairingRow {
  accountHash: string;
  expiresAt: number;
  consumed: boolean;
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
  private accounts = new Set<string>();
  private pairings = new Map<string, PairingRow>();
  private clients = new Map<string, ClientRow>();
  private codes = new Map<string, CodeRow>();
  private tokens = new Map<string, StoredOAuthToken>();
  /** accountHash -> (entryId -> entry) */
  private entries = new Map<string, Map<string, SharedEntry>>();
  /** accountHash -> tombstones */
  private tombstones = new Map<string, ScopeTombstone[]>();
  private audit: ConnectorAuditEntry[] = [];

  async upsertAccount(accountHash: string): Promise<void> {
    this.accounts.add(accountHash);
  }

  async putPairingCode(codeHash: string, accountHash: string, expiresAt: number): Promise<void> {
    this.pairings.set(codeHash, { accountHash, expiresAt, consumed: false });
  }

  async consumePairingCode(codeHash: string): Promise<string | null> {
    const row = this.pairings.get(codeHash);
    if (!row || row.consumed || row.expiresAt <= Date.now()) return null;
    row.consumed = true;
    return row.accountHash;
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
    // Delete any pre-existing row in a pushed scope that the payload omitted.
    for (const [id, e] of [...byId.entries()]) {
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

  async appendAudit(entry: ConnectorAuditEntry): Promise<void> {
    this.audit.push({ ...entry });
  }

  /** Test-only accessor for the audit ledger. */
  auditRows(): ConnectorAuditEntry[] {
    return this.audit.map((e) => ({ ...e }));
  }
}
