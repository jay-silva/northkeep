import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret, withFileLock } from '@northkeep/core';
import { pushSharedScopes, setConnectorServer } from '@northkeep/sync';
import { shareSyncCmd, type ShareDeps } from '../src/shareCmd.js';
import { startFakeConnector, type FakeConnector } from '../../sync/test/fake-connector.js';

/**
 * `northkeep share sync` previews with no lock, then fetches, applies and settles
 * under it, each call capped (defect B, two merge reviews). Each vault section takes the real
 * file lock and opens the vault fresh, as index.ts does. Temp home only.
 */

const PASS = 'synthetic cli lock passphrase';
const deviceSecret = generateDeviceSecret();
const savedEnv = { ...process.env };
let home = '';
let fake: FakeConnector;
let lines: string[] = [];

const vaultPath = () => path.join(home, 'vault.nkv');
const lockPath = () => `${vaultPath()}.lock`;
const key = () => {
  const header = Vault.readHeader(vaultPath());
  return deriveMasterKey(PASS, deviceSecret, header.salt, header.kdf);
};
const fail = (m: string): never => {
  throw new Error(`FAIL: ${m}`);
};
const lockedDeps = (): ShareDeps => ({
  withVault: <T>(fn: (vault: Vault) => T | Promise<T>) =>
    withFileLock(vaultPath(), async () => {
      const v = Vault.openWithKey(vaultPath(), key());
      try {
        return await fn(v);
      } finally {
        v.close();
      }
    }),
  vaultPath: vaultPath(),
  masterKey: async () => key(),
  ask: async () => null,
});
const onDisk = () => {
  const v = Vault.openWithKey(vaultPath(), key());
  try {
    return v.list().map((e) => `${e.scope}: ${e.content}`).sort();
  } finally {
    v.close();
  }
};
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);
const watchLock = () => {
  const seen: Array<[string, boolean]> = [];
  fake.observe((request) => seen.push([request, fs.existsSync(lockPath())]));
  return seen;
};

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-synclock-'));
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  delete process.env.NORTHKEEP_ASSUME_YES;
  fs.writeFileSync(path.join(home, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  fake = await startFakeConnector();
  setConnectorServer(fake.url());
  const v = Vault.create({ path: vaultPath(), passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE });
  v.setScopeShared('work', true);
  v.remember({ content: 'Pushed memory', type: 'semantic', scope: 'work' });
  v.markSidecarFoldDone();
  v.save();
  await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: ['work'], vault: v });
  v.close();
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  fake.observe(null);
  await fake.close();
  process.env = { ...savedEnv };
  fs.rmSync(home, { recursive: true, force: true });
});

describe('share sync: what runs under the vault lock', () => {
  it('the preview fetch starts with the lock free, the apply fetch and acknowledgement under it, and the push after is not under it', async () => {
    fake.cloudRemember('work', 'From the app');
    const seen = watchLock();
    await shareSyncCmd({ yes: true }, lockedDeps(), fail);
    expect(seen).toEqual([
      ['GET /client/pending?v=3', false],
      ['GET /client/pending?v=3', true],
      ['POST /client/ack', true],
      ['PUT /client/entries', false],
    ]);
    expect(lines).toContain('✓ Down-synced: 1 added, 0 replaced, 0 forgotten, 0 memories marked replaced, 0 already present, 0 held, 0 skipped.');
    expect(onDisk()).toEqual(['work: From the app', 'work: Pushed memory']);
    expect(pendingIds()).toEqual([]);
  });

  it('another process is told the vault is busy while the apply waits for its rows, and its later save is kept', async () => {
    fake.cloudRemember('work', 'From the app');
    const parked = fake.hold('/client/pending', 1); // the preview's fetch goes through; the apply's waits
    const sync = shareSyncCmd({ yes: true }, lockedDeps(), fail);
    await parked.arrived;
    const otherSaves = (timeoutMs: number) =>
      withFileLock(vaultPath(), () => {
        const w = Vault.openWithKey(vaultPath(), key());
        w.remember({ content: 'Saved by another app', type: 'semantic', scope: 'personal' });
        w.save();
        w.close();
      }, { timeoutMs }).then(() => 'saved', (err: Error) => err.name);
    const during = await otherSaves(300);
    parked.release();
    await sync;
    expect([during, await otherSaves(2000)]).toEqual(['FileLockTimeoutError', 'saved']);
    expect(onDisk()).toEqual(['personal: Saved by another app', 'work: From the app', 'work: Pushed memory']);
  });

  it('a failed acknowledgement leaves the memory saved once, and the next share sync settles it', async () => {
    const fromApp = fake.cloudRemember('work', 'From the app');
    fake.failNext('/client/ack', 500);
    const seen = watchLock();
    await expect(shareSyncCmd({ yes: true }, lockedDeps(), fail)).rejects.toThrow('Connector server returned HTTP 500 on ack.');
    expect(seen.find(([request]) => request === 'POST /client/ack')).toEqual(['POST /client/ack', true]);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(onDisk()).toEqual(['work: From the app', 'work: Pushed memory']);
    expect(pendingIds()).toEqual([fromApp]);

    lines = [];
    await shareSyncCmd({ yes: true }, lockedDeps(), fail);
    expect(lines).toContain('✓ Down-synced: 0 added, 0 replaced, 0 forgotten, 0 memories marked replaced, 1 already present, 0 held, 0 skipped.');
    expect(pendingIds()).toEqual([]);
    expect(onDisk()).toEqual(['work: From the app', 'work: Pushed memory']);
  });
});
