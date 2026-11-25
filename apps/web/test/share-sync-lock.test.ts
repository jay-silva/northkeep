import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, setPlatform, withFileLock } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { pushSharedScopes, setConnectorServer } from '@northkeep/sync';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';
import { startFakeConnector, type FakeConnector } from '../../../packages/sync/test/fake-connector.js';

/**
 * Sync now fetches, applies and settles under the vault lock, each connector
 * call capped (defect B, two merge reviews). Temp home and fictional data only.
 */

const passphrase = 'web lock passphrase';
const deviceSecret = Buffer.alloc(32, 6);
const prevHome = process.env.NORTHKEEP_HOME;
let dir: string;
let vaultPath: string;
let session: UiSession;
let fake: FakeConnector;
let pushedId: string;

const call = async (method: string, route: string, body?: unknown) => {
  const res = await handleApi(session, method, route, new URLSearchParams(), Buffer.from(body === undefined ? '' : JSON.stringify(body)));
  return { status: res.status, body: res.body as Record<string, unknown> };
};
const syncNow = () => call('POST', '/api/share/sync', { dry_run: false, approve: {} });
const lockPath = () => `${vaultPath}.lock`;
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);
const key = () => {
  const header = Vault.readHeader(vaultPath);
  return deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
};
/** What is live in the vault file on disk, read fresh. */
const onDisk = () => {
  const v = Vault.openWithKey(vaultPath, key());
  try {
    return v.list().map((e) => `${e.scope}: ${e.content}`).sort();
  } finally {
    v.close();
  }
};
/** Another NorthKeep process saving one memory, with its own lock settings. */
const otherProcessSaves = (content: string, lock: { staleMs?: number; timeoutMs: number }) =>
  withFileLock(vaultPath, () => {
    const w = Vault.openWithKey(vaultPath, key());
    w.remember({ content, type: 'semantic', scope: 'personal' });
    w.save();
    w.close();
  }, lock).then(() => 'saved', (err: Error) => err.name);
/** Every connector request, with whether the vault lock file existed as it arrived. */
const watchLock = () => {
  const seen: Array<[string, boolean]> = [];
  fake.observe((request) => seen.push([request, fs.existsSync(lockPath())]));
  return seen;
};

beforeEach(async () => {
  setPlatform(nodePlatform());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-synclock-'));
  process.env.NORTHKEEP_HOME = dir;
  fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  vaultPath = path.join(dir, 'vault.nkv');
  fake = await startFakeConnector();
  setConnectorServer(fake.url());
  const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  v.setScopeShared('work', true);
  pushedId = v.remember({ content: 'Pushed memory', type: 'semantic', scope: 'work' }).id;
  v.save();
  await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: ['work'], vault: v });
  v.close();
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
  // No background push may take the lock while a test watches it.
  expect((await call('POST', '/api/share/auto-push', { enabled: false })).body.enabled).toBe(false);
  await call('GET', '/api/share/status'); // the one-time ADR 0038 fold, which saves
});
afterEach(async () => {
  fake.observe(null);
  session.autoSync.stop();
  session.connectorAutoPush.stop();
  session.lock();
  await fake.close();
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/share/sync: what runs under the vault lock', () => {
  it('the fetch and the acknowledgement start under the lock, and the push after is not under it', async () => {
    const fromApp = fake.cloudRemember('work', 'From the app');
    fake.cloudForget(pushedId);
    const seen = watchLock();
    const res = await call('POST', '/api/share/sync', { dry_run: false, approve: { forget_ids: [pushedId] } });
    expect([res.status, res.body.added, res.body.forgotten, res.body.deduped]).toEqual([200, 1, 1, 0]);
    expect(seen).toEqual([
      ['GET /client/pending?v=3', true],
      ['POST /client/ack', true],
      ['PUT /client/entries', false],
    ]);
    expect(pendingIds()).toEqual([]);
    expect(onDisk()).toEqual(['work: From the app']);
    expect(fake.rows().map((r) => r.entry_id)).not.toContain(fromApp);
  });

  it('another process is told the vault is busy while the pull waits for its rows, and its later save is kept', async () => {
    fake.cloudRemember('work', 'From the app');
    const parked = fake.hold('/client/pending');
    const sync = syncNow();
    await parked.arrived;
    const during = await otherProcessSaves('Saved by another app', { timeoutMs: 300 });
    parked.release();
    const res = await sync;
    const after = await otherProcessSaves('Saved by another app', { timeoutMs: 2000 });
    expect([during, res.status, res.body.added, after]).toEqual(['FileLockTimeoutError', 200, 1, 'saved']);
    expect(onDisk()).toEqual(['personal: Saved by another app', 'work: From the app', 'work: Pushed memory']);
  });
});

describe('a failed acknowledgement', () => {
  it('leaves the memory saved once, and the next Sync now settles it without a duplicate', async () => {
    const fromApp = fake.cloudRemember('work', 'From the app');
    fake.failNext('/client/ack', 500);
    const seen = watchLock();
    const first = await syncNow();
    expect([first.status, first.body.error]).toEqual([500, 'Connector server returned HTTP 500 on ack.']);
    expect(seen).toEqual([['GET /client/pending?v=3', true], ['POST /client/ack', true]]);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(onDisk()).toEqual(['work: From the app', 'work: Pushed memory']);
    expect(pendingIds()).toEqual([fromApp]);

    const second = await syncNow();
    expect([second.status, second.body.added, second.body.deduped]).toEqual([200, 0, 1]);
    expect(pendingIds()).toEqual([]);
    expect(onDisk()).toEqual(['work: From the app', 'work: Pushed memory']);
  });

  it('a memory forgotten before the next Sync now stays forgotten and its waiting row is deleted', async () => {
    const fromApp = fake.cloudRemember('work', 'From the app');
    fake.failNext('/client/ack', 500);
    expect((await syncNow()).status).toBe(500);
    await session.withVault((v) => {
      const pulled = v.list({ scope: 'work' }).find((e) => e.content === 'From the app')!;
      v.forget(pulled.id, { actor: 'owner' });
      v.save();
    });

    const seen = watchLock();
    const next = await syncNow();
    expect([next.status, next.body.added, next.body.discarded]).toEqual([200, 0, 1]);
    expect(seen).toEqual([['GET /client/pending?v=3', true], ['POST /client/discard', true], ['PUT /client/entries', false]]);
    expect(fake.rows().map((r) => r.entry_id)).not.toContain(fromApp);
    expect(onDisk()).toEqual(['work: Pushed memory']);
  });
});
