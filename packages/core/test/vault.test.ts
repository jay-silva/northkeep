import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, VaultAuthError, generateDeviceSecret } from '../src/crypto.js';
import { GENESIS_HASH, MEMORY_TYPES } from '../src/types.js';
import { Vault } from '../src/vault.js';

const PASSPHRASE = 'a strong test passphrase';
const kdf = KDF_INTERACTIVE;

let dir: string;
let vaultPath: string;
let deviceSecret: Buffer;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-test-'));
  vaultPath = path.join(dir, 'vault.nkv');
  deviceSecret = generateDeviceSecret();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function createVault(): Vault {
  return Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf });
}

function openVault(passphrase = PASSPHRASE, secret = deviceSecret): Vault {
  return Vault.open({ path: vaultPath, passphrase, deviceSecret: secret, kdf });
}

describe('vault lifecycle', () => {
  it('creates an encrypted file that is not a SQLite database', () => {
    const vault = createVault();
    vault.close();
    const bytes = fs.readFileSync(vaultPath);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('NKV1');
    expect(bytes.includes(Buffer.from('SQLite format 3'))).toBe(false);
  });

  it('refuses to overwrite an existing vault', () => {
    createVault().close();
    expect(() => createVault()).toThrow(/already exists/);
  });

  it('fails cleanly with the wrong passphrase', () => {
    createVault().close();
    expect(() => openVault('the wrong passphrase')).toThrow(VaultAuthError);
  });

  it('fails cleanly with the wrong device secret', () => {
    createVault().close();
    expect(() => openVault(PASSPHRASE, generateDeviceSecret())).toThrow(VaultAuthError);
  });

  it('fails cleanly on a tampered file', () => {
    createVault().close();
    const bytes = fs.readFileSync(vaultPath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(vaultPath, bytes);
    expect(() => openVault()).toThrow(VaultAuthError);
  });

  it('rejects absurd KDF params in a tampered header without doing the work', () => {
    createVault().close();
    const bytes = fs.readFileSync(vaultPath);
    // Header layout: magic 4B | salt 16B | opslimit u32LE | memlimit u32LE | ...
    bytes.writeUInt32LE(0xffffffff, 24); // ~4 TB memlimit — must be refused pre-KDF
    fs.writeFileSync(vaultPath, bytes);
    const start = Date.now();
    expect(() => openVault()).toThrow(VaultAuthError);
    expect(Date.now() - start).toBeLessThan(1000); // rejected up front, not after Argon2id
  });

  it('fails cleanly on a truncated file', () => {
    createVault().close();
    const bytes = fs.readFileSync(vaultPath);
    for (const length of [0, 3, 20, 51]) {
      fs.writeFileSync(vaultPath, bytes.subarray(0, length));
      expect(() => openVault()).toThrow(VaultAuthError);
    }
    fs.writeFileSync(vaultPath, bytes.subarray(0, 52)); // header only, no ciphertext
    expect(() => openVault()).toThrow(VaultAuthError);
  });

  it('keeps a .bak of the previous version on save', () => {
    const vault = createVault();
    vault.remember({ content: 'first', type: 'semantic' });
    vault.save();
    vault.close();
    expect(fs.existsSync(`${vaultPath}.bak`)).toBe(true);
  });
});

describe('remember / list round-trip', () => {
  it('round-trips all five memory types across close and reopen', () => {
    const vault = createVault();
    for (const type of MEMORY_TYPES) {
      vault.remember({ content: `a ${type} memory`, type, scope: 'work' });
    }
    vault.save();
    vault.close();

    const reopened = openVault();
    const entries = reopened.list();
    expect(entries).toHaveLength(MEMORY_TYPES.length);
    expect(entries.map((e) => e.type)).toEqual([...MEMORY_TYPES]);
    for (const entry of entries) {
      expect(entry.content).toBe(`a ${entry.type} memory`);
      expect(entry.scope).toBe('work');
      expect(entry.source).toBe('cli');
      expect(entry.confidence).toBe(1.0);
      expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.valid_from).toBe(entry.created_at);
      expect(entry.superseded_at).toBeNull();
      expect(entry.superseded_by).toBeNull();
    }
    reopened.close();
  });

  it('filters by type and scope', () => {
    const vault = createVault();
    vault.remember({ content: 'personal fact', type: 'semantic' });
    vault.remember({ content: 'work fact', type: 'semantic', scope: 'work' });
    vault.remember({ content: 'work event', type: 'episodic', scope: 'work' });
    expect(vault.list({ type: 'semantic' })).toHaveLength(2);
    expect(vault.list({ scope: 'work' })).toHaveLength(2);
    expect(vault.list({ type: 'semantic', scope: 'work' })).toHaveLength(1);
    vault.close();
  });

  it('rejects an invalid type, empty content, and out-of-range confidence', () => {
    const vault = createVault();
    expect(() =>
      vault.remember({ content: 'x', type: 'opinions' as never }),
    ).toThrow(/Invalid memory type/);
    expect(() => vault.remember({ content: '  ', type: 'semantic' })).toThrow(/must not be empty/);
    expect(() =>
      vault.remember({ content: 'x', type: 'semantic', confidence: 1.5 }),
    ).toThrow(/between 0.0 and 1.0/);
    vault.close();
  });
});

describe('hash chain', () => {
  it('links entries from the genesis hash and verifies', () => {
    const vault = createVault();
    const first = vault.remember({ content: 'one', type: 'semantic' });
    const second = vault.remember({ content: 'two', type: 'episodic' });
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.prev_hash).toBe(first.entry_hash);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('detects a deleted entry (head no longer matches)', () => {
    const vault = createVault();
    vault.remember({ content: 'keep', type: 'semantic' });
    const second = vault.remember({ content: 'delete me', type: 'semantic' });
    (vault as unknown as { db: { prepare(sql: string): { run(v: string): unknown } } }).db
      .prepare('DELETE FROM memories WHERE id = ?')
      .run(second.id);
    const result = vault.verifyChain();
    expect(result.ok).toBe(false);
    vault.close();
  });

  it('detects a silently edited entry', () => {
    const vault = createVault();
    vault.remember({ content: 'original', type: 'semantic' });
    // Simulate tooling/malware editing content without re-hashing.
    (vault as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db
      .prepare("UPDATE memories SET content = 'tampered'")
      .run();
    const result = vault.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hash does not match/);
    vault.close();
  });
});

describe('export', () => {
  it('matches the schema spec shape and passes chain verification', () => {
    const vault = createVault();
    vault.remember({ content: 'exported fact', type: 'identity', metadata: { origin: 'test' } });
    const doc = vault.export();
    expect(doc.northkeep_export.schema_version).toBe('0.1');
    expect(doc.northkeep_export.vault_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.northkeep_export.chain_head).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.memories).toHaveLength(1);
    const memory = doc.memories[0]!;
    expect(memory).toMatchObject({
      type: 'identity',
      content: 'exported fact',
      scope: 'personal',
      metadata: { origin: 'test' },
    });
    expect(memory.provenance.entry_hash).toBe(doc.northkeep_export.chain_head);
    expect(memory.validity.superseded_at).toBeNull();
    // The export must be fully JSON-serializable and human-readable.
    expect(() => JSON.stringify(doc, null, 2)).not.toThrow();
    vault.close();
  });
});
