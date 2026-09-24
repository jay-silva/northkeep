import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KDF_INTERACTIVE, Vault, ensureDeviceSecret, generateDeviceSecret } from '@northkeep/core';
import { assembleReviewReport, loadReviewReport, proposalFingerprint, saveReviewReport } from '@northkeep/librarian';
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

  it('GET /api/review/report is locked before checking report existence', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    // An ambient key source (a Keychain entry on the developer's Mac, or an
    // exported passphrase) counts as an unlock, and the session then opens the
    // vault instead of refusing. Cut every ambient source for this test.
    const grants = {
      NORTHKEEP_PASSPHRASE: process.env.NORTHKEEP_PASSPHRASE,
      NORTHKEEP_MASTER_KEY: process.env.NORTHKEEP_MASTER_KEY,
      NORTHKEEP_NO_KEYCHAIN: process.env.NORTHKEEP_NO_KEYCHAIN,
    };
    delete process.env.NORTHKEEP_PASSPHRASE;
    delete process.env.NORTHKEEP_MASTER_KEY;
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
    // A real vault that this session never unlocks: the route reads the header
    // before the lock check, so a missing file was a 500, not a 423.
    const vaultPath = path.join(dir, 'vault.nkv');
    Vault.create({ path: vaultPath, passphrase: 'pw', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE }).close();
    onTestFinished(() => {
      for (const [k, v] of Object.entries(grants)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const res = await handleApi(
      new UiSession(vaultPath),
      'GET',
      '/api/review/report',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(res.status).toBe(423);
  });

  it('GET /api/review/report is 404 when unlocked and no report exists', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const vaultPath = path.join(dir, 'vault.nkv');
    const passphrase = 'a strong test passphrase';
    const { secret } = ensureDeviceSecret();
    Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
    const session = new UiSession(vaultPath);
    await session.unlock(passphrase);
    const res = await handleApi(session, 'GET', '/api/review/report', new URLSearchParams(), Buffer.alloc(0));
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
          scopes: ['personal'],
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

  it('POST /api/review/run requires explicit scopes without selecting a provider', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const res = await handleApi(
      newSession(),
      'POST',
      '/api/review/run',
      new URLSearchParams(),
      Buffer.from(''),
    );
    expect(res.status).toBe(400);
    const err = (res.body as { error?: string }).error ?? '';
    expect(err).not.toMatch(/endpoint_id|selection_fingerprint|That endpoint is local/);
    expect(err).toMatch(/scopes/);
  });

  it('POST per-proposal reject uses exact bindings and leaves vault memories unchanged', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-web-'));
    process.env.NORTHKEEP_HOME = dir;
    const vaultPath = path.join(dir, 'vault.nkv');
    const passphrase = 'a strong test passphrase';
    const { secret } = ensureDeviceSecret();
    const vault = Vault.create({
      path: vaultPath,
      passphrase: 'a strong test passphrase',
      deviceSecret: secret,
      kdf: KDF_INTERACTIVE,
    });
    try {
      const a = vault.remember({ content: 'Jay is a paramedic in Bourne.', type: 'semantic' });
      const b = vault.remember({ content: 'Jay is a paramedic in Bourne!', type: 'semantic' });
      vault.save();
      const before = JSON.stringify(vault.export().memories);
      const report = assembleReviewReport({
          model: 'fixture',
          started_at: '2026-09-09T00:00:00.000Z',
          entry_count: 2,
          drops: {},
          proposals: [
            {
              id: 'd0a0beb1',
              kind: 'duplicate',
              entry_ids: [a.id, b.id],
              quotes: [
                { entry_id: a.id, quote: a.content },
                { entry_id: b.id, quote: b.content },
              ],
              explanation: 'exact',
              target_entry_id: null,
              proposed_content: null,
              member_decisions: { [a.id]: 'pending', [b.id]: 'pending' },
              status: 'pending',
            },
          ],
          vault_id: vault.getVaultId(),
          vault_path: vaultPath,
          selected_scopes: ['personal'],
          source_entries: [a, b],
        });
      saveReviewReport(report, vaultPath);
      const session = new UiSession(vaultPath);
      await session.unlock(passphrase);
      const out = await handleApi(
        session,
        'POST',
        '/api/review/d0a0beb1/reject',
        new URLSearchParams(),
        Buffer.from(JSON.stringify({
          report_id: report.report_id,
          proposal_fingerprint: proposalFingerprint(report.proposals[0]!),
          operation_id: randomUUID(),
        })),
      );
      expect(out.status).toBe(200);
      expect((out.body as { ok: boolean }).ok).toBe(true);
      expect(JSON.stringify(vault.export().memories)).toBe(before);
      const loaded = loadReviewReport(vaultPath);
      expect(loaded?.proposals[0]?.status).toBe('rejected');
    } finally {
      vault.close();
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
import { setPlatform } from '@northkeep/core';
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

// --- ADR 0050 Decision 5: the desktop sync folds before it reads the list ---

import { vi } from 'vitest';
import { emptyProjectDoc, mergeProjectDoc, serializeProjectDoc } from '@northkeep/core/project-doc';
import { holdMessage, markConnectorPaired, setConnectorServer } from '@northkeep/sync';

function projectMarkdown(status: string): string {
  return serializeProjectDoc(
    mergeProjectDoc(emptyProjectDoc(), { whatWhy: 'Made in a connected app.', status, logEntry: 'Seeded.' }),
  );
}

/** Records every request and answers the three connector routes the sync touches. */
function stubConnector(entries: Array<{ server_id: string; scope: string; type: string; content: string }>): {
  calls: string[];
  puts: Array<{ scopes: string[]; entries: Array<{ scope: string }> }>;
} {
  const calls: string[] = [];
  const puts: Array<{ scopes: string[]; entries: Array<{ scope: string }> }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/client/pending')) {
      return new Response(JSON.stringify({ entries, forgets: [] }), { status: 200 });
    }
    if (url.endsWith('/client/ack')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.endsWith('/client/entries')) {
      puts.push(JSON.parse(String(init?.body ?? '{}')) as { scopes: string[]; entries: Array<{ scope: string }> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith('/pair/start')) {
      return new Response(JSON.stringify({ pairing_code: 'ABCD1234' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { calls, puts };
}

describe('POST /api/share/sync and /api/share/pair (ADR 0050 Decision 5)', () => {
  const prevHome = process.env.NORTHKEEP_HOME;
  const passphrase = 'web share sync passphrase';
  const deviceSecret = Buffer.alloc(32, 7);
  let dir: string;
  let session: UiSession;

  const call = (method: string, route: string, body: unknown = '') =>
    handleApi(session, method, route, new URLSearchParams(), Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));

  beforeEach(async () => {
    setPlatform(nodePlatform());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-share-'));
    process.env.NORTHKEEP_HOME = dir;
    fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
    const vaultPath = path.join(dir, 'vault.nkv');
    const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.save();
    v.close();
    session = new UiSession(vaultPath);
    setConnectorServer('http://127.0.0.1:9');
    await session.unlock(passphrase);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    session.autoSync.stop();
    session.lock();
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is 400 with nothing shared only when this device never paired, and calls nothing', async () => {
    const { calls } = stubConnector([]);
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('No scopes are shared yet.');
    expect(calls).toEqual([]);
  });

  it('folds and pushes the newly marked scope in the same run once this device has paired', async () => {
    markConnectorPaired();
    const { puts } = stubConnector([
      {
        server_id: 'conn_create_1',
        scope: 'project:hosted-thing',
        type: 'working',
        content: projectMarkdown('Started in the app.'),
      },
    ]);
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(200);
    const body = res.body as { added: number; held: number; scopes: string[] };
    expect(body.added).toBe(1);
    expect(body.held).toBe(0);
    expect(body.scopes).toContain('project:hosted-thing');
    expect((res.body as { newly_shared: string[] }).newly_shared).toEqual(['project:hosted-thing']);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.scopes).toContain('project:hosted-thing');
  });

  it('reports a held scope with its message and skips the push when nothing ended up shared', async () => {
    markConnectorPaired();
    await session.withVault((vault) => {
      vault.remember({ content: 'Private note.', type: 'episodic', scope: 'project:held-one' });
      vault.save();
    });
    const { puts } = stubConnector([
      {
        server_id: 'conn_create_2',
        scope: 'project:held-one',
        type: 'working',
        content: projectMarkdown('From the app.'),
      },
    ]);
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(200);
    const body = res.body as { held: number; held_scopes: string[]; held_messages: string[]; pushed: number };
    expect(body.held).toBe(1);
    expect(body.held_scopes).toEqual(['project:held-one']);
    expect(body.held_messages).toEqual([holdMessage('held-one')]);
    expect(body.pushed).toBe(0);
    expect(puts).toEqual([]);
  });

  it('returns the skipped count so a dropped row is never silent', async () => {
    markConnectorPaired();
    await session.withVault((vault) => {
      vault.setScopeShared('work', true);
      vault.save();
    });
    stubConnector([{ server_id: 'conn_bad', scope: 'work', type: 'Working', content: 'Not a stored type.' }]);
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(200);
    expect((res.body as { skipped: number }).skipped).toBe(1);
  });

  it('reports whether this device has paired, so the GUI can enable Sync with nothing shared', async () => {
    const before = await call('GET', '/api/share/status');
    expect((before.body as { paired: boolean; shared_scopes: string[] }).paired).toBe(false);
    expect((before.body as { shared_scopes: string[] }).shared_scopes).toEqual([]);
    markConnectorPaired();
    const after = await call('GET', '/api/share/status');
    expect((after.body as { paired: boolean }).paired).toBe(true);
  });

  it('treats a legacy pairing (connector.json with only the server) as paired: status and sync agree', async () => {
    fs.writeFileSync(path.join(dir, 'connector.json'), `${JSON.stringify({ server: 'http://127.0.0.1:9' })}\n`, { mode: 0o600 });
    const status = await call('GET', '/api/share/status');
    expect((status.body as { paired: boolean }).paired).toBe(true);
    const { puts } = stubConnector([
      { server_id: 'conn_create_legacy', scope: 'project:legacy-proj', type: 'working', content: projectMarkdown('From 0.21.') },
    ]);
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(200);
    expect((res.body as { scopes: string[] }).scopes).toContain('project:legacy-proj');
    expect(puts).toHaveLength(1);
  });

  it('records the pairing so the next sync folds from an empty shared list', async () => {
    stubConnector([]);
    const res = await call('POST', '/api/share/pair');
    expect(res.status).toBe(200);
    const after = await call('POST', '/api/share/sync');
    expect(after.status).toBe(200);
  });
});
