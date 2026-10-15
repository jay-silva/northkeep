import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import type { Embedder } from '../src/types.js';
import { Vault } from '../src/vault.js';

/**
 * ADR 0067: embeddings never reach the vault file, a pre-0067 embeddings table
 * is dropped on the next save, and free pages are reclaimed, without changing
 * the chain or the order entries list in.
 */

const PASSPHRASE = 'a strong test passphrase';
const DIMS = 768;
let dir: string;
let vaultPath: string;
let deviceSecret: Buffer;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-size-'));
  vaultPath = path.join(dir, 'vault.nkv');
  deviceSecret = generateDeviceSecret();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const embedder: Embedder = {
  model: 'nomic-embed-text',
  async embed(text: string): Promise<number[]> {
    const h = createHash('sha256').update(text).digest();
    return Array.from({ length: DIMS }, (_, k) => ((h[k % 32]! ^ k) & 255) / 255 - 0.5);
  },
};

const open = (): Vault => Vault.open({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret });
const size = (): number => fs.statSync(vaultPath).size;
const sha = (): string => createHash('sha256').update(fs.readFileSync(vaultPath)).digest('hex');
const db = (v: Vault): { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown }; transaction<T>(fn: () => T): () => T } =>
  (v as unknown as { db: ReturnType<typeof db> }).db;

function seeded(n: number): Vault {
  const v = Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE });
  for (let i = 0; i < n; i += 1) {
    v.remember({ content: `Memory ${i}: ${'the user keeps notes about coffee and meetings '.repeat(6)}`, type: 'semantic' });
  }
  v.save();
  return v;
}

/** Writes the vault the way a pre-0067 build did: a filled embeddings table in the image. */
function writeLegacyVault(n: number): void {
  const v = seeded(n);
  db(v).exec(`CREATE TABLE embeddings (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL,
    PRIMARY KEY (memory_id, model))`);
  const insert = db(v).prepare('INSERT INTO embeddings VALUES (?, ?, ?, ?)');
  for (const e of v.list()) insert.run(e.id, 'nomic-embed-text', DIMS, Buffer.alloc(DIMS * 4, 7));
  const proto = Vault.prototype as unknown as { compactImage: () => void };
  const real = proto.compactImage;
  proto.compactImage = () => {};
  try {
    v.save();
  } finally {
    proto.compactImage = real;
  }
  v.close();
}

describe('embeddings stay out of the vault file (ADR 0067 D1)', () => {
  it('a vault saved after a semantic search carries no embeddings table and does not grow', async () => {
    const v = seeded(200);
    const before = size();
    await v.retrieveSemantic('coffee meetings', embedder);
    v.remember({ content: 'one more', type: 'semantic' });
    v.save();
    v.close();
    expect(size()).toBeLessThan(before + 4096);
    const reopened = open();
    expect(reopened.hasLegacyEmbeddingsTable()).toBe(false);
    reopened.close();
  });

  it('a new vault has no embeddings table at all', () => {
    const v = seeded(1);
    expect(v.hasLegacyEmbeddingsTable()).toBe(false);
    v.close();
  });
});

describe('a pre-0067 vault (ADR 0067 D2)', () => {
  it('opening alone changes nothing on disk', () => {
    writeLegacyVault(100);
    const before = sha();
    const v = open();
    expect(v.hasLegacyEmbeddingsTable()).toBe(true);
    v.list();
    v.close();
    expect(sha()).toBe(before);
  });

  it('the next save drops the table, shrinks the file, and keeps the chain and list order', () => {
    writeLegacyVault(200);
    const legacySize = size();
    const v = open();
    const order = v.list().map((e) => e.id);
    const exportBefore = JSON.stringify(v.export().memories);
    v.save();
    v.close();
    expect(size()).toBeLessThan(legacySize / 3);
    const after = open();
    expect(after.hasLegacyEmbeddingsTable()).toBe(false);
    expect(after.verifyChain()).toEqual({ ok: true });
    expect(after.list().map((e) => e.id)).toEqual(order);
    expect(JSON.stringify(after.export().memories)).toBe(exportBefore);
    after.close();
  });
});

describe('free pages are reclaimed on save (ADR 0067 D3)', () => {
  it('forgetting most long memories shrinks the file, chain and order intact', () => {
    // Long entries spill onto overflow pages, which a forget frees outright.
    const v = Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret, kdf: KDF_INTERACTIVE });
    for (let i = 0; i < 60; i += 1) v.remember({ content: `Long note ${i}: ${'x'.repeat(6000)}`, type: 'semantic' });
    v.save();
    const full = size();
    const ids = v.list().map((e) => e.id);
    for (const id of ids.slice(0, 45)) v.forget(id, { actor: 'owner' });
    v.remember({ content: 'written after the forgets', type: 'semantic' });
    const order = v.list({ includeForgotten: true }).map((e) => e.id);
    v.save();
    v.close();
    expect(size()).toBeLessThan(full / 2);
    const after = open();
    expect(after.verifyChain()).toEqual({ ok: true });
    expect(after.list({ includeForgotten: true }).map((e) => e.id)).toEqual(order);
    after.close();
  });

  it('a save after a single forget keeps the chain valid', () => {
    const v = seeded(50);
    const ids = v.list().map((e) => e.id);
    v.forget(ids[0]!, { actor: 'owner' });
    v.save();
    expect(v.verifyChain()).toEqual({ ok: true });
    v.close();
  });
});

describe('core never saves inside a transaction (ADR 0067 D3 invariant)', () => {
  it('save() refuses to run inside an open transaction', () => {
    const v = seeded(1);
    expect(() => db(v).transaction(() => v.save())()).toThrow(/inside a transaction/);
    v.close();
  });
});
