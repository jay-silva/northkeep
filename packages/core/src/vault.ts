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

  static open(options: VaultOptions): Vault {
    let file: Buffer;
    try {
      file = fs.readFileSync(options.path);
    } catch {
      throw new Error(`No vault found at ${options.path}. Run "northkeep init" first.`);
    }
    if (file.length < HEADER_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new VaultAuthError(`${options.path} is not a Northkeep vault file.`);
    }
    let offset = MAGIC.length;
    const salt = Buffer.from(file.subarray(offset, offset + SALT_BYTES));
    offset += SALT_BYTES;
    const opslimit = file.readUInt32LE(offset);
    offset += 4;
    const memlimit = file.readUInt32LE(offset);
    offset += 4;
    const nonce = Buffer.from(file.subarray(offset, offset + NONCE_BYTES));
    offset += NONCE_BYTES;
    const ciphertext = Buffer.from(file.subarray(offset));
    const header = Buffer.from(file.subarray(0, HEADER_LENGTH));

    // KDF params come from the file so old vaults keep opening if defaults change.
    const kdf: KdfParams = { opslimit, memlimit };
    const key = deriveMasterKey(options.passphrase, options.deviceSecret, salt, kdf);
    let image: Buffer;
    try {
      image = decrypt(ciphertext, key, nonce, header);
    } catch (err) {
      memzero(key);
      throw err;
    }
    const db = new Database(image);
    db.pragma('foreign_keys = ON');
    return new Vault(options.path, db, key, salt, kdf);
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
      prev_hash: this.getMeta('chain_head'),
      entry_hash: '',
      metadata: input.metadata ?? null,
    };
    entry.entry_hash = computeEntryHash(entry);

    this.db
      .prepare(
        `INSERT INTO memories
         (id, type, content, scope, source, source_model, confidence, created_at,
          valid_from, superseded_at, superseded_by, prev_hash, entry_hash, metadata)
         VALUES (@id, @type, @content, @scope, @source, @source_model, @confidence,
                 @created_at, @valid_from, @superseded_at, @superseded_by,
                 @prev_hash, @entry_hash, @metadata)`,
      )
      .run({ ...entry, metadata: entry.metadata === null ? null : JSON.stringify(entry.metadata) });
    this.setMeta('chain_head', entry.entry_hash);
    return entry;
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
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY rowid ASC`)
      .all(params) as EntryRow[];
    return rows.map(rowToEntry);
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
      const expected = computeEntryHash(entry);
      if (entry.entry_hash !== expected) {
        return { ok: false, error: `Entry ${entry.id} hash does not match its content.` };
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
    const memories: ExportedMemory[] = this.list().map((entry) => ({
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

/** Hash input per SPEC: canonical JSON of every field except entry_hash. */
export function computeEntryHash(entry: MemoryEntry): string {
  const { entry_hash, ...hashed } = entry;
  void entry_hash;
  return blake2bHex(canonicalJson(hashed));
}

function rowToEntry(row: EntryRow): MemoryEntry {
  return {
    ...row,
    type: row.type as MemoryEntry['type'],
    metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>),
  };
}
