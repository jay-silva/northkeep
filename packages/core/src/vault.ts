import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical.js';
import {
  KDF_MODERATE,
  NONCE_BYTES,
  SALT_BYTES,
  VaultAuthError,
  blake2bHex,
  decrypt,
  deriveMasterKey,
  encryptWithNonce,
  kdfParamsInBounds,
  memzero,
  randomBytes,
  type KdfParams,
} from './crypto.js';
import { SCHEMA_DDL } from './schema.js';
import {
  GENESIS_HASH,
  SCHEMA_VERSION,
  isMemoryType,
  type ExportedMemory,
  type ListFilter,
  type MemoryEntry,
  type RememberInput,
  type RetrieveOptions,
  type ScoredEntry,
  type VaultExport,
} from './types.js';

/**
 * Vault file format (.nkv) — see SPEC/security-model.md and ADR 0001:
 *   [ magic "NKV1" | salt 16B | opslimit u32LE | memlimit u32LE | nonce 24B | ciphertext ]
 * Ciphertext is XChaCha20-Poly1305 over the serialized SQLite image, with the
 * full header as AEAD associated data. The SQLite database exists only in
 * memory while the vault is open.
 */
const MAGIC = Buffer.from('NKV1', 'ascii');
const HEADER_LENGTH = MAGIC.length + SALT_BYTES + 4 + 4 + NONCE_BYTES;

export interface VaultCredentials {
  passphrase: string;
  deviceSecret: Buffer;
}

export interface VaultOptions extends VaultCredentials {
  path: string;
  /** Override KDF cost (tests only — production uses MODERATE). */
  kdf?: KdfParams;
}

export interface VaultHeader {
  salt: Buffer;
  kdf: KdfParams;
  nonce: Buffer;
  /** The full raw header bytes (the AEAD associated data). */
  raw: Buffer;
}

interface EntryRow {
  id: string;
  type: string;
  content: string;
  scope: string;
  source: string;
  source_model: string | null;
  confidence: number;
  created_at: string;
  valid_from: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  forgotten_at: string | null;
  prev_hash: string;
  entry_hash: string;
  metadata: string | null;
}

export class Vault {
  private db: Database.Database;
  private key: Buffer;
  private readonly salt: Buffer;
  private readonly kdf: KdfParams;
  readonly path: string;
  private closed = false;

  private constructor(
    vaultPath: string,
    db: Database.Database,
    key: Buffer,
    salt: Buffer,
    kdf: KdfParams,
  ) {
    this.path = vaultPath;
    this.db = db;
    this.key = key;
    this.salt = salt;
    this.kdf = kdf;
  }

