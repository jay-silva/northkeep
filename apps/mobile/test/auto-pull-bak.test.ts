import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ADR 0044, SEVENTH REVIEW FLESH WOUND: an AUTOMATIC pull on the phone kept no
 * durable copy of the vault it displaced. The storage seam's rolling
 * `${path}.bak` is not one: the very next save rewrites it, so a wake pull the
 * user wanted to undo an hour later left nothing behind. The desktop already
 * keeps a `.auto-pull.bak`; this is the phone's.
 *
 * The whole install sequence runs here (pullVaultMobile -> installPulledBlob),
 * over a faked transport, a faked digest and an fs-backed platform seam whose
 * writeAtomic honours the seam contract (displaced image to `${path}.bak`).
 * That contract is what makes the last assertion meaningful: a later save rolls
 * `.bak` and `.auto-pull.bak` must survive it. Vault.openWithKey is stubbed:
 * this test is about which files exist afterwards, not about crypto.
 */

const files = new Map<string, Buffer>();
const DOCUMENT_DIR = '/doc';
const CACHE_DIR = '/cache';
const VAULT_PATH = `${DOCUMENT_DIR}/vault.nkv`;

vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(a: string | { toString(): string }, b?: string) {
      this.uri = b === undefined ? String(a) : `${String(a)}/${b}`;
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    delete(): void {
      files.delete(this.uri);
    }
  }
  return { File, Paths: { document: DOCUMENT_DIR, cache: CACHE_DIR } };
});

const keychain = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  setItemAsync: async (key: string, value: string) => {
    keychain.set(key, value);
  },
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  deleteItemAsync: async (key: string) => {
    keychain.delete(key);
  },
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, data: Uint8Array) =>
    new Uint8Array(createHash('sha256').update(data).digest()).buffer,
}));

/** The blob the faked server hands back, and the headers it sends with it. */
let remoteBlob: Buffer = Buffer.alloc(0);
let remoteVersion = 1;
vi.mock('expo/fetch', () => ({
  fetch: async (url: string) => {
    if (!url.endsWith('/api/blob')) throw new Error(`unexpected request: ${url}`);
    return {
      status: 200,
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-version'
            ? String(remoteVersion)
            : name.toLowerCase() === 'x-sha256'
              ? sha256Hex(remoteBlob)
              : null,
      },
      arrayBuffer: async () => new Uint8Array(remoteBlob).buffer,
    };
  },
}));

vi.mock('@northkeep/sync', () => ({
  MAX_BLOB_BYTES: 50 * 1024 * 1024,
  deriveSyncCreds: () => ({ token: 'test-token' }),
  SubscriptionRequiredError: class SubscriptionRequiredError extends Error {},
}));

vi.mock('@northkeep/core', () => ({
  VaultAuthError: class VaultAuthError extends Error {},
  VaultSyncGenerationError: class VaultSyncGenerationError extends Error {},
  Vault: {
    // The blob "opens" and reports a generation above the phone's baseline.
    openWithKey: () => ({ getSyncGeneration: () => 5, close: () => {} }),
  },
  getPlatform: () => ({
    storage: {
      exists: (path: string) => files.has(path),
      readBytes: (path: string) => files.get(path)!,
      writeAtomic: (path: string, bytes: Buffer | Uint8Array) => {
        // THE SEAM CONTRACT: the displaced image goes to `${path}.bak`, and it
        // is rewritten by every later write. That is exactly why the durable
        // copy has to be a different file.
        const existing = files.get(path);
        if (existing) files.set(`${path}.bak`, existing);
        files.set(path, Buffer.from(bytes));
      },
    },
  }),
}));

const { pullVaultMobile } = await import('../src/lib/sync.js');
const { autoPullBakPath } = await import('../src/lib/paths.js');
const { saveSyncBaseline, loadSyncBaseline, loadLocalDirty, saveLocalDirty } = await import(
  '../src/lib/secure-store.js'
);

