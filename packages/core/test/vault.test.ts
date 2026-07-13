import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KDF_INTERACTIVE,
  VaultAuthError,
  deriveMasterKey,
  generateDeviceSecret,
} from '../src/crypto.js';
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

describe('openWithKey (background access)', () => {
  it('opens with a pre-derived master key, no passphrase', () => {
    const vault = createVault();
    vault.remember({ content: 'background fact', type: 'semantic' });
    vault.save();
    vault.close();

    const header = Vault.readHeader(vaultPath);
    const key = deriveMasterKey(PASSPHRASE, deviceSecret, header.salt, header.kdf);
    const reopened = Vault.openWithKey(vaultPath, key);
    expect(reopened.list()).toHaveLength(1);
    reopened.close();
  });

  it('rejects a wrong key cleanly', () => {
    createVault().close();
    expect(() => Vault.openWithKey(vaultPath, generateDeviceSecret())).toThrow(VaultAuthError);
  });
});

describe('forget (tombstones)', () => {
  it('blanks content, hides from list, keeps the chain intact', () => {
    const vault = createVault();
    vault.remember({ content: 'keep this', type: 'semantic' });
    const target = vault.remember({ content: 'sensitive thing', type: 'episodic' });
    vault.remember({ content: 'also keep', type: 'working' });

    const tombstone = vault.forget(target.id.slice(0, 8)); // unique prefix works
    expect(tombstone.id).toBe(target.id);
    expect(tombstone.content).toBe('');
    expect(tombstone.forgotten_at).not.toBeNull();

    expect(vault.list().map((e) => e.content)).toEqual(['keep this', 'also keep']);
    expect(vault.list({ includeForgotten: true })).toHaveLength(3);
    expect(vault.verifyChain().ok).toBe(true);

    const exported = vault.export();
    const exportedTombstone = exported.memories.find((m) => m.id === target.id)!;
    expect(exportedTombstone.content).toBe('');
    expect(exportedTombstone.validity.forgotten_at).toBe(tombstone.forgotten_at);
    expect(JSON.stringify(exported)).not.toContain('sensitive thing');
    vault.close();
  });

  it('errors on unknown id and ambiguous prefix', () => {
    const vault = createVault();
    vault.remember({ content: 'a', type: 'semantic' });
    expect(() => vault.forget('ffffffff')).toThrow(/No memory found/);
    expect(() => vault.forget('')).toThrow(/at least 4 characters/);
    expect(() => vault.forget('ab')).toThrow(/at least 4 characters/);
    // LIKE metacharacters must not act as wildcards (%%%%%%%% would match
    // any entry and irreversibly forget it).
    expect(() => vault.forget('%%%%%%%%')).toThrow(/hex characters/);
    expect(() => vault.forget('a__a1111')).toThrow(/hex characters/);
    expect(vault.list()).toHaveLength(1); // nothing was forgotten by the attempts
    vault.close();
  });
});