  static create(options: VaultOptions): Vault {
    if (fs.existsSync(options.path)) {
      throw new Error(`A vault already exists at ${options.path}. Refusing to overwrite it.`);
    }
    const kdf = options.kdf ?? KDF_MODERATE;
    const salt = randomBytes(SALT_BYTES);
    const key = deriveMasterKey(options.passphrase, options.deviceSecret, salt, kdf);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_DDL);
    const setMeta = db.prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?)');
    setMeta.run('schema_version', SCHEMA_VERSION);
    setMeta.run('vault_id', randomUUID());
    setMeta.run('chain_head', GENESIS_HASH);
    setMeta.run('created_at', new Date().toISOString());
    const vault = new Vault(options.path, db, key, salt, kdf);
    vault.save();
    return vault;
  }

  /** Parses and bounds-checks the plaintext header without decrypting anything. */
  static readHeader(vaultPath: string): VaultHeader {
    let file: Buffer;
    try {
      file = fs.readFileSync(vaultPath);
    } catch {
      throw new Error(`No vault found at ${vaultPath}. Run "northkeep init" first.`);
    }
    if (file.length < HEADER_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new VaultAuthError(`${vaultPath} is not a NorthKeep vault file.`);
    }
    let offset = MAGIC.length;
    const salt = Buffer.from(file.subarray(offset, offset + SALT_BYTES));
    offset += SALT_BYTES;
    const opslimit = file.readUInt32LE(offset);
    offset += 4;
    const memlimit = file.readUInt32LE(offset);
    offset += 4;
    const nonce = Buffer.from(file.subarray(offset, offset + NONCE_BYTES));
    // KDF params come from the file so old vaults keep opening if defaults
    // change — but they are read BEFORE authentication, so bound them: a
    // tampered header must not be able to demand unbounded Argon2id work.
    const kdf: KdfParams = { opslimit, memlimit };
    if (!kdfParamsInBounds(kdf)) throw new VaultAuthError();
    return { salt, kdf, nonce, raw: Buffer.from(file.subarray(0, HEADER_LENGTH)) };
  }

  static open(options: VaultOptions): Vault {
    const header = Vault.readHeader(options.path);
    const key = deriveMasterKey(options.passphrase, options.deviceSecret, header.salt, header.kdf);
    return Vault.openDecrypting(options.path, key, header);
  }

  /**
   * Opens with an already-derived master key (background/MCP access after
   * `northkeep unlock`). Skips Argon2id entirely. Takes ownership of the key
   * buffer on success AND failure — callers must pass a copy if they reuse it.
   */
  static openWithKey(vaultPath: string, masterKey: Buffer): Vault {
    let header: VaultHeader;
    try {
      header = Vault.readHeader(vaultPath);
    } catch (err) {
      memzero(masterKey); // ownership promise holds even pre-decrypt
      throw err;
    }
    return Vault.openDecrypting(vaultPath, masterKey, header);
  }

  private static openDecrypting(vaultPath: string, key: Buffer, header: VaultHeader): Vault {
    const file = fs.readFileSync(vaultPath);
    const ciphertext = Buffer.from(file.subarray(HEADER_LENGTH));
    let image: Buffer;
    try {
      image = decrypt(ciphertext, key, header.nonce, header.raw);
    } catch (err) {
      memzero(key);
      throw err;
    }
    // (The image buffer itself is left to GC — RAM-resident plaintext while
    // unlocked is an accepted, documented limit.)
    let db: Database.Database | null = null;
    try {
      db = new Database(image);
      db.pragma('foreign_keys = ON');
      const vault = new Vault(vaultPath, db, key, header.salt, header.kdf);
      vault.migrate();
      return vault;
    } catch (err) {
      db?.close();
      memzero(key);
      throw err;
    }
  }

  /** In-place schema upgrades for vaults created by older releases. */
  private migrate(): void {
    const version = this.getMeta('schema_version');
    if (version === SCHEMA_VERSION) return;
    if (version === '0.1') {
      // 0.1 → 0.2: add the forgotten_at tombstone column, and rehash the
      // chain under the 0.2 rule (mutable bookkeeping fields left out of the
      // hash input). Pre-release rule change — see SPEC/memory-schema.md.
      this.db.exec('ALTER TABLE memories ADD COLUMN forgotten_at TEXT');
      const rows = this.db.prepare('SELECT * FROM memories ORDER BY rowid ASC').all() as EntryRow[];
      const update = this.db.prepare(
        'UPDATE memories SET prev_hash = ?, entry_hash = ? WHERE id = ?',
      );
      let prev = GENESIS_HASH;
      for (const row of rows) {
        const entry = rowToEntry(row);
        entry.prev_hash = prev;
        const hash = computeEntryHash(entry);
        update.run(prev, hash, entry.id);
        prev = hash;
      }
      this.setMeta('chain_head', prev);
      this.setMeta('schema_version', '0.2');
      this.save();
      console.error('northkeep: migrated vault schema 0.1 → 0.2 (rehashed provenance chain)');
      return;
    }
    throw new Error(
      `Vault schema ${version} is newer than this build understands (${SCHEMA_VERSION}). Update NorthKeep.`,
    );
  }

  /** Serialize → encrypt with a fresh nonce → atomic replace, keeping the previous file as .bak. */
  save(): void {
    this.assertOpen();
    const image = this.db.serialize();
    const header = Buffer.alloc(HEADER_LENGTH);
    MAGIC.copy(header, 0);
    this.salt.copy(header, MAGIC.length);
    header.writeUInt32LE(this.kdf.opslimit, MAGIC.length + SALT_BYTES);
    header.writeUInt32LE(this.kdf.memlimit, MAGIC.length + SALT_BYTES + 4);
    // The nonce lives inside the header, and the header is the AEAD associated
    // data — so the nonce must be in place before encrypting.
    const nonce = randomBytes(NONCE_BYTES);
    nonce.copy(header, MAGIC.length + SALT_BYTES + 8);
    const ciphertext = encryptWithNonce(image, this.key, nonce, header);
    const tmpPath = `${this.path}.tmp`;
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, header);
      fs.writeSync(fd, ciphertext);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.path)) {
      fs.copyFileSync(this.path, `${this.path}.bak`);
    }
    fs.renameSync(tmpPath, this.path);
    // fsync the directory so the rename itself survives power loss.
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  remember(input: RememberInput): MemoryEntry {
    this.assertOpen();
    if (!input.content || input.content.trim().length === 0) {
      throw new Error('Memory content must not be empty.');
    }
    if (!isMemoryType(input.type)) {
      throw new Error(
        `Invalid memory type "${input.type}". Must be one of: episodic, semantic, procedural, working, identity.`,
      );
    }
    const confidence = input.confidence ?? 1.0;
    if (confidence < 0 || confidence > 1) {
      throw new Error('Confidence must be between 0.0 and 1.0.');
    }
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      type: input.type,
      content: input.content,
      scope: input.scope?.trim() || 'personal',
      source: input.source?.trim() || 'cli',
      source_model: input.sourceModel ?? null,
      confidence,
      created_at: now,
      valid_from: now,
      superseded_at: null,
      superseded_by: null,
      forgotten_at: null,
      prev_hash: this.getMeta('chain_head'),
      entry_hash: '',
      // Hash the storage form: a JSON round-trip applies toJSON semantics
      // (Dates etc.) now, so the hash matches what a reopen will read back.
      metadata:
        input.metadata == null
          ? null
          : (JSON.parse(JSON.stringify(input.metadata)) as Record<string, unknown>),
    };
    entry.entry_hash = computeEntryHash(entry);

    this.db
      .prepare(
        `INSERT INTO memories
         (id, type, content, scope, source, source_model, confidence, created_at,
          valid_from, superseded_at, superseded_by, forgotten_at, prev_hash, entry_hash, metadata)
         VALUES (@id, @type, @content, @scope, @source, @source_model, @confidence,
                 @created_at, @valid_from, @superseded_at, @superseded_by, @forgotten_at,
                 @prev_hash, @entry_hash, @metadata)`,
      )
      .run({ ...entry, metadata: entry.metadata === null ? null : JSON.stringify(entry.metadata) });
    this.setMeta('chain_head', entry.entry_hash);
    return entry;
  }

  /**
   * Tombstones an entry: the content is irrecoverably blanked, but the row —
   * with its original hashes — stays so the provenance chain remains intact
   * and the deletion itself is visible ("an entry in this scope was forgotten
   * on this date"). Accepts a full id or an unambiguous prefix.
   */
  forget(idOrPrefix: string, allowedScopes?: string[]): MemoryEntry {
    this.assertOpen();
    const prefix = idOrPrefix.trim();
    if (prefix.length < 4) {
      throw new Error('Provide at least 4 characters of the memory id.');
    }
    // UUID charset only: LIKE metacharacters (%, _) in the prefix would act
    // as wildcards and could irreversibly forget an entry the caller never
    // named.
    if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) {
      throw new Error('Memory ids contain only hex characters and dashes.');
    }
    // Scope the id lookup to the grant so out-of-grant entries don't even
    // affect the match count (no cross-scope existence/count oracle).
    let sql = "SELECT * FROM memories WHERE id LIKE ? || '%' AND forgotten_at IS NULL";
    const args: string[] = [prefix];
    if (allowedScopes !== undefined) {
      if (allowedScopes.length === 0) throw new Error(`No memory found matching id "${prefix}".`);
      sql += ` AND scope IN (${allowedScopes.map(() => '?').join(', ')})`;
      args.push(...allowedScopes);
    }
    const matches = this.db.prepare(`${sql} ORDER BY rowid ASC`).all(...args) as EntryRow[];
    if (matches.length === 0) throw new Error(`No memory found matching id "${prefix}".`);
    if (matches.length > 1) {
      throw new Error(`Id prefix "${prefix}" matches ${matches.length} memories — be more specific.`);
    }
    const row = matches[0]!;
    const forgottenAt = new Date().toISOString();
    this.db
      .prepare("UPDATE memories SET content = '', metadata = NULL, forgotten_at = ? WHERE id = ?")
      .run(forgottenAt, row.id);
    return { ...rowToEntry(row), content: '', metadata: null, forgotten_at: forgottenAt };
  }

  /**
   * Keyword retrieval: term overlap + recency + type priority. Honest about
   * what it is — semantic (embedding) retrieval arrives with the local-model
   * milestone. Excludes forgotten and superseded entries.
   */
  retrieve(query: string, options: RetrieveOptions = {}): ScoredEntry[] {
    this.assertOpen();
    const limit = options.limit ?? 8;
    const queryTerms = tokenize(query);
    if (queryTerms.size === 0) return [];
    const candidates = this.list({
      type: options.type,
      scope: options.scope,
      allowedScopes: options.allowedScopes,
    }).filter((entry) => entry.superseded_at === null);
    const now = Date.now();
    const scored: ScoredEntry[] = [];
    for (const entry of candidates) {
      const entryTerms = tokenize(entry.content);
      let matched = 0;
      for (const term of queryTerms) if (entryTerms.has(term)) matched += 1;
      if (matched === 0) continue;
      const overlap = matched / queryTerms.size;
      const ageDays = Math.max(0, now - Date.parse(entry.created_at)) / 86_400_000;
      const recency = 0.3 * Math.exp(-ageDays / 30);
      const typeBoost = TYPE_PRIORITY[entry.type] ?? 0;
      scored.push({ entry, score: overlap + recency + typeBoost });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  list(filter: ListFilter = {}): MemoryEntry[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.type) {
      clauses.push('type = @type');
      params.type = filter.type;
    }
    if (filter.scope) {
      clauses.push('scope = @scope');
      params.scope = filter.scope;
    }
    if (!filter.includeForgotten) {
      clauses.push('forgotten_at IS NULL');
    }
    // Capability enforcement: an allowlist caps what's visible no matter what
    // scope filter was requested. An empty allowlist sees nothing.
    if (filter.allowedScopes !== undefined) {
      if (filter.allowedScopes.length === 0) return [];
      const names = filter.allowedScopes.map((_, i) => `@as${i}`);
      clauses.push(`scope IN (${names.join(', ')})`);
      filter.allowedScopes.forEach((s, i) => (params[`as${i}`] = s));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY rowid ASC`)
      .all(params) as EntryRow[];
    return rows.map(rowToEntry);
  }

  /** Distinct scopes present in the vault (live entries), sorted. */
  scopes(): string[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT DISTINCT scope FROM memories WHERE forgotten_at IS NULL ORDER BY scope')
      .all() as Array<{ scope: string }>;
    return rows.map((r) => r.scope);
  }

  /** Replays the hash chain over all entries in insertion order. */
  verifyChain(): { ok: boolean; error?: string } {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY rowid ASC')
      .all() as EntryRow[];
    let prev = GENESIS_HASH;
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (entry.prev_hash !== prev) {
        return { ok: false, error: `Entry ${entry.id} breaks the chain: prev_hash mismatch.` };
      }
      // Forgotten entries keep their original hashes for linkage, but their
      // content is blanked so the content check no longer applies.
      if (entry.forgotten_at === null) {
        const expected = computeEntryHash(entry);
        if (entry.entry_hash !== expected) {
          return { ok: false, error: `Entry ${entry.id} hash does not match its content.` };
        }
      }
      prev = entry.entry_hash;
    }
    const head = this.getMeta('chain_head');
    if (head !== prev) {
      return { ok: false, error: 'Chain head does not match the last entry.' };
    }
    return { ok: true };
  }

  /** Complete, human-readable export per SPEC/memory-schema.md. Embeddings are never exported. */
  export(): VaultExport {
    this.assertOpen();
    const memories: ExportedMemory[] = this.list({ includeForgotten: true }).map((entry) => ({
      id: entry.id,
      type: entry.type,
      content: entry.content,
      scope: entry.scope,
      provenance: {
        source: entry.source,
        source_model: entry.source_model,
        confidence: entry.confidence,
        created_at: entry.created_at,
        prev_hash: entry.prev_hash,
        entry_hash: entry.entry_hash,
      },
      validity: {
        valid_from: entry.valid_from,
        superseded_at: entry.superseded_at,
        superseded_by: entry.superseded_by,
        forgotten_at: entry.forgotten_at,
      },
      metadata: entry.metadata,
    }));
    return {
      northkeep_export: {
        schema_version: this.getMeta('schema_version'),
        vault_id: this.getMeta('vault_id'),
        exported_at: new Date().toISOString(),
        chain_head: this.getMeta('chain_head'),
      },
      memories,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    memzero(this.key);
  }

  private getMeta(key: string): string {
    const row = this.db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) throw new Error(`Vault is missing required metadata "${key}".`);
    return row.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Vault is closed.');
  }
}

/**
 * Hash input per SPEC v0.2: the immutable-at-creation fields plus prev_hash.
 * Mutable bookkeeping (superseded_at, superseded_by, forgotten_at) is
 * deliberately excluded — those fields change after the fact, and hashing
 * them would break the chain on every legitimate supersede/forget.
 */
export function computeEntryHash(entry: MemoryEntry): string {
  return blake2bHex(
    canonicalJson({
      id: entry.id,
      type: entry.type,
      content: entry.content,
      scope: entry.scope,
      source: entry.source,
      source_model: entry.source_model,
      confidence: entry.confidence,
      created_at: entry.created_at,
      valid_from: entry.valid_from,
      metadata: entry.metadata,
      prev_hash: entry.prev_hash,
    }),
  );
}

function rowToEntry(row: EntryRow): MemoryEntry {
  return {
    ...row,
    type: row.type as MemoryEntry['type'],
    forgotten_at: row.forgotten_at ?? null,
    metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>),
  };
}

const TYPE_PRIORITY: Record<string, number> = {
  identity: 0.15,
  semantic: 0.1,
  procedural: 0.05,
};

function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().normalize('NFC').matchAll(/[a-z0-9]{2,}/g)) {
    terms.add(match[0]);
  }
  return terms;
}
