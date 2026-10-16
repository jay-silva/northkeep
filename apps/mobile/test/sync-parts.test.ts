import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSyncCreds, tokenHash } from '@northkeep/sync';

/**
 * ADR 0078 on the phone: the real transport (fetchRemoteBlob,
 * uploadPreparedMobile) against the real sync-server handler, with expo/fetch
 * swapped for Node's fetch. A hook runs before each request so a test can act
 * between parts. The server checks only the NKV1 magic, so the "vaults" here
 * are random bytes behind that header.
 */

const serverLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sync-server/dist/lib.js');
const MiB = 1024 * 1024;
const SECRET_HEX = '4e'.repeat(32);

let beforeRequest: (url: string, method: string) => Promise<void> = async () => {};
let blockUploads = false;

vi.mock('expo/fetch', () => ({
  fetch: async (url: string, init?: RequestInit) => {
    await beforeRequest(url, init?.method ?? 'GET');
    if (blockUploads && url.endsWith('/api/blob/uploads')) {
      return new Response('{"error":"Not found."}', { status: 404 });
    }
    return fetch(url, init);
  },
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest()).buffer,
}));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { document: '/doc', cache: '/cache' } }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'x',
  setItemAsync: async () => {},
  getItemAsync: async () => null,
  deleteItemAsync: async () => {},
}));

const { fetchRemoteBlob, uploadPreparedMobile } = await import('../src/lib/sync.js');

let server: Server;
let serverUrl = '';
let storage: { get(h: string): Promise<{ version: number; uploadId: string | null; parts: number } | null> };

function vaultBytes(size: number): Buffer {
  const b = randomBytes(size);
  b.write('NKV1', 0, 'ascii');
  return b;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function push(blob: Buffer, baseVersion: number) {
  return uploadPreparedMobile({
    serverUrl,
    deviceSecretHex: SECRET_HEX,
    prepared: { body: new Uint8Array(blob), sha256: sha(blob), generation: 1, baseVersion },
  });
}

const pull = () => fetchRemoteBlob({ serverUrl, deviceSecretHex: SECRET_HEX });
const row = () => storage.get(tokenHash(deriveSyncCreds(Buffer.from(SECRET_HEX, 'hex')).token));

beforeEach(async () => {
  expect(fs.existsSync(serverLib), 'run pnpm build first').toBe(true);
  const { createSyncServer, InMemoryStorage } = await import(serverLib);
  storage = new InMemoryStorage();
  server = createSyncServer(storage);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  beforeRequest = async () => {};
  blockUploads = false;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('phone sync over 4 MB (ADR 0078)', () => {
  it('pushes a 20 MB vault in parts and pulls back the same bytes', async () => {
    const blob = vaultBytes(20 * MiB);
    const pushed = await push(blob, 0);
    expect(pushed).toMatchObject({ ok: true, conflict: false, version: 1, sha256: sha(blob), generation: 1 });
    expect(await row()).toMatchObject({ version: 1, parts: 7 });
    const pulled = await pull();
    expect(pulled?.version).toBe(1);
    expect(pulled?.blob.equals(blob)).toBe(true);
  });

  it('still uses one request at 4 MB or less, and moves between the two shapes', async () => {
    const big = vaultBytes(6 * MiB);
    expect((await push(big, 0)).ok).toBe(true);
    const small = vaultBytes(MiB);
    expect(await push(small, 1)).toMatchObject({ ok: true, version: 2 });
    expect(await row()).toMatchObject({ uploadId: null, parts: 0 });
    expect((await pull())?.blob.equals(small)).toBe(true);
  });

  it('a stale base comes back as a conflict, not an error', async () => {
    expect((await push(vaultBytes(5 * MiB), 0)).ok).toBe(true);
    expect(await push(vaultBytes(5 * MiB), 0)).toEqual({ ok: false, conflict: true, version: 1 });
  });

  it('a pull that spans another device push still gets one whole version', async () => {
    const first = vaultBytes(10 * MiB);
    expect((await push(first, 0)).ok).toBe(true);
    let pushedDuring = false;
    beforeRequest = async (url) => {
      if (!pushedDuring && /\/parts\/1$/.test(url)) {
        pushedDuring = true;
        beforeRequest = async () => {};
        expect((await push(vaultBytes(12 * MiB), 1)).ok).toBe(true);
      }
    };
    const pulled = await pull();
    expect(pushedDuring).toBe(true);
    expect(pulled?.version).toBe(1);
    expect(pulled?.blob.equals(first)).toBe(true);
  });

  it('says plainly when the server predates parts sync', async () => {
    blockUploads = true;
    await expect(push(vaultBytes(5 * MiB), 0)).rejects.toThrow(/only takes vaults up to 4 MB/);
    expect(await row()).toBeNull();
  });
});