function nkv(tag: string, size = 128): Buffer {
  const blob = Buffer.alloc(size, 0);
  blob.write('NKV1', 0, 'ascii');
  blob.write(tag, 8, 'ascii');
  return blob;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const AUTO_PULL_BAK = `${VAULT_PATH}.auto-pull.bak`;

async function install(keepDisplacedCopy?: boolean) {
  return pullVaultMobile({
    serverUrl: 'https://sync.example.test',
    deviceSecretHex: '00'.repeat(32),
    vaultPath: VAULT_PATH,
    masterKey: Buffer.alloc(32),
    keepDisplacedCopy,
  });
}

beforeEach(async () => {
  files.clear();
  keychain.clear();
  remoteBlob = nkv('server', 200);
  remoteVersion = 4;
});

describe('autoPullBakPath', () => {
  it('is the vault path plus .auto-pull.bak', () => {
    expect(autoPullBakPath(VAULT_PATH)).toBe(`${DOCUMENT_DIR}/vault.nkv.auto-pull.bak`);
  });
});

describe('an automatic pull keeps a durable copy of what it displaced', () => {
  it('the copy holds the PRE-install bytes, and a later save leaves it intact', async () => {
    const before = nkv('local', 160);
    files.set(VAULT_PATH, before);
    await saveSyncBaseline({ version: 3, sha: sha256Hex(before), generation: 2, pendingStampSha: null });

    const result = await install(true);
    expect(result).toMatchObject({ ok: true, version: 4, wroteVault: true });

    // The server's copy is installed, and the displaced vault is at BOTH the
    // rolling .bak and the durable copy.
    expect(files.get(VAULT_PATH)!.equals(remoteBlob)).toBe(true);
    expect(files.get(AUTO_PULL_BAK)!.equals(before)).toBe(true);
    expect(files.get(`${VAULT_PATH}.bak`)!.equals(before)).toBe(true);

    // A later save (any vault write through the seam) rolls .bak forward. The
    // durable copy is the one that survives, which is the whole point.
    const afterSave = nkv('edited', 176);
    const { getPlatform } = await import('@northkeep/core');
    getPlatform().storage.writeAtomic(VAULT_PATH, afterSave);
    expect(files.get(`${VAULT_PATH}.bak`)!.equals(remoteBlob)).toBe(true); // rolled
    expect(files.get(AUTO_PULL_BAK)!.equals(before)).toBe(true); // intact
  });

  it('the manual pull keeps today behaviour: no durable copy', async () => {
    // memories.tsx calls session.pullAndReload() with no arguments, so the flag
    // is undefined here. The user asked for the replacement and was warned when
    // anything was unpushed; the rolling .bak still holds the displaced vault.
    const before = nkv('local', 160);
    files.set(VAULT_PATH, before);
    await saveSyncBaseline({ version: 3, sha: sha256Hex(before), generation: 2, pendingStampSha: null });

    await install();

    expect(files.has(AUTO_PULL_BAK)).toBe(false);
    expect(files.get(`${VAULT_PATH}.bak`)!.equals(before)).toBe(true);
  });

  it('a fresh phone has nothing to copy, and no empty .auto-pull.bak is created', async () => {
    const result = await install(true);
    expect(result).toMatchObject({ ok: true, wroteVault: true });
    expect(files.has(AUTO_PULL_BAK)).toBe(false);
  });

  it('the copy is made only on the success path: a moved file aborts before it', async () => {
    const before = nkv('local', 160);
    files.set(VAULT_PATH, before);
    await saveSyncBaseline({ version: 3, sha: sha256Hex(before), generation: 2, pendingStampSha: null });
    await saveLocalDirty(true);

    // The wake decided on OTHER bytes: a save landed during the download.
    await expect(
      pullVaultMobile({
        serverUrl: 'https://sync.example.test',
        deviceSecretHex: '00'.repeat(32),
        vaultPath: VAULT_PATH,
        masterKey: Buffer.alloc(32),
        expectLocalSha: sha256Hex(nkv('stale', 160)),
        keepDisplacedCopy: true,
      }),
    ).rejects.toThrow(/changed while the download ran/);

    // Nothing written at all: not the vault, not the copy, not the bookkeeping.
    expect(files.get(VAULT_PATH)!.equals(before)).toBe(true);
    expect(files.has(AUTO_PULL_BAK)).toBe(false);
    expect(await loadLocalDirty()).toBe(true);
    expect((await loadSyncBaseline())?.version).toBe(3);
  });
});