describe('rescope (edit scope by supersession)', () => {
  it('moves a memory to a new scope, hides the old version, keeps the chain intact', () => {
    const vault = createVault();
    vault.remember({ content: 'keep this', type: 'semantic' });
    const target = vault.remember({ content: 'this is really a work fact', type: 'semantic' });

    const moved = vault.rescope(target.id.slice(0, 8), 'work');
    expect(moved.id).not.toBe(target.id); // append-only: a NEW entry, not a mutation
    expect(moved.scope).toBe('work');
    expect(moved.content).toBe('this is really a work fact');
    expect(moved.prev_hash).toBe(target.entry_hash); // chained onto the head

    // list shows the memory once, in its new scope only.
    expect(vault.list({ scope: 'personal' }).map((e) => e.content)).toEqual(['keep this']);
    expect(vault.list({ scope: 'work' }).map((e) => e.content)).toEqual([
      'this is really a work fact',
    ]);
    expect(vault.list()).toHaveLength(2); // not 3 — the superseded original is hidden

    // The original lingers as history: superseded, linked forward, chain valid.
    const withHistory = vault.list({ includeSuperseded: true });
    expect(withHistory).toHaveLength(3);
    const originalNow = withHistory.find((e) => e.id === target.id)!;
    expect(originalNow.superseded_at).not.toBeNull();
    expect(originalNow.superseded_by).toBe(moved.id);
    expect(originalNow.scope).toBe('personal'); // its own hash is untouched
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('survives a reopen and stays out of retrieve in the old scope', () => {
    const target = (() => {
      const vault = createVault();
      const t = vault.remember({ content: 'dartmouth rental note', type: 'semantic' });
      vault.rescope(t.id, 'work');
      vault.save();
      vault.close();
      return t;
    })();
    const reopened = openVault();
    expect(reopened.retrieve('rental', { scope: 'personal' })).toHaveLength(0);
    expect(reopened.retrieve('rental', { scope: 'work' })).toHaveLength(1);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.verifyChain().ok).toBe(true);
    expect(target.scope).toBe('personal');
    reopened.close();
  });

  it('is a no-op when already in the target scope', () => {
    const vault = createVault();
    const t = vault.remember({ content: 'x', type: 'semantic', scope: 'work' });
    const same = vault.rescope(t.id, 'work');
    expect(same.id).toBe(t.id);
    expect(vault.list({ includeSuperseded: true })).toHaveLength(1);
    vault.close();
  });

  it('validates the id and the new scope', () => {
    const vault = createVault();
    const t = vault.remember({ content: 'a', type: 'semantic' });
    expect(() => vault.rescope('ffffffff', 'work')).toThrow(/No memory found/);
    expect(() => vault.rescope('ab', 'work')).toThrow(/at least 4 characters/);
    expect(() => vault.rescope('%%%%%%%%', 'work')).toThrow(/hex characters/);
    expect(() => vault.rescope(t.id, '   ')).toThrow(/must not be empty/);
    expect(vault.list({ includeSuperseded: true })).toHaveLength(1); // nothing changed
    vault.close();
  });

  it('a scoped connection cannot move a memory outside its grant', () => {
    const vault = createVault();
    const t = vault.remember({ content: 'work thing', type: 'semantic', scope: 'work' });
    // Grant covers work but not personal → cannot move it to personal.
    expect(() => vault.rescope(t.id, 'personal', ['work'])).toThrow(/outside this connection's grant/);
    // Cannot touch an entry the grant can't even see.
    const p = vault.remember({ content: 'private', type: 'semantic', scope: 'personal' });
    expect(() => vault.rescope(p.id, 'work', ['work'])).toThrow(/No memory found/);
    vault.close();
  });
});

describe('retrieve (keyword ranking)', () => {
  it('ranks by term overlap and respects filters', () => {
    const vault = createVault();
    vault.remember({ content: 'Jay owns a short-term rental in Dartmouth', type: 'semantic' });
    vault.remember({ content: 'Jay prefers concise answers', type: 'procedural' });
    vault.remember({ content: 'Discussed rental financing with the lender', type: 'episodic', scope: 'work' });

    const results = vault.retrieve('rental property in Dartmouth');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.entry.content).toContain('Dartmouth');

    expect(vault.retrieve('rental', { scope: 'work' })).toHaveLength(1);
    expect(vault.retrieve('zebra quantum')).toHaveLength(0);
    expect(vault.retrieve('')).toHaveLength(0);
    vault.close();
  });

  it('excludes forgotten entries', () => {
    const vault = createVault();
    const entry = vault.remember({ content: 'secret rental details', type: 'semantic' });
    expect(vault.retrieve('rental')).toHaveLength(1);
    vault.forget(entry.id);
    expect(vault.retrieve('rental')).toHaveLength(0);
    vault.close();
  });
});

describe('scope enforcement (capability allowlist)', () => {
  function seeded(): Vault {
    const vault = createVault();
    vault.remember({ content: 'personal fact one', type: 'semantic', scope: 'personal' });
    vault.remember({ content: 'work fact one', type: 'semantic', scope: 'work' });
    vault.remember({ content: 'henderson matter detail', type: 'episodic', scope: 'client:henderson' });
    vault.remember({ content: 'acme matter detail', type: 'episodic', scope: 'client:acme' });
    return vault;
  }

  it('list caps visibility to the allowlist regardless of scope filter', () => {
    const vault = seeded();
    expect(vault.list({ allowedScopes: ['personal', 'work'] })).toHaveLength(2);
    // Asking for a scope OUTSIDE the grant returns nothing (not a leak).
    expect(vault.list({ scope: 'client:henderson', allowedScopes: ['personal'] })).toHaveLength(0);
    // Empty allowlist = no access.
    expect(vault.list({ allowedScopes: [] })).toHaveLength(0);
    // Undefined allowlist = full owner access.
    expect(vault.list()).toHaveLength(4);
    vault.close();
  });

  it('retrieve cannot cross a scope grant', () => {
    const vault = seeded();
    // A connection granted only 'personal' cannot retrieve client matter.
    expect(vault.retrieve('matter detail', { allowedScopes: ['personal'] })).toHaveLength(0);
    expect(vault.retrieve('henderson', { allowedScopes: ['client:henderson'] })).toHaveLength(1);
    expect(vault.retrieve('matter detail', { allowedScopes: ['client:acme'] })[0]!.entry.scope).toBe('client:acme');
    vault.close();
  });

  it('forget refuses (as not-found) an entry outside the grant', () => {
    const vault = seeded();
    const henderson = vault.list({ scope: 'client:henderson' })[0]!;
    expect(() => vault.forget(henderson.id, ['personal'])).toThrow(/No memory found/);
    // Still there — the denial did not delete it.
    expect(vault.list({ scope: 'client:henderson' })).toHaveLength(1);
    // An empty grant can forget nothing.
    expect(() => vault.forget(henderson.id, [])).toThrow(/No memory found/);
    // With the right grant it works.
    expect(vault.forget(henderson.id, ['client:henderson']).forgotten_at).not.toBeNull();
    vault.close();
  });

  it('scopes() enumerates distinct live scopes', () => {
    const vault = seeded();
    expect(vault.scopes()).toEqual(['client:acme', 'client:henderson', 'personal', 'work']);
    vault.close();
  });
});

describe('schema migration 0.1 → 0.2', () => {
  it('adds the tombstone column and rehashes the chain', () => {
    const vault = createVault();
    vault.remember({ content: 'pre-migration entry', type: 'semantic' });
    // Downgrade the vault to look like a 0.1 file (no forgotten_at column).
    const db = (vault as unknown as { db: import('better-sqlite3').Database }).db;
    db.exec('ALTER TABLE memories DROP COLUMN forgotten_at');
    db.prepare("UPDATE vault_meta SET value = '0.1' WHERE key = 'schema_version'").run();
    vault.save();
    vault.close();

    const reopened = openVault(); // migration runs inside open
    const exported = reopened.export();
    expect(exported.northkeep_export.schema_version).toBe('0.2');
    expect(reopened.verifyChain().ok).toBe(true);
    expect(reopened.list()[0]!.forgotten_at).toBeNull();
    reopened.close();
  });
});

describe('export', () => {
  it('matches the schema spec shape and passes chain verification', () => {
    const vault = createVault();
    vault.remember({ content: 'exported fact', type: 'identity', metadata: { origin: 'test' } });
    const doc = vault.export();
    expect(doc.northkeep_export.schema_version).toBe('0.2');
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
