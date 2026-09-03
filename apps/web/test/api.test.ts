import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

// A disk-free session: /api/unlock parses the JSON body BEFORE any vault access,
// so these hit the parse path without a real vault on disk.
function newSession(): UiSession {
  return new UiSession('/tmp/northkeep-api-test.nkv');
}

describe('handleApi malformed JSON', () => {
  it('returns 400 (bad request), not the 500 fallback, on malformed JSON', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/unlock',
      new URLSearchParams(),
      Buffer.from('{ not valid json'),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON body.' });
  });

  it('still validates well-formed bodies normally (400 for a missing field)', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/unlock',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({})),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Passphrase required.' });
  });
});

describe('handleApi Connect targets (M15)', () => {
  it('POST /api/connect/unknown returns 400', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/connect/not-a-target',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ scopes: [] })),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Unknown target/i);
  });
});

describe('handleApi review pass (ADR 0043)', () => {
  const prevHome = process.env.NORTHKEEP_HOME;
  let dir: string | undefined;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = prevHome;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unknown review routes return 404', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/accept-all',
      new URLSearchParams(),
      Buffer.from('{}'),
    );
    expect(res.status).toBe(404);
    const missing = await handleApi(
      newSession(),
      'GET',
      '/api/review/no-such-route',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(missing.status).toBe(404);
  });

  it('GET /api/review/report is 404 when no report exists', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'GET',
      '/api/review/report',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(res.status).toBe(404);
  });

  it('GET /api/review/api-options returns an endpoints list', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'GET',
      '/api/review/api-options',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { endpoints: unknown[] }).endpoints)).toBe(true);
  });

  it('POST /api/review/preflight unknown endpoint is 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/preflight',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ endpoint_id: 'no-such-endpoint' })),
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/review/run mode=api with a loopback endpoint is 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    fs.writeFileSync(
      path.join(dir, 'providers.json'),
      `${JSON.stringify({
        endpoints: [
          {
            id: 'local-ollama',
            label: 'Local Ollama',
            baseUrl: 'http://127.0.0.1:11434',
            model: 'qwen2.5:14b',
            kind: 'openai-compatible',
            hasKey: false,
          },
        ],
      }, null, 2)}\n`,
    );
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(
        JSON.stringify({
          mode: 'api',
          endpoint_id: 'local-ollama',
          selection_fingerprint: 'abc',
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/That endpoint is local/);
  });

  it('POST /api/review/run mode=api without a fingerprint is 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ mode: 'api', endpoint_id: 'openai-test' })),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/selection_fingerprint/);
  });

  it('POST /api/review/run with no body stays on the local path', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(''),
    );
    // Local path: started job (200), locked (423), or no vault on this
    // throwaway session (500). Never an API-path 400, never a silent hop.
    expect(res.status).not.toBe(400);
    const err = (res.body as { error?: string }).error ?? '';
    expect(err).not.toMatch(/endpoint_id|selection_fingerprint|That endpoint is local/);
    if (res.status === 200) {
      expect((res.body as { job_id?: string }).job_id).toEqual(expect.any(String));
    }
  });
});

describe('handleApi contract targets (M16)', () => {
  it('POST /api/contract/install/unknown returns 400', async () => {
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/contract/install/cursor',
      new URLSearchParams(),
      Buffer.from('{}'),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/Unknown target/i);
  });
});

// ---------- automatic sync (ADR 0044) ----------

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { KDF_INTERACTIVE, Vault, setPlatform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { deriveSyncCreds, setSyncServer } from '@northkeep/sync';

/** A one-blob ciphertext-only server with the real wire contract (see packages/sync/test/auto.test.ts). */
function fakeSyncServer(): { server: Server; url: () => string; version: () => number } {
  let blob: Buffer | null = null;
  let version = 0;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/status') {
        if (blob === null) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ version, sha256: sha(blob), size: blob.length, updatedAt: new Date().toISOString() }));
      }
      if (req.method === 'GET' && req.url === '/api/blob') {
        if (blob === null) return void res.writeHead(404).end();
        res.writeHead(200, { 'x-version': String(version), 'x-sha256': sha(blob) });
        return void res.end(blob);
      }
      if (req.method === 'PUT' && req.url === '/api/blob') {
        const base = Number(req.headers['x-base-version'] ?? '0');
        if (base !== version) {
          res.writeHead(409, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ version }));
        }
        blob = Buffer.concat(chunks);
        version += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ version }));
      }
      res.writeHead(404).end();
    });
  });
  return { server, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, version: () => version };
}

describe('handleApi automatic sync (ADR 0044)', () => {
  const prevHome = process.env.NORTHKEEP_HOME;
  const passphrase = 'web auto sync passphrase';
  const deviceSecret = Buffer.alloc(32, 9);
  let dir: string;
  let fake: ReturnType<typeof fakeSyncServer>;
  let session: UiSession;

  const call = (method: string, route: string, body: unknown = '') =>
    handleApi(session, method, route, new URLSearchParams(), Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));

  beforeEach(async () => {
    setPlatform(nodePlatform());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-auto-'));
    process.env.NORTHKEEP_HOME = dir;
    fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
    const vaultPath = path.join(dir, 'vault.nkv');
    const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.remember({ content: 'seed', type: 'semantic' });
    v.save();
    v.close();
    session = new UiSession(vaultPath);
    fake = fakeSyncServer();
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    session.autoSync.stop();
    session.lock();
    await new Promise((r) => fake.server.close(r));
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/status carries sync_auto with phase off while sync is unconfigured', async () => {
    await session.unlock(passphrase);
    const res = await call('GET', '/api/status');
    expect(res.status).toBe(200);
    const auto = (res.body as { sync_auto: { phase: string; age: string | null } }).sync_auto;
    expect(auto.phase).toBe('off');
    expect(auto.age).toBeNull();
  });

  it('POST /api/sync/wake is 423 while locked (verification needs the key)', async () => {
    setSyncServer(fake.url(), deriveSyncCreds(deviceSecret).accountId);
    // An explicit lock also suppresses an ambient key (Keychain/env) on the dev machine.
    session.lock();
    const res = await call('POST', '/api/sync/wake');
    expect(res.status).toBe(423);
    expect(fake.version()).toBe(0);
  });

  it('a wake on an empty server pushes the vault and reports the sync time', async () => {
    setSyncServer(fake.url(), deriveSyncCreds(deviceSecret).accountId);
    await session.unlock(passphrase);
    const res = await call('POST', '/api/sync/wake');
    expect(res.status).toBe(200);
    const body = res.body as { pulled: boolean; phase: string; lastSyncedAt: string | null; age: string | null };
    expect(fake.version()).toBe(1);
    expect(body.pulled).toBe(false);
    expect(body.phase).toBe('synced');
    expect(body.lastSyncedAt).toBeTruthy();
    expect(body.age).toBe('just now');
    // And the lightweight route agrees without opening the vault.
    const auto = await call('GET', '/api/sync/auto');
    expect((auto.body as { phase: string }).phase).toBe('synced');
  });

  it('a manual push through the route runs inside the engine and leaves it synced', async () => {
    setSyncServer(fake.url(), deriveSyncCreds(deviceSecret).accountId);
    await session.unlock(passphrase);
    const res = await call('POST', '/api/sync/push');
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean; version: number })).toMatchObject({ ok: true, version: 1 });
    expect(session.autoSync.status().phase).toBe('synced');
    // A second wake finds nothing to do: still one version on the server.
    await call('POST', '/api/sync/wake');
    expect(fake.version()).toBe(1);
  });
});
