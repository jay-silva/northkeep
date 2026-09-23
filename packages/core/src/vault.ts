import { canonicalJson } from './canonical.js';
import {
  CONSOLIDATION_CONTENT_MAX_CHARS,
  CONSOLIDATION_METADATA_KEY,
  CONSOLIDATION_METADATA_VERSION,
  CONSOLIDATION_REQUEST_MAX_BYTES,
  exactCanonicalJson,
  type ConsolidationHistoryItem,
  type ConsolidationRequest,
  type ConsolidationResult,
  type RestoreConsolidationRequest,
} from './consolidation.js';
import {
  KDF_MODERATE,
  NONCE_BYTES,
  SALT_BYTES,
  VaultAuthError,
  VaultSchemaError,
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
import {
  PROJECT_HANDOFF_METADATA_KEY,
  PROJECT_HANDOFF_METADATA_VERSION,
  PROJECT_IMPORT_SOURCE,
  PROJECT_PROVENANCE_METADATA_KEY,
  ProjectHandoffError,
  applyProjectUpdate,
  getProjectView,
  projectProvenanceBlock,
  readProjectHandoffMetadata,
  readProjectProvenance,
  validateProjectWriter,
  type ProjectCheckpointRequest,
  type ProjectCheckpointResult,
  type ProjectHandoffMetadata,
  type ProjectUpdateRequest,
  type ProjectView,
} from './project-handoff.js';
import { emptyProjectDoc, formatLogArchive, parseProjectSlug, projectScope, serializeProjectDoc } from './project-doc.js';
import { importPlanProblem, projectInUseMessage, type ImportFilePlan } from './project-import.js';
import type { SqliteDb } from './sqlite-driver.js';
import { SCHEMA_DDL } from './schema.js';
import {
  GENESIS_HASH,
  MEMORY_TYPES,
  SCHEMA_VERSION,
  VaultSyncGenerationError,
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

interface ConsolidationMetadata {
  version: number;
  kind: 'consolidate';
  operation_id: string;
  request_hash: string;
  result_id: string;
  source_ids: string[];
  source_hashes: string[];
  source_snapshot_hashes: string[];
}

interface RestoreMetadata {
  version: number;
  kind: 'restore';
  operation_id: string;
  request_hash: string;
  result_id: string;
  consolidation_result_id: string;
  original_id: string;
  source_ids: string[];
  restored_ids: string[];
  original_metadata: Record<string, unknown> | null;
}

type CurationMetadata = ConsolidationMetadata | RestoreMetadata;

/**
 * After-save hook (ADR 0044). A host process that wants to react to vault
 * writes (the automatic push in @northkeep/sync) registers here once; every
 * successful save() in this process then calls it with the vault path. Purely
 * in-process: another process writing the same file does not fire it. Listener
 * errors are swallowed so a misbehaving observer can never fail a save.
 */
export type VaultSaveListener = (vaultPath: string) => void;
const saveListeners = new Set<VaultSaveListener>();

/** Register a save listener; returns the unsubscribe function. */
export function onVaultSave(listener: VaultSaveListener): () => void {
  saveListeners.add(listener);
  return () => {
    saveListeners.delete(listener);
  };
}

/** Superseded project revisions kept per scope by default (ADR 0051). */
export const PROJECT_COMPACT_DEFAULT_KEEP = 5;
export const PROJECT_COMPACT_MAX_KEEP = 1000;

export interface ProjectCompaction {
  project: string;
  /** Superseded, not-yet-forgotten revisions considered in this scope. */
  candidates: number;
  kept: number;
  blanked: number;
  bytes_freed: number;
}

export interface ProjectCompactionResult {
  projects: ProjectCompaction[];
  blanked: number;
  bytes_freed: number;
}

/** What the last write compacted automatically (ADR 0051 Decision 4). */
export interface AutoCompaction {
  project: string;
  blanked: number;
  bytes_freed: number;
}

export class Vault {
  private db: SqliteDb;
  private key: Buffer;
  private readonly salt: Buffer;
  private readonly kdf: KdfParams;
  private readonly platform: Platform;
  readonly path: string;
  private closed = false;
  private autoCompaction: AutoCompaction | null = null;

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
      setMeta.run('sync_generation', '0');
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

  /**
   * In-place schema upgrades for vaults created by older releases. Steps apply
   * SEQUENTIALLY — a 0.1 vault walks 0.1 → 0.2 → 0.3 → 0.4 in one open — and each
   * step stamps its version before the single save() at the end, so a
   * mid-migration crash re-runs from the last stamped version on next open.
   */
  private migrate(): void {
    let version = this.getMeta('schema_version');
    if (version === SCHEMA_VERSION) return;
    const from = version;
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
      version = '0.2';
    }
    if (version === '0.2') {
      // 0.2 → 0.3: per-scope sharing state (ADR 0038). The table is created
      // EMPTY — migration must never mark anything shared; existing sidecar
      // shares are folded in explicitly by @northkeep/sync, not here.
      this.db.exec(`CREATE TABLE IF NOT EXISTS scopes (
        scope     TEXT PRIMARY KEY,
        shared    INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
        shared_at TEXT
      )`);
      this.setMeta('schema_version', '0.3');
      version = '0.3';
    }
    if (version === '0.3') {
      // 0.3 → 0.4: seal a monotonic sync_generation inside the vault (ADR 0038
      // addendum). Seed 0 if missing. Never increment here or in save().
      if (this.getMetaOptional('sync_generation') === undefined) {
        this.setMeta('sync_generation', '0');
      }
      this.setMeta('schema_version', '0.4');
      version = '0.4';
    }
    if (version !== SCHEMA_VERSION) {
      throw new VaultSchemaError(
        `Vault schema ${version} is newer than this build understands (${SCHEMA_VERSION}). Update NorthKeep.`,
      );
    }
    this.save();
    console.error(`northkeep: migrated vault schema ${from} → ${SCHEMA_VERSION}`);
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
    for (const listener of saveListeners) {
      try {
        listener(this.path);
      } catch {
        // An observer must never turn a completed save into a failure.
      }
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

  /** Atomic revision-bound project update used by the legacy local project tool. */
  updateProject(request: ProjectUpdateRequest, allowedScopes?: string[]): ProjectView {
    this.assertOpen();
    return this.writeProject(request, allowedScopes, null).current;
  }

  /**
   * True when project:<slug> holds any unforgotten row, superseded ones
   * included. Import refuses on this, not on the working document alone, so
   * archives left behind by a forgotten document are never duplicated.
   */
  projectScopeInUse(slug: string): boolean {
    this.assertOpen();
    let scope: string;
    try { scope = projectScope(slug); } catch { throw new ProjectHandoffError('invalid_request', 'Project slug is invalid.'); }
    return this.db.prepare('SELECT 1 FROM memories WHERE scope = ? AND forgotten_at IS NULL LIMIT 1').get(scope) !== undefined;
  }

  /**
   * ADR 0053 Decision 10's write, one transaction. Never merges, so a slug
   * with any entries is refused. No provenance block: import is not a host
   * write. Archives go first so rowid order matches. Caller saves.
   */
  importProject(plan: ImportFilePlan, allowedScopes?: string[]): ProjectView {
    this.assertOpen();
    const problem = importPlanProblem(plan);
    if (problem !== null) throw new ProjectHandoffError('invalid_request', problem);
    const scope = projectScope(plan.slug);
    if (allowedScopes !== undefined && !allowedScopes.includes(scope)) throw new ProjectHandoffError('scope_denied', 'Project scope is outside this connection grant.');
    this.db.transaction(() => {
      if (this.projectScopeInUse(plan.slug)) {
        throw new ProjectHandoffError('stale_project', projectInUseMessage(plan.slug));
      }
      const now = new Date().toISOString();
      const insert = this.prepareEntryInsert();
      let chain = this.getMeta('chain_head');
      const rows: Array<[MemoryType, string, string]> = [
        ...plan.archives.map((content) => ['episodic', content, 'northkeep:project-log-archive'] as [MemoryType, string, string]),
        ...plan.overflow_parts.map((content) => ['episodic', content, 'northkeep:project-import-overflow'] as [MemoryType, string, string]),
        ['working', plan.document, PROJECT_IMPORT_SOURCE],
      ];
      for (const [type, content, source] of rows) {
        const entry = this.makeProjectEntry(type, content, scope, source, null, chain, now);
        insert.run(this.entryParams(entry));
        chain = entry.entry_hash;
      }
      this.setMeta('chain_head', chain);
    })();
    return getProjectView(this, plan.slug, allowedScopes, { history: true });
  }

  /**
   * Forgets every entry in a project's scope: the live document, its earlier
   * revisions, log archives and handoff receipts. Same tombstone semantics as
   * forget() per entry (content blanked, chain intact), inside one transaction.
   * The caller persists with one save(). Returns the number of entries forgotten.
   */
  deleteProject(project: string, allowedScopes?: string[]): number {
    this.assertOpen();
    let scope: string;
    try { scope = projectScope(project); } catch { throw new ProjectHandoffError('invalid_request', 'Project slug is invalid.'); }
    if (allowedScopes !== undefined && !allowedScopes.includes(scope)) throw new ProjectHandoffError('scope_denied', 'Project scope is outside this connection grant.');
    let count = 0;
    this.db.transaction(() => {
      const entries = this.list({ scope, includeSuperseded: true, allowedScopes });
      // Archives or overflow left after the document was forgotten still block import, so they must be deletable.
      if (!entries.some((e) => !e.forgotten_at)) throw new ProjectHandoffError('not_found', 'Project was not found.');
      for (const entry of entries) {
        if (entry.forgotten_at) continue;
        this.forget(entry.id, allowedScopes);
        count += 1;
      }
    })();
    return count;
  }

  /**
   * Blanks old superseded project revisions (ADR 0051 Decision 1). Candidates
   * are `working` rows in slug-valid project scopes that are superseded and not
   * already forgotten; the newest `keep` per scope stay, as does any revision a
   * handoff receipt in that scope still names, so replay and lineage keep
   * working. Blanking uses the same tombstone UPDATE as forget(), so the hash
   * chain and the export stay valid. VACUUM releases the freed pages, without
   * which the next save() would re-serialize them. The caller persists with one
   * save().
   */
  compactProjectHistory(options: { project?: string; keep?: number; dryRun?: boolean } = {}): ProjectCompactionResult {
    this.assertOpen();
    const keep = options.keep ?? PROJECT_COMPACT_DEFAULT_KEEP;
    if (!Number.isInteger(keep) || keep < 1 || keep > PROJECT_COMPACT_MAX_KEEP) {
      throw new Error(`Keep must be a whole number between 1 and ${PROJECT_COMPACT_MAX_KEEP}.`);
    }
    const only = options.project === undefined ? null : projectScope(options.project);
    const scopes = (this.db
      .prepare("SELECT DISTINCT scope FROM memories WHERE scope LIKE 'project:%' ORDER BY scope")
      .all() as Array<{ scope: string }>)
      .map((row) => row.scope)
      .filter((scope) => parseProjectSlug(scope) !== null && (only === null || scope === only));
    if (only !== null && !scopes.includes(only)) scopes.push(only);

    const projects: ProjectCompaction[] = [];
    const doomed: string[] = [];
    for (const scope of scopes) {
      const plan = this.planScopeCompaction(scope, keep);
      doomed.push(...plan.ids);
      projects.push({
        project: parseProjectSlug(scope)!,
        candidates: plan.candidates,
        kept: plan.candidates - plan.ids.length,
        blanked: plan.ids.length,
        bytes_freed: plan.bytes,
      });
    }
    const result: ProjectCompactionResult = {
      projects,
      blanked: doomed.length,
      bytes_freed: projects.reduce((sum, p) => sum + p.bytes_freed, 0),
    };
    if (options.dryRun === true || doomed.length === 0) return result;

    // Check the chain BEFORE mutating: a vault that was already broken must
    // say so and keep its rows, so the post-VACUUM check below is meaningful.
    const before = this.verifyChain();
    if (!before.ok) throw new Error(`Nothing was compacted: this vault's chain does not verify (${before.error}).`);

    const forgottenAt = new Date().toISOString();
    this.db.transaction(() => {
      this.blankRevisions(doomed, forgottenAt);
    })();
    // VACUUM rebuilds the image so serialize() drops the freed pages. It cannot
    // run inside a transaction, hence after it.
    this.db.exec('VACUUM');
    const chain = this.verifyChain();
    if (!chain.ok) throw new Error(`Compaction was abandoned unsaved because the vault chain no longer verifies: ${chain.error}`);
    return result;
  }

  /**
   * Picks the superseded project revisions this scope may lose: everything past
   * the newest `keep`, minus any a handoff receipt still names. Pure selection,
   * so both the manual operation and the automatic path share one rule.
   */
  private planScopeCompaction(scope: string, keep: number): { ids: string[]; bytes: number; candidates: number } {
    const candidates = this.db
      .prepare(
        "SELECT id, content FROM memories WHERE scope = ? AND type = 'working' " +
          'AND superseded_at IS NOT NULL AND forgotten_at IS NULL ORDER BY created_at DESC, rowid DESC',
      )
      .all(scope) as Array<{ id: string; content: string }>;
    const referenced = this.receiptReferences(scope);
    const blanking = candidates.slice(keep).filter((row) => !referenced.has(row.id));
    let bytes = 0;
    for (const row of blanking) bytes += Buffer.byteLength(row.content, 'utf8');
    return { ids: blanking.map((row) => row.id), bytes, candidates: candidates.length };
  }

  /**
   * Tombstones the named rows the way forget() does, with one exception: the
   * writer block survives the text. Who wrote a revision is the record ADR 0052
   * publishes, and compacting history must not silently delete it. Every other
   * key, the handoff receipt included, still goes. Runs in the caller's
   * transaction.
   */
  private blankRevisions(ids: string[], forgottenAt: string): void {
    const read = this.db.prepare('SELECT metadata FROM memories WHERE id = ?');
    const blank = this.db.prepare("UPDATE memories SET content = '', metadata = ?, forgotten_at = ? WHERE id = ?");
    for (const id of ids) {
      const row = read.get(id) as { metadata: string | null } | undefined;
      blank.run(keptProvenanceMetadata(row?.metadata ?? null), forgottenAt, id);
    }
  }

  /**
   * ADR 0051 Decision 4: history stays bounded at every write. Runs inside the
   * caller's transaction, and deliberately skips verifyChain, which is too slow
   * for a write path; the manual operation keeps those checks.
   */
  private autoCompactScope(scope: string): AutoCompaction | null {
    const project = parseProjectSlug(scope);
    if (project === null) return null;
    const plan = this.planScopeCompaction(scope, PROJECT_COMPACT_DEFAULT_KEEP);
    if (plan.ids.length === 0) return null;
    this.blankRevisions(plan.ids, new Date().toISOString());
    return { project, blanked: plan.ids.length, bytes_freed: plan.bytes };
  }

  /**
   * Publishes what was blanked, once the supersession has actually committed, and
   * reclaims the pages. A rolled-back write never reaches here, so the report can
   * never name rows that still hold content.
   */
  private finishAutoCompaction(report: AutoCompaction | null): void {
    if (report === null) return;
    this.autoCompaction = report;
    if (this.db.inTransaction !== true) this.db.exec('VACUUM');
  }

  /** What the last write compacted automatically, or null if it compacted nothing. */
  lastAutoCompaction(): AutoCompaction | null {
    return this.autoCompaction;
  }

  /** Revision ids a handoff receipt in this scope still names (base, result, archives). */
  private receiptReferences(scope: string): Set<string> {
    const referenced = new Set<string>();
    const rows = this.db
      .prepare('SELECT metadata FROM memories WHERE scope = ? AND metadata IS NOT NULL')
      .all(scope) as Array<{ metadata: string }>;
    for (const row of rows) {
      let meta: unknown;
      try { meta = JSON.parse(row.metadata); } catch { continue; }
      if (!meta || typeof meta !== 'object') continue;
      const receipt = (meta as Record<string, unknown>)[PROJECT_HANDOFF_METADATA_KEY];
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue;
      const fields = receipt as Record<string, unknown>;
      for (const key of ['base_revision', 'result_id']) {
        if (typeof fields[key] === 'string') referenced.add(fields[key] as string);
      }
      if (Array.isArray(fields.archive_ids)) {
        for (const id of fields.archive_ids) if (typeof id === 'string') referenced.add(id);
      }
    }
    return referenced;
  }

  /** Atomic, idempotent checkpoint/wrap mutation. The caller persists with one save(). */
  checkpointProject(request: ProjectCheckpointRequest, allowedScopes?: string[]): ProjectCheckpointResult {
    this.assertOpen();
    let scope:string;try{scope=projectScope(request.project);}catch{throw new ProjectHandoffError('invalid_request','Project slug is invalid.');}
    if(allowedScopes!==undefined&&!allowedScopes.includes(scope))throw new ProjectHandoffError('scope_denied','Project scope is outside this connection grant.');
    if (request.vault_id !== this.getVaultId()) throw new ProjectHandoffError('invalid_request', 'Vault id does not match this vault.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.operation_id)) throw new ProjectHandoffError('invalid_request', 'Operation id must be a lowercase RFC 4122 UUID.');
    if (request.mode !== 'checkpoint' && request.mode !== 'wrap') throw new ProjectHandoffError('invalid_request', 'Invalid project handoff mode.');
    if (typeof request.expected_revision !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.expected_revision) || typeof request.status !== 'string' || typeof request.completed !== 'string' || typeof request.next_actions !== 'string') throw new ProjectHandoffError('invalid_request','Checkpoint requires a valid revision, status, completed work, and next actions.');
    if(request.writer!==undefined)validateProjectWriter(request.writer);
    if(request.completed.trim().length===0||/[\r]/.test(request.completed)||/^\n|\n$/.test(request.completed)||/^( {0,3})#{1,6}[ \t]+\S/m.test(request.completed))throw new ProjectHandoffError('invalid_request','Completed work is invalid.');
    const logical = {
      vault_id: request.vault_id, project: request.project, mode: request.mode,
      expected_revision: request.expected_revision, status: request.status, completed: request.completed,
      next_actions: request.next_actions,
      ...(request.decision !== undefined ? { decision: request.decision } : {}),
      ...(request.open_questions !== undefined ? { open_questions: request.open_questions } : {}),
      ...(request.files !== undefined ? { files: request.files } : {}),
    };
    const fingerprint = blake2bHex(exactCanonicalJson(logical), this.platform.crypto);
    // draft:false is derived from the mode, so replay rebuilds the same content.
    const update:ProjectUpdateRequest={project:request.project,expected_revision:request.expected_revision,status:request.status,next_actions:request.next_actions,log_entry:`${request.mode==='checkpoint'?'Checkpoint':'Wrap up'}: ${request.completed}`,...(request.decision!==undefined?{decision:request.decision}:{}),...(request.open_questions!==undefined?{open_questions:request.open_questions}:{}),...(request.files!==undefined?{files:request.files}:{}),...(request.mode==='wrap'?{draft:false}:{}),...(request.writer!==undefined?{writer:request.writer}:{})};
    const matches: Array<{entry:MemoryEntry;meta:ProjectHandoffMetadata}> = []; const copied:Array<{entry:MemoryEntry;raw:Record<string,unknown>}>=[];
    for (const entry of this.list({ includeForgotten:true, includeSuperseded:true, allowedScopes })) {
      const raw=entry.metadata?.[PROJECT_HANDOFF_METADATA_KEY];
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||(raw as Record<string,unknown>).operation_id!==request.operation_id)continue;
      if((raw as Record<string,unknown>).result_id!==entry.id){copied.push({entry,raw:raw as Record<string,unknown>});continue;}
      let meta:ProjectHandoffMetadata|null;
      try { meta=readProjectHandoffMetadata(entry); } catch { throw new ProjectHandoffError('operation_conflict','Malformed or copied project handoff receipt.'); }
      if(meta?.operation_id===request.operation_id)matches.push({entry,meta});
    }
    if(!matches.length&&copied.length)throw new ProjectHandoffError('operation_conflict','Operation receipt metadata exists without its original result.');
    if (matches.length) {
      if (matches.length!==1) throw new ProjectHandoffError('operation_conflict','Ambiguous project handoff operation.');
      const {entry,meta}=matches[0]!;
      for(const copy of copied){let cursor=entry;const seen=new Set<string>();while(cursor.id!==copy.entry.id&&cursor.superseded_by){if(seen.has(cursor.id))break;seen.add(cursor.id);const next=this.getEntry(cursor.superseded_by);if(!next)break;cursor=next;}if(cursor.id!==copy.entry.id||copy.entry.scope!==entry.scope||exactCanonicalJson(copy.raw)!==exactCanonicalJson(meta))throw new ProjectHandoffError('operation_conflict','Unrelated copied project handoff receipt metadata was found.');}
      if(meta.result_id!==entry.id||meta.project!==request.project||meta.base_revision!==request.expected_revision||meta.mode!==request.mode||meta.request_fingerprint!==fingerprint)throw new ProjectHandoffError('operation_conflict','Operation id was already used for a different project request.');
      if(entry.scope!==scope||entry.type!=='working'||entry.source!=='northkeep:project-handoff'||entry.forgotten_at!==null||entry.created_at!==meta.saved_at||computeEntryHash(entry,this.platform.crypto)!==entry.entry_hash)throw new ProjectHandoffError('operation_conflict','Persisted project handoff result is invalid.');
      const base=this.getEntry(meta.base_revision);if(!base||base.scope!==scope||base.superseded_by!==entry.id||base.superseded_at!==entry.created_at)throw new ProjectHandoffError('operation_conflict','Persisted project handoff lineage is invalid.');
      const expected=applyProjectUpdate(base.content,update,new Date(meta.saved_at));
      if(entry.content!==expected.content||new Set(meta.archive_ids).size!==meta.archive_ids.length||meta.archive_ids.length!==(expected.archives.length?1:0))throw new ProjectHandoffError('operation_conflict','Persisted project handoff content does not match its request.');
      for(const id of meta.archive_ids){const archive=this.getEntry(id);const expectedContent=formatLogArchive(request.project,expected.archives,new Date(meta.saved_at));if(!archive||archive.scope!==scope||archive.type!=='episodic'||archive.source!=='northkeep:project-log-archive'||archive.created_at!==meta.saved_at||archive.content!==expectedContent||computeEntryHash(archive,this.platform.crypto)!==archive.entry_hash)throw new ProjectHandoffError('operation_conflict','Project handoff receipt archive is invalid.');}
      const receipt={operation_id:meta.operation_id,project:meta.project,mode:meta.mode,base_revision:meta.base_revision,result_revision:meta.result_id,request_fingerprint:meta.request_fingerprint,archive_ids:[...meta.archive_ids],saved_at:meta.saved_at,local_only:true as const};
      return {receipt,current:getProjectView(this,request.project,allowedScopes),replayed:true};
    }
    return this.writeProject(update,allowedScopes,{operation_id:request.operation_id,mode:request.mode,fingerprint});
  }

  private writeProject(request:ProjectUpdateRequest,allowedScopes:string[]|undefined,handoff:{operation_id:string;mode:'checkpoint'|'wrap';fingerprint:string}|null):ProjectCheckpointResult {
    let scope:string;try{scope=projectScope(request.project);}catch{throw new ProjectHandoffError('invalid_request','Project slug is invalid.');}
    if(allowedScopes!==undefined&&!allowedScopes.includes(scope))throw new ProjectHandoffError('scope_denied','Project scope is outside this connection grant.');
    if(!Object.hasOwn(request,'expected_revision')||(request.expected_revision!==null&&(typeof request.expected_revision!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.expected_revision))))throw new ProjectHandoffError('invalid_request','expected_revision must be an exact revision UUID or null for creation.');
    if(request.writer!==undefined)validateProjectWriter(request.writer);
    const updateKeys=['what_why','status','next_actions','decision','log_entry','open_questions','files','title','draft'] as const;
    if(!updateKeys.some((key)=>request[key]!==undefined))throw new ProjectHandoffError('invalid_request','Project update has no changes.');
    let receipt!:ProjectCheckpointResult['receipt'];
    let auto:AutoCompaction|null=null;
    this.autoCompaction=null;
    this.db.transaction(()=>{
      const heads=this.list({type:'working',scope,allowedScopes});
      if(heads.length>1)throw new ProjectHandoffError('project_conflict','Project has multiple current documents.');
      const old=heads[0]??null;
      if(!old&&request.expected_revision!==null)throw new ProjectHandoffError('not_found','Project was not found.');
      if(old&&request.expected_revision!==old.id){let current:ProjectView|undefined;try{current=getProjectView(this,request.project,allowedScopes);}catch{}throw new ProjectHandoffError('stale_project','Project changed after it was read.',current);}
      if(!old&&request.expected_revision!==null)throw new ProjectHandoffError('stale_project','Project revision is stale.');
      const base=old?.content??serializeProjectDoc(emptyProjectDoc()); const merged=applyProjectUpdate(base,request); const now=new Date().toISOString();
      const insert=this.prepareEntryInsert(); const archiveIds:string[]=[]; let chain=this.getMeta('chain_head');
      if(merged.archives.length){const archive=this.makeProjectEntry('episodic',formatLogArchive(request.project,merged.archives,new Date(now)),scope,'northkeep:project-log-archive',null,chain,now);insert.run(this.entryParams(archive));chain=archive.entry_hash;archiveIds.push(archive.id);}
      const resultId=uuidv4(this.platform.crypto);
      // Both reserved blocks are rebuilt from this write, never inherited.
      const built:Record<string,unknown>=old?.metadata?JSON.parse(JSON.stringify(old.metadata)) as Record<string,unknown>:{};
      delete built[PROJECT_HANDOFF_METADATA_KEY];delete built[PROJECT_PROVENANCE_METADATA_KEY];
      if(handoff)built[PROJECT_HANDOFF_METADATA_KEY]={version:PROJECT_HANDOFF_METADATA_VERSION,operation_id:handoff.operation_id,result_id:resultId,project:request.project,base_revision:request.expected_revision as string,mode:handoff.mode,request_fingerprint:handoff.fingerprint,archive_ids:archiveIds,saved_at:now};
      if(request.writer!==undefined)built[PROJECT_PROVENANCE_METADATA_KEY]=projectProvenanceBlock(request.writer,now);
      const meta:Record<string,unknown>|null=Object.keys(built).length===0?null:built;
      const head=this.makeProjectEntry('working',merged.content,scope,handoff?'northkeep:project-handoff':'northkeep:project-update',meta,chain,now,resultId);insert.run(this.entryParams(head));
      if(old){const changed=this.db.prepare('UPDATE memories SET superseded_at=?, superseded_by=? WHERE id=? AND forgotten_at IS NULL AND superseded_at IS NULL').run(now,head.id,old.id).changes;if(changed!==1)throw new ProjectHandoffError('stale_project','Project changed before the update could be applied.');}
      if(old)auto=this.autoCompactScope(scope);
      this.setMeta('chain_head',head.entry_hash);
      receipt={operation_id:handoff?.operation_id??'',project:request.project,mode:handoff?.mode??'checkpoint',base_revision:request.expected_revision??'',result_revision:head.id,request_fingerprint:handoff?.fingerprint??'',archive_ids:archiveIds,saved_at:now,local_only:true};
    })();
    this.finishAutoCompaction(auto);
    return {receipt,current:getProjectView(this,request.project,allowedScopes),replayed:false};
  }

  private makeProjectEntry(type:MemoryType,content:string,scope:string,source:string,metadata:Record<string,unknown>|null,prevHash:string,now:string,id=uuidv4(this.platform.crypto)):MemoryEntry {
    const entry:MemoryEntry={id,type,content,scope,source,source_model:null,confidence:1,created_at:now,valid_from:now,superseded_at:null,superseded_by:null,forgotten_at:null,prev_hash:prevHash,entry_hash:'',metadata:metadata===null?null:JSON.parse(JSON.stringify(metadata)) as Record<string,unknown>};
    entry.entry_hash=computeEntryHash(entry,this.platform.crypto); return entry;
  }

  /** Atomically replaces 2-8 exact private source snapshots with one linked head. */
  consolidateMemories(request: ConsolidationRequest): ConsolidationResult {
    this.assertOpen();
    const requestHash = this.consolidationRequestHash('consolidate', request);
    const retry = this.findConsolidationOperation(request.operation_id);
    if (retry !== null) {
      if (retry.kind !== 'consolidate' || retry.requestHash !== requestHash) {
        throw new Error('Operation id was already used for a different consolidation request.');
      }
      return this.validateConsolidationRetry(retry, request);
    }
    this.assertConsolidationRequest(request);

    const now = new Date().toISOString();
    const resultId = uuidv4(this.platform.crypto);
    const result: MemoryEntry = {
      id: resultId,
      type: request.sources[0]!.type,
      content: request.content,
      scope: request.sources[0]!.scope,
      source: 'northkeep:consolidation',
      source_model: null,
      confidence: 1,
      created_at: now,
      valid_from: now,
      superseded_at: null,
      superseded_by: null,
      forgotten_at: null,
      prev_hash: this.getMeta('chain_head'),
      entry_hash: '',
      metadata: {
        [CONSOLIDATION_METADATA_KEY]: {
          version: CONSOLIDATION_METADATA_VERSION,
          kind: 'consolidate',
          operation_id: request.operation_id,
          request_hash: requestHash,
          result_id: resultId,
          source_ids: request.sources.map((source) => source.id),
          source_hashes: request.sources.map((source) => source.entry_hash),
          source_snapshot_hashes: request.sources.map((source) => this.snapshotHash(source)),
        },
      },
    };
    result.entry_hash = computeEntryHash(result, this.platform.crypto);

    const insert = this.prepareEntryInsert();
    const mark = this.db.prepare(
      `UPDATE memories SET superseded_at = ?, superseded_by = ?
       WHERE id = ? AND forgotten_at IS NULL AND superseded_at IS NULL`,
    );
    this.db.transaction(() => {
      this.assertSourcesStillApplicable(request.sources);
      insert.run(this.entryParams(result));
      for (const source of request.sources) {
        if (mark.run(now, result.id, source.id).changes !== 1) {
          throw new Error(`Memory ${source.id} changed before consolidation could be applied.`);
        }
      }
      this.setMeta('chain_head', result.entry_hash);
    })();
    return { operation_id: request.operation_id, kind: 'consolidate', result, sources: request.sources, restored_entries: [] };
  }

  /** Restores complete copies of a consolidation's historical sources atomically. */
  restoreConsolidation(request: RestoreConsolidationRequest): ConsolidationResult {
    this.assertOpen();
    const requestHash = this.consolidationRequestHash('restore', request);
    const retry = this.findConsolidationOperation(request.operation_id);
    if (retry !== null) {
      if (retry.kind !== 'restore' || retry.requestHash !== requestHash) {
        throw new Error('Operation id was already used for a different consolidation request.');
      }
      return this.validateRestoreRetry(retry, request);
    }
    this.assertOperationId(request.operation_id);
    if (request.vault_id !== this.getVaultId()) throw new Error('Vault id does not match this vault.');
    if (request.result_id !== request.expected_result.id) throw new Error('Result id does not match its snapshot.');
    const result = this.getEntry(request.result_id);
    if (!result || exactCanonicalJson(result) !== exactCanonicalJson(request.expected_result)) {
      throw new Error('Consolidated result changed after confirmation.');
    }
    const lineage = this.readConsolidationMetadata(result, 'consolidate');
    if (lineage.result_id !== result.id || result.forgotten_at !== null || result.superseded_at !== null) {
      throw new Error('Consolidated result is not an unrestored operation head.');
    }
    if (this.isScopeShared(result.scope) || result.scope.startsWith('project:')) {
      throw new Error('Consolidation restore requires a private, non-project scope.');
    }
    const sources = this.validatePersistedConsolidation(result, lineage).storedSources;
    const now = new Date().toISOString();
    const restoredIds = sources.map(() => uuidv4(this.platform.crypto));
    const restored: MemoryEntry[] = [];
    let previous = this.getMeta('chain_head');
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const id = restoredIds[index]!;
      const entry: MemoryEntry = {
        id,
        type: source.type,
        content: source.content,
        scope: source.scope,
        source: 'northkeep:consolidation-recovery',
        source_model: source.source_model,
        confidence: source.confidence,
        created_at: now,
        valid_from: source.valid_from,
        superseded_at: null,
        superseded_by: null,
        forgotten_at: null,
        prev_hash: previous,
        entry_hash: '',
        metadata: this.restoredMetadata(source.metadata, {
          version: CONSOLIDATION_METADATA_VERSION,
          kind: 'restore',
          operation_id: request.operation_id,
          request_hash: requestHash,
          result_id: id,
          consolidation_result_id: result.id,
          original_id: source.id,
          source_ids: lineage.source_ids,
          restored_ids: restoredIds,
        }),
      };
      entry.entry_hash = computeEntryHash(entry, this.platform.crypto);
      restored.push(entry);
      previous = entry.entry_hash;
    }
    const insert = this.prepareEntryInsert();
    const mark = this.db.prepare(
      `UPDATE memories SET superseded_at = ?, superseded_by = ?
       WHERE id = ? AND forgotten_at IS NULL AND superseded_at IS NULL`,
    );
    this.db.transaction(() => {
      const current = this.getEntry(result.id);
      if (!current || exactCanonicalJson(current) !== exactCanonicalJson(request.expected_result)) {
        throw new Error('Consolidated result changed before restore could be applied.');
      }
      for (const source of sources) {
        const live = this.getEntry(source.id);
        if (!live || exactCanonicalJson(live) !== exactCanonicalJson(source) || computeEntryHash(live, this.platform.crypto) !== live.entry_hash || live.forgotten_at !== null || live.superseded_by !== result.id || live.superseded_at !== result.created_at) {
          throw new Error(`Consolidation source ${source.id} changed before restore could be applied.`);
        }
      }
      for (const entry of restored) insert.run(this.entryParams(entry));
      if (mark.run(now, restored[0]!.id, result.id).changes !== 1) {
        throw new Error('Consolidated result changed before restore could be applied.');
      }
      this.setMeta('chain_head', restored.at(-1)!.entry_hash);
    })();
    const updatedResult = { ...result, superseded_at: now, superseded_by: restored[0]!.id };
    return { operation_id: request.operation_id, kind: 'restore', result: updatedResult, sources, restored_entries: restored };
  }

  consolidationHistory(): ConsolidationHistoryItem[] {
    this.assertOpen();
    const entries = this.list({ includeForgotten: true, includeSuperseded: true });
    const items: ConsolidationHistoryItem[] = [];
    for (const result of entries) {
      const meta = this.tryReadConsolidationMetadata(result);
      if (!meta || meta.kind !== 'consolidate' || meta.result_id !== result.id) continue;
      const sources = this.validatePersistedConsolidation(result, meta, true).storedSources;
      const restored = entries.filter((entry) => {
        const recovery = this.tryReadConsolidationMetadata(entry);
        return recovery?.kind === 'restore' && recovery.consolidation_result_id === result.id && recovery.result_id === entry.id;
      });
      if (restored.length === meta.source_ids.length) this.validateRestoredSet(restored, meta.source_ids, result.id, true);
      items.push({
        operation_id: meta.operation_id,
        result,
        sources,
        restored_entries: restored,
        can_restore: result.forgotten_at === null && result.superseded_at === null && !result.scope.startsWith('project:') && !this.isScopeShared(result.scope) && sources.every((source) => source.forgotten_at === null && !this.isScopeShared(source.scope)),
      });
    }
    return items;
  }

  private assertConsolidationRequest(request: ConsolidationRequest): void {
    this.assertOperationId(request.operation_id);
    if (request.vault_id !== this.getVaultId()) throw new Error('Vault id does not match this vault.');
    if (request.sources.length < 2 || request.sources.length > 8) {
      throw new Error('Consolidation requires 2-8 source memories.');
    }
    if (request.content.trim().length === 0) throw new Error('Consolidated content must not be empty.');
    if (request.content.length > CONSOLIDATION_CONTENT_MAX_CHARS) {
      throw new Error(`Consolidated content exceeds ${CONSOLIDATION_CONTENT_MAX_CHARS} characters.`);
    }
    if (new TextEncoder().encode(exactCanonicalJson(request)).length > CONSOLIDATION_REQUEST_MAX_BYTES) {
      throw new Error('Consolidation request exceeds 256 KiB.');
    }
    const ids = new Set(request.sources.map((source) => source.id));
    if (ids.size !== request.sources.length) throw new Error('Consolidation sources must be unique.');
    const first = request.sources[0]!;
    if (first.scope.startsWith('project:')) throw new Error('Project memories cannot be consolidated.');
    if (this.isScopeShared(first.scope)) throw new Error('Shared memories cannot be consolidated.');
    for (const source of request.sources) {
      if (source.scope !== first.scope) throw new Error('Consolidation sources must share one scope.');
      if (source.type !== first.type) throw new Error('Consolidation sources must share one type.');
      this.assertSourceMetadataAuthentic(source);
    }
    this.assertSourcesStillApplicable(request.sources);
  }

  private assertSourcesStillApplicable(sources: MemoryEntry[]): void {
    for (const expected of sources) {
      const current = this.getEntry(expected.id);
      if (!current || exactCanonicalJson(current) !== exactCanonicalJson(expected)) {
        throw new Error(`Memory ${expected.id} changed after confirmation.`);
      }
      if (current.forgotten_at !== null || current.superseded_at !== null) {
        throw new Error(`Memory ${expected.id} is not live.`);
      }
      if (current.scope.startsWith('project:') || this.isScopeShared(current.scope)) {
        throw new Error(`Memory ${expected.id} is not in a private, non-project scope.`);
      }
    }
  }

  private consolidationRequestHash(kind: 'consolidate' | 'restore', request: ConsolidationRequest | RestoreConsolidationRequest): string {
    const exact = exactCanonicalJson({ action: kind, version: CONSOLIDATION_METADATA_VERSION, request });
    if (new TextEncoder().encode(exact).length > CONSOLIDATION_REQUEST_MAX_BYTES) {
      throw new Error('Consolidation request exceeds 256 KiB.');
    }
    return blake2bHex(
      exact,
      this.platform.crypto,
    );
  }

  private snapshotHash(entry: MemoryEntry): string {
    return blake2bHex(exactCanonicalJson(entry), this.platform.crypto);
  }

  private assertOperationId(value: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
      throw new Error('Operation id must be a lowercase RFC 4122 UUID.');
    }
  }

  private getEntry(id: string): MemoryEntry | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as EntryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  private isScopeShared(scope: string): boolean {
    const row = this.db.prepare('SELECT shared FROM scopes WHERE scope = ?').get(scope) as { shared: number } | undefined;
    return row?.shared === 1;
  }

  private prepareEntryInsert() {
    return this.db.prepare(
      `INSERT INTO memories
       (id, type, content, scope, source, source_model, confidence, created_at,
        valid_from, superseded_at, superseded_by, forgotten_at, prev_hash, entry_hash, metadata)
       VALUES (@id, @type, @content, @scope, @source, @source_model, @confidence,
               @created_at, @valid_from, @superseded_at, @superseded_by, @forgotten_at,
               @prev_hash, @entry_hash, @metadata)`,
    );
  }

  private entryParams(entry: MemoryEntry): Record<string, unknown> {
    return { ...entry, metadata: entry.metadata === null ? null : JSON.stringify(entry.metadata) };
  }

  private restoredMetadata(original: Record<string, unknown> | null, recovery: Omit<RestoreMetadata, 'original_metadata'>): Record<string, unknown> {
    const metadata = original === null
      ? {}
      : (JSON.parse(JSON.stringify(original)) as Record<string, unknown>);
    metadata[CONSOLIDATION_METADATA_KEY] = { ...recovery, original_metadata: original };
    return metadata;
  }

  private assertSourceMetadataAuthentic(entry: MemoryEntry): void {
    if (!entry.metadata || !Object.hasOwn(entry.metadata, CONSOLIDATION_METADATA_KEY)) return;
    const metadata = this.tryReadConsolidationMetadata(entry);
    if (!metadata) throw new Error('Source contains malformed reserved consolidation metadata.');
    const original = this.getEntry(metadata.result_id);
    if (!original || computeEntryHash(original, this.platform.crypto) !== original.entry_hash) {
      throw new Error('Source contains unauthenticated consolidation metadata.');
    }
    const originalMetadata = this.tryReadConsolidationMetadata(original);
    if (!originalMetadata || exactCanonicalJson(originalMetadata) !== exactCanonicalJson(metadata)) {
      throw new Error('Source contains copied metadata without its recorded operation result.');
    }
    let cursor = original;
    const seen = new Set<string>();
    while (cursor.id !== entry.id) {
      if (seen.has(cursor.id) || cursor.superseded_by === null) {
        throw new Error('Source consolidation metadata is not on its recorded edit lineage.');
      }
      seen.add(cursor.id);
      const next = this.getEntry(cursor.superseded_by);
      if (!next) throw new Error('Source consolidation metadata has incomplete edit lineage.');
      cursor = next;
    }
  }

  private tryReadConsolidationMetadata(entry: MemoryEntry): CurationMetadata | null {
    const raw = entry.metadata?.[CONSOLIDATION_METADATA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== CONSOLIDATION_METADATA_VERSION || (value.kind !== 'consolidate' && value.kind !== 'restore')) {
      throw new Error('Malformed reserved consolidation metadata.');
    }
    const strings = ['operation_id', 'request_hash', 'result_id'];
    if (strings.some((key) => typeof value[key] !== 'string')) throw new Error('Malformed reserved consolidation metadata.');
    this.assertOperationId(value.operation_id as string);
    if (!/^[0-9a-f]{64}$/.test(value.request_hash as string)) throw new Error('Malformed reserved consolidation metadata.');
    if (value.kind === 'consolidate') {
      if (!isStringArray(value.source_ids) || !isStringArray(value.source_hashes) || !isStringArray(value.source_snapshot_hashes)) {
        throw new Error('Malformed reserved consolidation metadata.');
      }
      if (value.source_ids.length < 2 || value.source_ids.length > 8 || value.source_ids.length !== value.source_hashes.length || value.source_ids.length !== value.source_snapshot_hashes.length) {
        throw new Error('Malformed reserved consolidation metadata.');
      }
      if (new Set(value.source_ids).size !== value.source_ids.length) throw new Error('Malformed reserved consolidation metadata.');
      return value as unknown as ConsolidationMetadata;
    }
    if (typeof value.consolidation_result_id !== 'string' || typeof value.original_id !== 'string' || !isStringArray(value.source_ids) || !isStringArray(value.restored_ids) || value.source_ids.length !== value.restored_ids.length || !Object.hasOwn(value, 'original_metadata') || (value.original_metadata !== null && (typeof value.original_metadata !== 'object' || Array.isArray(value.original_metadata)))) {
      throw new Error('Malformed reserved consolidation metadata.');
    }
    return value as unknown as RestoreMetadata;
  }

  private readConsolidationMetadata(entry: MemoryEntry, kind: 'consolidate'): ConsolidationMetadata;
  private readConsolidationMetadata(entry: MemoryEntry, kind: 'restore'): RestoreMetadata;
  private readConsolidationMetadata(entry: MemoryEntry, kind: CurationMetadata['kind']): CurationMetadata {
    const metadata = this.tryReadConsolidationMetadata(entry);
    if (!metadata || metadata.kind !== kind) throw new Error(`Memory ${entry.id} has no valid ${kind} lineage.`);
    if (metadata.result_id !== entry.id) throw new Error('Copied or malformed operation metadata is not an operation result.');
    if (entry.forgotten_at === null && computeEntryHash(entry, this.platform.crypto) !== entry.entry_hash) {
      throw new Error('Operation result hash is invalid.');
    }
    return metadata;
  }

  private findConsolidationOperation(operationId: string): { kind: CurationMetadata['kind']; requestHash: string; entries: MemoryEntry[] } | null {
    this.assertOperationId(operationId);
    const matches: MemoryEntry[] = [];
    let kind: CurationMetadata['kind'] | null = null;
    let requestHash: string | null = null;
    for (const entry of this.list({ includeForgotten: true, includeSuperseded: true })) {
      const metadata = this.tryReadConsolidationMetadata(entry);
      if (!metadata || metadata.operation_id !== operationId || metadata.result_id !== entry.id) continue;
      if ((kind !== null && kind !== metadata.kind) || (requestHash !== null && requestHash !== metadata.request_hash)) {
        throw new Error('Ambiguous consolidation operation metadata.');
      }
      kind = metadata.kind;
      requestHash = metadata.request_hash;
      matches.push(entry);
    }
    return kind === null ? null : { kind, requestHash: requestHash!, entries: matches };
  }

  private validateConsolidationRetry(operation: { entries: MemoryEntry[] }, request: ConsolidationRequest): ConsolidationResult {
    if (operation.entries.length !== 1) throw new Error('Malformed consolidation operation result set.');
    const result = operation.entries[0]!;
    const meta = this.readConsolidationMetadata(result, 'consolidate');
    if (meta.source_ids.join('\0') !== request.sources.map((source) => source.id).join('\0') || meta.source_snapshot_hashes.some((hash, i) => hash !== this.snapshotHash(request.sources[i]!))) {
      throw new Error('Persisted consolidation does not match the complete request.');
    }
    const sources = this.validatePersistedConsolidation(result, meta).originalSnapshots;
    if (exactCanonicalJson(sources) !== exactCanonicalJson(request.sources) || result.content !== request.content) throw new Error('Persisted consolidation result does not match the complete request.');
    return { operation_id: meta.operation_id, kind: 'consolidate', result, sources, restored_entries: [] };
  }

  private validateRestoreRetry(operation: { entries: MemoryEntry[] }, request: RestoreConsolidationRequest): ConsolidationResult {
    const firstMeta = this.readConsolidationMetadata(operation.entries[0]!, 'restore');
    this.validateRestoredSet(operation.entries, firstMeta.source_ids, firstMeta.consolidation_result_id);
    const result = this.getEntry(firstMeta.consolidation_result_id);
    if (!result || result.superseded_by !== firstMeta.restored_ids[0]) throw new Error('Persisted restore result link is invalid.');
    const expected = { ...result, superseded_at: null, superseded_by: null };
    if (request.result_id !== result.id || exactCanonicalJson(expected) !== exactCanonicalJson(request.expected_result)) {
      throw new Error('Persisted restore does not match the complete request.');
    }
    const consolidateMeta = this.readConsolidationMetadata(expected, 'consolidate');
    if (exactCanonicalJson(firstMeta.source_ids) !== exactCanonicalJson(consolidateMeta.source_ids)) throw new Error('Persisted restore source membership is invalid.');
    const sources = this.validatePersistedConsolidation(expected, consolidateMeta).storedSources;
    const byId = new Map(operation.entries.map((entry) => [entry.id, entry]));
    const restored = firstMeta.restored_ids.map((id) => byId.get(id)!);
    return { operation_id: firstMeta.operation_id, kind: 'restore', result, sources, restored_entries: restored };
  }

  private validatePersistedConsolidation(result: MemoryEntry, meta: ConsolidationMetadata, allowForgotten = false): { storedSources: MemoryEntry[]; originalSnapshots: MemoryEntry[] } {
    if (!result.metadata || Object.keys(result.metadata).length !== 1 || result.source !== 'northkeep:consolidation' || result.source_model !== null || result.confidence !== 1 || result.valid_from !== result.created_at || result.forgotten_at !== null || computeEntryHash(result, this.platform.crypto) !== result.entry_hash) {
      throw new Error('Persisted consolidation result shape is invalid.');
    }
    const storedSources = meta.source_ids.map((id, index) => {
      const source = this.getEntry(id);
      const forgottenOkay = allowForgotten && source?.forgotten_at !== null;
      if (!source || (!forgottenOkay && (source.forgotten_at !== null || computeEntryHash(source, this.platform.crypto) !== source.entry_hash)) || source.entry_hash !== meta.source_hashes[index] || source.superseded_by !== result.id || source.superseded_at !== result.created_at || source.type !== result.type || source.scope !== result.scope) {
        throw new Error('Persisted consolidation lineage is incomplete or invalid.');
      }
      return source;
    });
    const originalSnapshots = storedSources.map((source, index) => {
      const snapshot = { ...source, superseded_at: null, superseded_by: null };
      if (source.forgotten_at === null && this.snapshotHash(snapshot) !== meta.source_snapshot_hashes[index]) throw new Error('Persisted consolidation source snapshot is invalid.');
      return snapshot;
    });
    if (storedSources.every((source) => source.forgotten_at === null)) {
      const recomputed = this.consolidationRequestHash('consolidate', { vault_id: this.getVaultId(), operation_id: meta.operation_id, sources: originalSnapshots, content: result.content });
      if (recomputed !== meta.request_hash) throw new Error('Persisted consolidation request fingerprint is invalid.');
    }
    return { storedSources, originalSnapshots };
  }

  private validateRestoredSet(entries: MemoryEntry[], sourceIds: string[], consolidationResultId: string, allowSuperseded = false): void {
    if (entries.length !== sourceIds.length) throw new Error('Persisted restore result set is incomplete.');
    const first = this.readConsolidationMetadata(entries[0]!, 'restore');
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    if (new Set(sourceIds).size !== sourceIds.length || new Set(first.restored_ids).size !== first.restored_ids.length || first.restored_ids.some((id) => !byId.has(id))) {
      throw new Error('Persisted restore result set is invalid.');
    }
    const consolidationResult = this.getEntry(consolidationResultId);
    if (!consolidationResult || consolidationResult.superseded_at !== entries[0]!.created_at || consolidationResult.superseded_by !== first.restored_ids[0]) {
      throw new Error('Persisted restore result relationship is invalid.');
    }
    for (let index = 0; index < first.restored_ids.length; index += 1) {
      const entry = byId.get(first.restored_ids[index]!)!;
      const meta = this.readConsolidationMetadata(entry, 'restore');
      if (meta.operation_id !== first.operation_id || meta.request_hash !== first.request_hash || meta.consolidation_result_id !== consolidationResultId || meta.original_id !== sourceIds[index] || exactCanonicalJson(meta.restored_ids) !== exactCanonicalJson(first.restored_ids) || exactCanonicalJson(meta.source_ids) !== exactCanonicalJson(sourceIds)) {
        throw new Error('Persisted restore metadata is inconsistent.');
      }
      if (index > 0 && entry.prev_hash !== byId.get(first.restored_ids[index - 1]!)!.entry_hash) {
        throw new Error('Persisted restore insertion links are invalid.');
      }
      const original = this.getEntry(sourceIds[index]!);
      const forgottenOriginalOkay = allowSuperseded && original?.forgotten_at !== null;
      if (!original || (!forgottenOriginalOkay && (original.forgotten_at !== null || computeEntryHash(original, this.platform.crypto) !== original.entry_hash))) {
        throw new Error('Persisted restore original is missing or invalid.');
      }
      if (forgottenOriginalOkay) continue;
      const supersededOkay = allowSuperseded && entry.superseded_at !== null && entry.superseded_by !== null;
      if (entry.type !== original.type || entry.content !== original.content || entry.scope !== original.scope || entry.source !== 'northkeep:consolidation-recovery' || entry.source_model !== original.source_model || entry.confidence !== original.confidence || entry.valid_from !== original.valid_from || entry.forgotten_at !== null || (!supersededOkay && (entry.superseded_at !== null || entry.superseded_by !== null)) || entry.created_at !== entries[0]!.created_at || exactCanonicalJson(meta.original_metadata) !== exactCanonicalJson(original.metadata)) {
        throw new Error('Persisted restored entry does not reproduce its original source.');
      }
      if (supersededOkay) {
        const successor = this.getEntry(entry.superseded_by!);
        if (!successor || successor.created_at !== entry.superseded_at) throw new Error('Persisted restored entry edit link is invalid.');
        this.assertSourceMetadataAuthentic(successor);
      }
      const expectedMetadata = original.metadata === null
        ? {}
        : (JSON.parse(JSON.stringify(original.metadata)) as Record<string, unknown>);
      expectedMetadata[CONSOLIDATION_METADATA_KEY] = meta;
      if (exactCanonicalJson(entry.metadata) !== exactCanonicalJson(expectedMetadata)) {
        throw new Error('Persisted restored entry metadata is invalid.');
      }
    }
    const predecessor = this.db.prepare(
      'SELECT entry_hash FROM memories WHERE rowid < (SELECT rowid FROM memories WHERE id = ?) ORDER BY rowid DESC LIMIT 1',
    ).get(first.restored_ids[0]) as { entry_hash: string } | undefined;
    if (entries[0]!.prev_hash !== (predecessor?.entry_hash ?? GENESIS_HASH)) {
      throw new Error('Persisted restore first insertion link is invalid.');
    }
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
    // A generic edit is not the recorded writer, so the block never carries over.
    if (next.metadata !== null && PROJECT_PROVENANCE_METADATA_KEY in next.metadata) {
      delete next.metadata[PROJECT_PROVENANCE_METADATA_KEY];
      if (Object.keys(next.metadata).length === 0) next.metadata = null;
    }
    next.entry_hash = computeEntryHash(next, this.platform.crypto);
    this.autoCompaction = null;
    let auto: AutoCompaction | null = null;

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
      // The superseded row keeps the old scope and type, so a project document
      // edited or moved away still leaves a revision behind in its project scope.
      if (old.type === 'working') auto = this.autoCompactScope(old.scope);
    })();
    this.finishAutoCompaction(auto);
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

  /**
   * Scopes marked Shared with Cloud Connect (ADR 0038), sorted. Lives in the
   * vault — not a sidecar — so the marks travel with the vault through sync and
   * every device answers this identically. No row / shared=0 means private.
   */
  sharedScopes(): string[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT scope FROM scopes WHERE shared = 1 ORDER BY scope')
      .all() as Array<{ scope: string }>;
    return rows.map((r) => r.scope);
  }

  /** Shared rows with their timestamps — the export/rebuild shape. */
  sharedScopeRows(): Array<{ scope: string; shared_at: string | null }> {
    this.assertOpen();
    return this.db
      .prepare('SELECT scope, shared_at FROM scopes WHERE shared = 1 ORDER BY scope')
      .all() as Array<{ scope: string; shared_at: string | null }>;
  }

  /**
   * Mark a scope Shared or private again. Persists via the caller's next
   * save(), like remember(). Unsharing DELETES the row rather than flipping the
   * flag, so the table only ever describes shares — an empty table and a fresh
   * vault are indistinguishable, which keeps "default private" structural.
   */
  setScopeShared(scope: string, shared: boolean, sharedAt?: string): void {
    this.assertOpen();
    const s = scope.trim();
    if (s.length === 0) throw new Error('Scope must not be empty.');
    if (shared) {
      // N6 choke point: only stamp shared_at on a private→shared transition
      // (no row or shared=0). An already-shared row keeps its timestamp unless
      // the caller passes an explicit sharedAt (export rebuild).
      const existing = this.db
        .prepare('SELECT shared, shared_at FROM scopes WHERE scope = ?')
        .get(s) as { shared: number; shared_at: string | null } | undefined;
      const alreadyShared = existing !== undefined && existing.shared === 1;
      const stamp =
        sharedAt !== undefined
          ? sharedAt
          : alreadyShared
            ? existing.shared_at
            : new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO scopes (scope, shared, shared_at) VALUES (?, 1, ?) ' +
            'ON CONFLICT(scope) DO UPDATE SET shared = 1, shared_at = excluded.shared_at',
        )
        .run(s, stamp);
    } else {
      this.db.prepare('DELETE FROM scopes WHERE scope = ?').run(s);
    }
  }

  /** Bind local review state to the vault, even if another file replaces its path. */
  getVaultId(): string {
    this.assertOpen();
    return this.getMeta('vault_id');
  }

  /**
   * Integer sync generation sealed in vault_meta (ADR 0038 addendum). Missing
   * key reads as 0. Invalid value (NaN, negative, non-integer) throws so the
   * pull path can fail closed without replacing the local vault.
   */
  getSyncGeneration(): number {
    this.assertOpen();
    const raw = this.getMetaOptional('sync_generation');
    if (raw === undefined) return 0;
    return parseSyncGeneration(raw);
  }

  /**
   * Increment sync_generation by 1. Persists via the caller's next save().
   * Integer math, never a TEXT compare.
   */
  bumpSyncGeneration(): void {
    this.assertOpen();
    this.setMeta('sync_generation', String(this.getSyncGeneration() + 1));
  }

  /**
   * Set sync_generation to an exact non-negative integer (export rebuild and
   * phone LWW conflict re-push). Persists via the caller's next save().
   */
  setSyncGeneration(value: number): void {
    this.assertOpen();
    if (!Number.isInteger(value) || value < 0) {
      throw new VaultSyncGenerationError(
        `sync_generation must be a non-negative integer, got ${String(value)}.`,
      );
    }
    this.setMeta('sync_generation', String(value));
  }

  /** True after a sidecar/SecureStore fold has been applied to this vault. */
  isSidecarFoldDone(): boolean {
    this.assertOpen();
    return this.getMetaOptional('sidecar_fold_done') === '1';
  }

  /** Pin the one-time sidecar fold. Persists via the caller's next save(). */
  markSidecarFoldDone(): void {
    this.assertOpen();
    this.setMeta('sidecar_fold_done', '1');
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
      // content is blanked so the content check no longer applies. What they may
      // still carry is checked structurally instead: nothing, or the lone writer
      // block compaction keeps (ADR 0051 addendum). The block's own fields cannot
      // be re-hashed once the content is gone; this catches shape, not a swap.
      if (entry.forgotten_at === null) {
        const expected = computeEntryHash(entry, this.platform.crypto);
        if (entry.entry_hash !== expected) {
          return { ok: false, error: `Entry ${entry.id} hash does not match its content.` };
        }
      } else if (entry.metadata !== null && !isProvenanceOnlyMetadata(entry.metadata)) {
        return { ok: false, error: `Forgotten entry ${entry.id} carries metadata beyond its writer block.` };
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
        sync_generation: this.getSyncGeneration(),
      },
      memories,
      // Sharing marks are user state, not derived cache, so invariant #4 says
      // they survive a rebuild. Only shares are listed; absence = private.
      shared_scopes: this.sharedScopeRows().map((r) => ({ scope: r.scope, shared_at: r.shared_at })),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    memzero(this.key, this.platform.crypto);
  }

  private getMeta(key: string): string {
    const row = this.getMetaOptional(key);
    if (row === undefined) throw new Error(`Vault is missing required metadata "${key}".`);
    return row;
  }

  private getMetaOptional(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
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
/** Read-only: whether import would refuse this slug. Lets a dry run say "exists" without writing. */
export function projectScopeInUse(vault: Vault, slug: string): boolean {
  return vault.projectScopeInUse(slug);
}

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

/**
 * The metadata a blanked revision keeps, serialized: a lone, well-formed writer
 * block, or null. A malformed block is dropped rather than kept, so a blanked
 * row can never carry something verifyChain would then reject.
 */
function keptProvenanceMetadata(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const block = (parsed as Record<string, unknown>)[PROJECT_PROVENANCE_METADATA_KEY];
  if (block === undefined) return null;
  const only = { [PROJECT_PROVENANCE_METADATA_KEY]: block };
  return isProvenanceOnlyMetadata(only) ? JSON.stringify(only) : null;
}

/** Exactly one key, the writer block, and a block a reader accepts. */
function isProvenanceOnlyMetadata(metadata: Record<string, unknown>): boolean {
  const keys = Object.keys(metadata);
  if (keys.length !== 1 || keys[0] !== PROJECT_PROVENANCE_METADATA_KEY) return false;
  return readProjectProvenance({ metadata } as MemoryEntry) !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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

/**
 * Parse a vault_meta sync_generation TEXT value as a non-negative integer.
 * Rejects NaN, negatives, and non-integers (including "10.0" / "1e2") so a
 * TEXT compare can never sneak through.
 */
export function parseSyncGeneration(raw: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new VaultSyncGenerationError(
      `Vault sync_generation is invalid (${JSON.stringify(raw)}). Local vault was not changed.`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || !Number.isSafeInteger(n)) {
    throw new VaultSyncGenerationError(
      `Vault sync_generation is invalid (${JSON.stringify(raw)}). Local vault was not changed.`,
    );
  }
  return n;
}

function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().normalize('NFC').matchAll(/[a-z0-9]{2,}/g)) {
    terms.add(match[0]);
  }
  return terms;
}
