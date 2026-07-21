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
import type { CryptoProvider } from './crypto-provider.js';
import { getPlatform, type Platform } from './platform-context.js';
import type { SqliteDb } from './sqlite-driver.js';
import { SCHEMA_DDL } from './schema.js';
import {
  GENESIS_HASH,
  MEMORY_TYPES,
  SCHEMA_VERSION,
  isMemoryType,
  type Embedder,
  type ExportedMemory,
  type ListFilter,
  type MemoryEntry,
  type MemoryType,
  type RememberInput,
  type RetrieveOptions,
  type ScoredEntry,
  type SemanticRetrieval,
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
  /** Platform adapters to use. Defaults to the registered getPlatform(); mobile
   * may pass one directly instead of relying on the module-level default. */
  platform?: Platform;
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
  private db: SqliteDb;
  private key: Buffer;
  private readonly salt: Buffer;
  private readonly kdf: KdfParams;
  private readonly platform: Platform;
  readonly path: string;
  private closed = false;

  private constructor(
    vaultPath: string,
    db: SqliteDb,
    key: Buffer,
    salt: Buffer,
    kdf: KdfParams,
    platform: Platform,
  ) {
    this.path = vaultPath;
    this.db = db;
    this.key = key;
    this.salt = salt;
    this.kdf = kdf;
    this.platform = platform;
  }

  static create(options: VaultOptions): Vault {
    const platform = options.platform ?? getPlatform();
    if (platform.storage.exists(options.path)) {
      throw new Error(`A vault already exists at ${options.path}. Refusing to overwrite it.`);
    }
    const kdf = options.kdf ?? KDF_MODERATE;
    const salt = randomBytes(SALT_BYTES, platform.crypto);
    const key = deriveMasterKey(options.passphrase, options.deviceSecret, salt, kdf, platform.crypto);
    // From here the derived master key is live: if any step below throws, zero
    // it (and close the db) before rethrowing, matching openDecrypting's
    // discipline so a failed create never leaves key material for GC.
    let db: SqliteDb | null = null;
    try {
      db = platform.sqlite.createEmpty();
      db.pragma('foreign_keys = ON');
      // Zeroize freed pages on delete/overwrite (defense-in-depth for forget();
      // the vault image is already encrypted). Set at the same seam as the other
      // PRAGMAs, on create and on every open (openDecrypting).
      db.pragma('secure_delete = ON');
      db.exec(SCHEMA_DDL);
      const setMeta = db.prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?)');
      setMeta.run('schema_version', SCHEMA_VERSION);
      setMeta.run('vault_id', uuidv4(platform.crypto));
      setMeta.run('chain_head', GENESIS_HASH);
      setMeta.run('created_at', new Date().toISOString());
      const vault = new Vault(options.path, db, key, salt, kdf, platform);
      vault.save();
      return vault;
    } catch (err) {
      db?.close();
      memzero(key, platform.crypto);
      throw err;
    }
  }

  /** Parses and bounds-checks the plaintext header without decrypting anything. */
  static readHeader(vaultPath: string, platform: Platform = getPlatform()): VaultHeader {
    let file: Buffer;
    try {
      file = platform.storage.readBytes(vaultPath);
    } catch {
      throw new Error(`No vault found at ${vaultPath}. Run "northkeep init" first.`);
    }
    // Buffer.compare (static) instead of subarray().equals(): on Hermes the
    // Buffer polyfill's subarray returns a plain Uint8Array (no Symbol.species),
    // which has no .equals. Buffer.compare accepts Uint8Array; identical on Node.
    if (file.length < HEADER_LENGTH || Buffer.compare(file.subarray(0, MAGIC.length), MAGIC) !== 0) {
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
    const platform = options.platform ?? getPlatform();
    const header = Vault.readHeader(options.path, platform);
    const key = deriveMasterKey(
      options.passphrase,
      options.deviceSecret,
      header.salt,
      header.kdf,
      platform.crypto,
    );
    return Vault.openDecrypting(options.path, key, header, platform);
  }

  /**
   * Opens with an already-derived master key (background/MCP access after
   * `northkeep unlock`). Skips Argon2id entirely. Takes ownership of the key
   * buffer on success AND failure — callers must pass a copy if they reuse it.
   */
  static openWithKey(vaultPath: string, masterKey: Buffer, platform: Platform = getPlatform()): Vault {
    let header: VaultHeader;
    try {
      header = Vault.readHeader(vaultPath, platform);
    } catch (err) {
      memzero(masterKey, platform.crypto); // ownership promise holds even pre-decrypt
      throw err;
    }
    return Vault.openDecrypting(vaultPath, masterKey, header, platform);
  }

  private static openDecrypting(
    vaultPath: string,
    key: Buffer,
    header: VaultHeader,
    platform: Platform,
  ): Vault {
    const file = platform.storage.readBytes(vaultPath);
    const ciphertext = Buffer.from(file.subarray(HEADER_LENGTH));
    let image: Buffer;
    try {
      image = decrypt(ciphertext, key, header.nonce, header.raw, platform.crypto);
    } catch (err) {
      memzero(key, platform.crypto);
      throw err;
    }
    // (The image buffer itself is left to GC — RAM-resident plaintext while
    // unlocked is an accepted, documented limit.)
    let db: SqliteDb | null = null;
    try {
      db = platform.sqlite.openFromImage(image);
      db.pragma('foreign_keys = ON');
      // Zeroize freed pages on delete/overwrite (defense-in-depth for forget()).
      db.pragma('secure_delete = ON');
      const vault = new Vault(vaultPath, db, key, header.salt, header.kdf, platform);
      vault.migrate();
      return vault;
    } catch (err) {
      db?.close();
      memzero(key, platform.crypto);
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
        const hash = computeEntryHash(entry, this.platform.crypto);
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
    const image = this.platform.sqlite.serialize(this.db);
    const header = Buffer.alloc(HEADER_LENGTH);
    MAGIC.copy(header, 0);
    this.salt.copy(header, MAGIC.length);
    header.writeUInt32LE(this.kdf.opslimit, MAGIC.length + SALT_BYTES);
    header.writeUInt32LE(this.kdf.memlimit, MAGIC.length + SALT_BYTES + 4);
    // The nonce lives inside the header, and the header is the AEAD associated
    // data — so the nonce must be in place before encrypting.
    const nonce = randomBytes(NONCE_BYTES, this.platform.crypto);
    nonce.copy(header, MAGIC.length + SALT_BYTES + 8);
    const ciphertext = encryptWithNonce(image, this.key, nonce, header, this.platform.crypto);
    // Atomic replace (temp + fsync + rename + .bak) lives behind the storage seam.
    this.platform.storage.writeAtomic(this.path, Buffer.concat([header, ciphertext]));
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
      id: uuidv4(this.platform.crypto),
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
    entry.entry_hash = computeEntryHash(entry, this.platform.crypto);

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
   * Re-scopes a memory by supersession. `scope` is part of an entry's hash and
   * the vault is an append-only ledger, so we never mutate the original in
   * place — that would rewrite history and break the chain. Instead we append a
   * new entry in the new scope and mark the original `superseded_by` it. The
   * move is preserved, not erased: the old entry lingers as history (visible in
   * export and verifyChain), and only the new one appears in list/retrieve.
   * Accepts a full id or an unambiguous prefix; returns the new live entry.
   * No-op (returns the original) if it is already in the target scope.
   */
  rescope(idOrPrefix: string, newScope: string, allowedScopes?: string[]): MemoryEntry {
    this.assertOpen();
    const scope = newScope.trim();
    if (scope.length === 0) throw new Error('New scope must not be empty.');
    // Capability: a scoped connection cannot move a memory into a scope outside
    // its grant (that would carry it past the allowlist). resolveEditable
    // enforces the read side — it can only touch entries it can see.
    if (allowedScopes !== undefined && !allowedScopes.includes(scope)) {
      throw new Error(`Scope "${scope}" is outside this connection's grant.`);
    }
    const old = this.resolveEditable(idOrPrefix, allowedScopes);
    if (old.scope === scope) return old; // already there — nothing to do
    return this.supersedeEntry(old, { scope });
  }

  /**
   * Edits a memory's content, scope, and/or type by supersession — the same
   * append-only mechanism as rescope. Nothing is mutated in place: the original
   * is kept as superseded history and the provenance chain stays valid (see
   * ADR 0015). Provide only the fields to change. Returns the new live entry, or
   * the original unchanged if the patch is a no-op. Accepts a full id or an
   * unambiguous prefix.
   */
  editMemory(
    idOrPrefix: string,
    patch: { content?: string; scope?: string; type?: MemoryType },
    allowedScopes?: string[],
  ): MemoryEntry {
    this.assertOpen();
    const changes: { content?: string; scope?: string; type?: MemoryType } = {};
    if (patch.content !== undefined) {
      if (patch.content.trim().length === 0) throw new Error('Memory content must not be empty.');
      changes.content = patch.content;
    }
    if (patch.scope !== undefined) {
      const s = patch.scope.trim();
      if (s.length === 0) throw new Error('Scope must not be empty.');
      // Same capability guard as rescope: can't move into an ungranted scope.
      if (allowedScopes !== undefined && !allowedScopes.includes(s)) {
        throw new Error(`Scope "${s}" is outside this connection's grant.`);
      }
      changes.scope = s;
    }
    if (patch.type !== undefined) {
      if (!isMemoryType(patch.type)) {
        throw new Error(
          `Invalid memory type "${patch.type}". Must be one of: ${MEMORY_TYPES.join(', ')}.`,
        );
      }
      changes.type = patch.type;
    }
    if (changes.content === undefined && changes.scope === undefined && changes.type === undefined) {
      throw new Error('Provide at least one of content, scope, or type to edit.');
    }
    const old = this.resolveEditable(idOrPrefix, allowedScopes);
    const wouldChange =
      (changes.content !== undefined && changes.content !== old.content) ||
      (changes.scope !== undefined && changes.scope !== old.scope) ||
      (changes.type !== undefined && changes.type !== old.type);
    if (!wouldChange) return old; // nothing actually differs
    return this.supersedeEntry(old, changes);
  }

  /**
   * Resolves the single live, non-superseded entry named by a full id or an
   * unambiguous prefix, honoring the read-side scope allowlist. Same id guards
   * as forget(). Shared by the supersede-based edits (rescope, editMemory).
   */
  private resolveEditable(idOrPrefix: string, allowedScopes?: string[]): MemoryEntry {
    const prefix = idOrPrefix.trim();
    if (prefix.length < 4) {
      throw new Error('Provide at least 4 characters of the memory id.');
    }
    if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) {
      throw new Error('Memory ids contain only hex characters and dashes.');
    }
    let sql =
      "SELECT * FROM memories WHERE id LIKE ? || '%' AND forgotten_at IS NULL AND superseded_at IS NULL";
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
    return rowToEntry(matches[0]!);
  }

  /**
   * Appends a replacement for `old` with `patch` applied and marks the original
   * superseded_by it — the append-only edit primitive. The chain stays valid
   * because superseded_* are excluded from the hash (like forgotten_at). Both
   * writes run in one transaction so a crash can't leave two live copies.
   */
  private supersedeEntry(
    old: MemoryEntry,
    patch: { content?: string; scope?: string; type?: MemoryType },
  ): MemoryEntry {
    const now = new Date().toISOString();
    const next: MemoryEntry = {
      id: uuidv4(this.platform.crypto),
      type: patch.type ?? old.type,
      content: patch.content ?? old.content,
      scope: patch.scope ?? old.scope,
      source: old.source,
      source_model: old.source_model,
      confidence: old.confidence,
      created_at: now,
      valid_from: old.valid_from,
      superseded_at: null,
      superseded_by: null,
      forgotten_at: null,
      prev_hash: this.getMeta('chain_head'),
      entry_hash: '',
      metadata:
        old.metadata == null
          ? null
          : (JSON.parse(JSON.stringify(old.metadata)) as Record<string, unknown>),
    };
    next.entry_hash = computeEntryHash(next, this.platform.crypto);

    const insert = this.db.prepare(
      `INSERT INTO memories
         (id, type, content, scope, source, source_model, confidence, created_at,
          valid_from, superseded_at, superseded_by, forgotten_at, prev_hash, entry_hash, metadata)
         VALUES (@id, @type, @content, @scope, @source, @source_model, @confidence,
                 @created_at, @valid_from, @superseded_at, @superseded_by, @forgotten_at,
                 @prev_hash, @entry_hash, @metadata)`,
    );
    const markSuperseded = this.db.prepare(
      'UPDATE memories SET superseded_at = ?, superseded_by = ? WHERE id = ?',
    );
    this.db.transaction(() => {
      insert.run({
        ...next,
        metadata: next.metadata === null ? null : JSON.stringify(next.metadata),
      });
      this.setMeta('chain_head', next.entry_hash);
      markSuperseded.run(now, next.id, old.id);
    })();
    return next;
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

  /**
   * Semantic retrieval: ranks by *meaning* using local embeddings, blended with
   * the same keyword/recency/type signal as retrieve(). Additive and
   * graceful-degrading — if `embedder` is unreachable (or the query can't be
   * embedded) it returns the exact keyword result and reports mode 'keyword'
   * with semanticAvailable=false, so a caller/UI can say "semantic unavailable
   * — using keyword" (invariant #6). NEVER throws out: any embedding failure is
   * caught and downgraded to keyword.
   *
   * This is a separate async method rather than a `semantic` flag on retrieve()
   * because retrieve() is synchronous and part of the stable surface (converse,
   * existing tests) — embedding requires awaiting the loopback Ollama call.
   *
   * Embeddings are DISPOSABLE CACHE (invariant #4): computed lazily, stored in
   * the `embeddings` table, never exported, safe to drop (clearEmbeddingCache)
   * and regenerate. They never touch any entry hash or the provenance chain.
   */
  async retrieveSemantic(
    query: string,
    embedder: Embedder,
    options: RetrieveOptions = {},
  ): Promise<SemanticRetrieval> {
    this.assertOpen();
    // Always compute the keyword baseline first: it's our guaranteed fallback
    // and never worse than what retrieve() would have returned on its own.
    const keyword = this.retrieve(query, options);
    const queryTerms = tokenize(query);
    if (queryTerms.size === 0) {
      // Empty/token-less query — retrieve() already returns []; nothing to embed.
      return { results: keyword, mode: 'keyword', semanticAvailable: false, reason: 'empty query' };
    }
    let queryVec: Float32Array;
    try {
      const raw = await embedder.embed(query);
      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          results: keyword,
          mode: 'keyword',
          semanticAvailable: false,
          reason: 'embedder returned an empty vector',
        };
      }
      queryVec = Float32Array.from(raw);
    } catch (err) {
      return {
        results: keyword,
        mode: 'keyword',
        semanticAvailable: false,
        reason: `embedder unavailable: ${errText(err)}`,
      };
    }
    try {
      const results = await this.semanticRank(queryTerms, queryVec, embedder, options);
      return { results, mode: 'semantic', semanticAvailable: true };
    } catch (err) {
      // A candidate embedding failed partway through — degrade loudly, don't throw.
      return {
        results: keyword,
        mode: 'keyword',
        semanticAvailable: false,
        reason: `semantic ranking failed: ${errText(err)}`,
      };
    }
  }

  /** Cosine-blended scoring over the candidate set. Assumes the query vector is
   * in hand; may throw if a candidate embedding can't be produced (the caller
   * turns that into a keyword fallback). */
  private async semanticRank(
    queryTerms: Set<string>,
    queryVec: Float32Array,
    embedder: Embedder,
    options: RetrieveOptions,
  ): Promise<ScoredEntry[]> {
    const limit = options.limit ?? 8;
    const candidates = this.list({
      type: options.type,
      scope: options.scope,
      allowedScopes: options.allowedScopes,
    }).filter((entry) => entry.superseded_at === null);
    this.ensureEmbeddingsTable();
    const now = Date.now();
    const dim = queryVec.length;
    const scored: ScoredEntry[] = [];
    for (const entry of candidates) {
      let vec = this.getCachedEmbedding(entry.id, embedder.model, dim);
      if (vec === null) {
        const raw = await embedder.embed(entry.content);
        vec = Float32Array.from(raw);
        this.putCachedEmbedding(entry.id, embedder.model, vec);
      }
      const sem = Math.max(0, cosineSimilarity(queryVec, vec));
      // Keyword component: identical formula to retrieve(), but overlap may be 0
      // (a purely-semantic hit like "car" ~ "vehicle" contributes via `sem`).
      const entryTerms = tokenize(entry.content);
      let matched = 0;
      for (const term of queryTerms) if (entryTerms.has(term)) matched += 1;
      const overlap = matched / queryTerms.size;
      // Relevance gate: keep an entry only if it shares a keyword OR is
      // genuinely close in meaning, so a query that matches nothing doesn't
      // drag in unrelated filler.
      if (overlap === 0 && sem < SEMANTIC_FLOOR) continue;
      const ageDays = Math.max(0, now - Date.parse(entry.created_at)) / 86_400_000;
      const recency = 0.3 * Math.exp(-ageDays / 30);
      const typeBoost = TYPE_PRIORITY[entry.type] ?? 0;
      const score = SEMANTIC_WEIGHT * sem + overlap + recency + typeBoost;
      scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Drops every cached embedding (the entire disposable cache). Safe at any
   * time — the next retrieveSemantic() recreates the table and regenerates
   * vectors on demand. Nothing about the vault's content, hashes, or export
   * changes.
   */
  clearEmbeddingCache(): void {
    this.assertOpen();
    this.db.exec('DROP TABLE IF EXISTS embeddings');
  }

  /** Creates the disposable embeddings cache table if it's missing (e.g. an
   * older vault, or after clearEmbeddingCache). Never part of the durable
   * schema contract — it's cache. */
  private ensureEmbeddingsTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      model     TEXT NOT NULL,
      dims      INTEGER NOT NULL,
      vector    BLOB NOT NULL,
      PRIMARY KEY (memory_id, model)
    )`);
  }

  /** Reads a cached vector for (memory, model), or null on miss / dim mismatch. */
  private getCachedEmbedding(memoryId: string, model: string, expectedDim: number): Float32Array | null {
    const row = this.db
      .prepare('SELECT dims, vector FROM embeddings WHERE memory_id = ? AND model = ?')
      .get(memoryId, model) as { dims: number; vector: Buffer } | undefined;
    if (!row || row.dims !== expectedDim) return null;
    return blobToVector(row.vector);
  }

  /** Caches a vector for (memory, model). Pure cache write — no hash, no chain. */
  private putCachedEmbedding(memoryId: string, model: string, vec: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (memory_id, model, dims, vector) VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector`,
      )
      .run(memoryId, model, vec.length, vectorToBlob(vec));
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
    if (!filter.includeSuperseded) {
      clauses.push('superseded_at IS NULL');
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

  /** Distinct scopes present in the vault (live entries), sorted. Excludes
   * superseded rows so a scope you've moved your last memory out of doesn't
   * linger as a ghost — matches the live-only default of list(). */
  scopes(): string[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        'SELECT DISTINCT scope FROM memories WHERE forgotten_at IS NULL AND superseded_at IS NULL ORDER BY scope',
      )
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
        const expected = computeEntryHash(entry, this.platform.crypto);
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
    const memories: ExportedMemory[] = this.list({
      includeForgotten: true,
      includeSuperseded: true,
    }).map((entry) => ({
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
    memzero(this.key, this.platform.crypto);
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
export function computeEntryHash(entry: MemoryEntry, provider?: CryptoProvider): string {
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
    provider ?? getPlatform().crypto,
  );
}

/**
 * RFC 4122 v4 UUID built from platform random bytes — replaces node:crypto's
 * randomUUID so vault.ts carries no Node dependency (the ids are random; there is
 * no byte-exact contract to preserve, only the v4 shape).
 */
function uuidv4(provider: CryptoProvider): string {
  const b = provider.randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

/** How strongly cosine similarity (0..1) counts relative to the keyword signal.
 * Keyword overlap tops out near 1.0, recency at 0.3, type at 0.15 — a weight of
 * 0.7 lets meaning meaningfully re-rank without steamrolling exact matches. */
const SEMANTIC_WEIGHT = 0.7;
/** Minimum cosine for a keyword-less entry to survive as a semantic-only hit. */
const SEMANTIC_FLOOR = 0.6;

/** Cosine similarity of two vectors; 0 on length mismatch or a zero vector. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Pack a Float32Array as a little-endian BLOB for the cache table. */
function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a cache BLOB into a Float32Array, copying to guarantee 4-byte
 * alignment (SQLite BLOBs come back as pooled Buffers with arbitrary offsets). */
function blobToVector(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().normalize('NFC').matchAll(/[a-z0-9]{2,}/g)) {
    terms.add(match[0]);
  }
  return terms;
}
