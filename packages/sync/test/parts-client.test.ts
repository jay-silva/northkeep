import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, deriveMasterKey, KDF_INTERACTIVE } from '@northkeep/core';
import { setSyncServer } from '../src/config.js';
import { deriveSyncCreds, tokenHash } from '../src/creds.js';
import { pullVault, pushVault, syncState } from '../src/client.js';

/**
 * ADR 0078 client side, against the real sync-server handler (built dist,
 * in-memory storage) behind a small proxy that lets a test act between parts.
 */

const serverLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/sync-server/dist/lib.js');
const MiB = 1024 * 1024;
const passphrase = 'parts client passphrase';
const deviceSecret = Buffer.alloc(32, 78);

type Hook = (req: IncomingMessage) => Promise<{ status: number; body?: string } | void>;

let homeA: string;
let homeB: string;
let inner: Server;
let proxy: Server;
let proxyUrl = '';
let hook: Hook = async () => {};
let storage: { get(h: string): Promise<{ uploadId: string | null; parts: number } | null> };

const vaultPath = (home: string): string => path.join(home, 'vault.nkv');
const keyFor = (home: string): Buffer => {
  const header = Vault.readHeader(vaultPath(home));
  return deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
};

/** Random memory text does not shrink, so the file grows by about 100 KB per entry. */
function growVault(home: string, targetBytes: number, create: boolean): void {
  const v = create
    ? Vault.create({ path: vaultPath(home), passphrase, deviceSecret, kdf: KDF_INTERACTIVE })
    : Vault.open({ path: vaultPath(home), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  try {
    v.remember({ content: `marker ${home}`, type: 'semantic' });
    v.save();
    while (fs.statSync(vaultPath(home)).size < targetBytes) {
      for (let i = 0; i < 20; i++) v.remember({ content: randomBytes(48 * 1024).toString('base64'), type: 'semantic' });
      v.save();
    }
  } finally {
    v.close();
  }
}

async function forward(req: IncomingMessage, body: Buffer): Promise<Response> {
  const init: RequestInit = { method: req.method, headers: req.headers as Record<string, string> };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = body;
  return fetch(`http://127.0.0.1:${(inner.address() as { port: number }).port}${req.url}`, init);
}

beforeEach(async () => {
  expect(fs.existsSync(serverLib), 'run pnpm build first').toBe(true);
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-partsA-'));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-partsB-'));
  const { createSyncServer, InMemoryStorage } = await import(serverLib);
  storage = new InMemoryStorage();
  inner = createSyncServer(storage);
  await new Promise<void>((r) => inner.listen(0, '127.0.0.1', r));
  hook = async () => {};
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const early = await hook(req);
      if (early) {
        res.writeHead(early.status, { 'content-type': 'application/json' }).end(early.body ?? '{}');
        return;
      }
      const out = await forward(req, Buffer.concat(chunks));
      const headers: Record<string, string> = {};
      out.headers.forEach((v, k) => (headers[k] = v));
      delete headers['content-encoding'];
      delete headers['content-length'];
      res.writeHead(out.status, headers).end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => inner.close(() => r()));
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
});

function useHome(home: string): void {
  process.env.NORTHKEEP_HOME = home;
  setSyncServer(proxyUrl, deriveSyncCreds(deviceSecret).accountId);
}

describe('vaults over 4 MiB sync in parts (ADR 0078)', () => {
  it('pushes a 20 MiB vault in parts and a second device pulls the same bytes', async () => {
    growVault(homeA, 20 * MiB, true);
    useHome(homeA);
    const pushed = await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
    expect(pushed.ok).toBe(true);
    expect(pushed.size).toMatchObject({ cap_bytes: 32 * MiB, over_single_request: true, over_cap: false });
    const row = await storage.get(tokenHashOf());
    expect(row?.uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.parts).toBe(Math.ceil(fs.statSync(vaultPath(homeA)).size / (3 * MiB)));

    useHome(homeB);
    const pulled = await pullVault({ vaultPath: vaultPath(homeB), deviceSecret });
    expect(pulled.ok).toBe(true);
    expect(fs.readFileSync(vaultPath(homeB)).equals(fs.readFileSync(vaultPath(homeA)))).toBe(true);
    const opened = Vault.open({ path: vaultPath(homeB), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    expect(opened.list().some((m) => m.content === `marker ${homeA}`)).toBe(true);
    opened.close();
    expect((await syncState({ vaultPath: vaultPath(homeB), deviceSecret })).state).toBe('in-sync');
  }, 120_000);

  it('a pull that spans another push still gets one whole version', async () => {
    growVault(homeA, 10 * MiB, true);
    useHome(homeA);
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    const first = fs.readFileSync(vaultPath(homeA));

    // Mid-download, the other device pushes a bigger vault.
    let pushedDuring = false;
    hook = async (req) => {
      if (!pushedDuring && req.method === 'GET' && /\/parts\/1$/.test(req.url ?? '')) {
        pushedDuring = true;
        growVault(homeA, 14 * MiB, false);
        process.env.NORTHKEEP_HOME = homeA;
        const r = await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
        expect(r.ok).toBe(true);
        process.env.NORTHKEEP_HOME = homeB;
      }
    };
    useHome(homeB);
    const pulled = await pullVault({ vaultPath: vaultPath(homeB), deviceSecret });
    expect(pushedDuring).toBe(true);
    expect(pulled.ok).toBe(true);
    expect(fs.readFileSync(vaultPath(homeB)).equals(first)).toBe(true);
  }, 120_000);

  it('keeps the sync lock fresh between parts, so a slow push is never taken for abandoned', async () => {
    growVault(homeA, 10 * MiB, true);
    useHome(homeA);
    const lock = `${vaultPath(homeA)}.sync.lock`;
    const seen: number[] = [];
    hook = async (req) => {
      if (req.method === 'PUT' && /\/api\/blob\/uploads\/[0-9a-f]{32}\/\d+$/.test(req.url ?? '')) {
        seen.push(fs.statSync(lock).mtimeMs);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  }, 120_000);

  it('says plainly when the server predates parts sync, and changes nothing', async () => {
    growVault(homeA, 5 * MiB, true);
    useHome(homeA);
    hook = async (req) => (req.url === '/api/blob/uploads' ? { status: 404, body: '{"error":"Not found."}' } : undefined);
    await expect(pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).rejects.toThrow(
      /only takes vaults up to 4 MB/,
    );
    expect(await storage.get(tokenHashOf())).toBeNull();
  }, 120_000);
});

/** The server keys rows by the token's hash (apps/sync-server/src/handler.ts). */
function tokenHashOf(): string {
  return tokenHash(deriveSyncCreds(deviceSecret).token);
}
