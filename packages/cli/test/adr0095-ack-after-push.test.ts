import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret } from '@northkeep/core';
import { applyDownSync, deriveSyncCreds, fetchPending, planDownSync, pullVault, pushSharedScopes, pushVault, setConnectorServer, setSyncServer } from '@northkeep/sync';
import { shareSyncCmd, type ShareDeps } from '../src/shareCmd.js';
import { startFakeConnector, type FakeConnector } from '../../sync/test/fake-connector.js';
import { fakeServer } from '../../sync/test/fake-sync-server.js';

/**
 * ADR 0095 section 5 on the command line: with a vault sync server, a cloud
 * replace is acknowledged only after the vault push carrying its mark has
 * landed, so a yes that loses the push asks again. Temp homes, fictional data.
 */

const PASS = 'synthetic cli passphrase';
const PIER_4 = 'The harbor office is at Pier 4.';
const PIER_9 = 'The harbor office is now at Pier 9.';
const deviceSecret = generateDeviceSecret();
const savedEnv = { ...process.env };
let home = '';
let fake: FakeConnector;

const vaultPath = () => path.join(home, 'vault.nkv');
const key = () => {
  const header = Vault.readHeader(vaultPath());
  return deriveMasterKey(PASS, deviceSecret, header.salt, header.kdf);
};
/** One vault section, opened fresh and closed, as the real command line does. */
const withVault = async <T>(fn: (v: Vault) => T | Promise<T>): Promise<T> => {
  const v = Vault.openWithKey(vaultPath(), key());
  try {
    return await fn(v);
  } finally {
    v.close();
  }
};
const deps = (): ShareDeps => ({ withVault, vaultPath: vaultPath(), masterKey: async () => key(), ask: async () => null });
const fail = (m: string): never => {
  throw new Error(`FAIL: ${m}`);
};
const conn = () => ({ server: fake.url(), deviceSecret });
const replaceAcks = () => fake.acks().filter((a) => Array.isArray(a.replaces) && (a.replaces as unknown[]).length > 0);
const rowsOf = () => withVault((v) => v.list({ scope: 'harbor', includeSuperseded: true }).map((e) => [e.content, e.superseded_by !== null] as const).sort());

/** A shared collection holding both memories, already on the connector, with a replace between them waiting. */
async function waitingReplace(): Promise<string> {
  const oldId = await withVault(async (v) => {
    const old = v.remember({ content: PIER_4, type: 'semantic', scope: 'harbor' });
    v.setScopeShared('harbor', true);
    v.save();
    await pushSharedScopes({ ...conn(), vault: v, scopes: ['harbor'] });
    return old.id;
  });
  const { replaceId } = fake.cloudReplace('harbor', PIER_9, oldId);
  // An earlier phone-style sync took the new memory in; the replace still waits.
  await withVault((v) => applyDownSync({ ...conn(), vault: v, additiveOnly: true }));
  return replaceId;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-0095-'));
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_PASSPHRASE = PASS;
  delete process.env.NORTHKEEP_ASSUME_YES;
  fs.writeFileSync(path.join(home, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  fake = await startFakeConnector();
  setConnectorServer(fake.url());
  const v = Vault.create({ path: vaultPath(), passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE });
  v.markSidecarFoldDone();
  v.save();
  v.close();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
  process.env = { ...savedEnv };
  fs.rmSync(home, { recursive: true, force: true });
});

describe('share sync with a vault sync server', () => {
  let sync: ReturnType<typeof fakeServer>;

  beforeEach(async () => {
    sync = fakeServer();
    await new Promise<void>((r) => sync.server.listen(0, '127.0.0.1', r));
    setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
  });
  afterEach(async () => {
    await new Promise((r) => sync.server.close(r));
  });

  it('acknowledges an approved replace only after the vault push lands', async () => {
    const replaceId = await waitingReplace();
    expect((await pushVault({ vaultPath: vaultPath(), deviceSecret, masterKey: key() })).ok).toBe(true);

    await shareSyncCmd({ yes: true }, deps(), fail);

    expect(await rowsOf()).toEqual([[PIER_4, true], [PIER_9, false]]);
    expect(fake.replaceQueue()).toEqual([]);
    expect(replaceAcks()).toEqual([{ acked: [], forgets: [], replaces: [replaceId] }]);
    // The vault push came first: the acknowledgement is the last request but the Cloud Connect push.
    const requests = fake.requests();
    expect(requests.indexOf('POST /client/ack')).toBeLessThan(requests.lastIndexOf('PUT /client/entries'));
    expect(sync.version()).toBe(2);
  });

  it('when the vault push loses, the mark is saved here but the request stays queued, and the next run settles it', async () => {
    const replaceId = await waitingReplace();
    expect((await pushVault({ vaultPath: vaultPath(), deviceSecret, masterKey: key() })).ok).toBe(true);
    sync.conflictOnce();

    await expect(shareSyncCmd({ yes: true }, deps(), fail)).rejects.toThrow('The changes above were saved on this device, but Cloud Connect was not updated');

    expect(await rowsOf()).toEqual([[PIER_4, true], [PIER_9, false]]);
    expect(fake.replaceQueue().map((r) => r.replace_id)).toEqual([replaceId]);
    expect(replaceAcks()).toEqual([]);

    await shareSyncCmd({ yes: true }, deps(), fail);
    expect(fake.replaceQueue()).toEqual([]);
    expect(replaceAcks()).toEqual([{ acked: [], forgets: [], replaces: [replaceId] }]);
  });

  it('a yes that lost to another device\'s copy asks again instead of vanishing', async () => {
    const replaceId = await waitingReplace();
    expect((await pushVault({ vaultPath: vaultPath(), deviceSecret, masterKey: key() })).ok).toBe(true);
    sync.conflictOnce();
    await expect(shareSyncCmd({ yes: true }, deps(), fail)).rejects.toThrow('Cloud Connect was not updated');

    // The phone, which never saw the mark, saves a change and pushes its copy.
    const phoneHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-0095-phone-'));
    try {
      process.env.NORTHKEEP_HOME = phoneHome;
      fs.writeFileSync(path.join(phoneHome, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
      setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
      const phoneVault = path.join(phoneHome, 'vault.nkv');
      // The server still holds the copy from before the Mac's yes: that is what the phone has.
      expect((await pullVault({ vaultPath: phoneVault, deviceSecret })).ok).toBe(true);
      const header = Vault.readHeader(phoneVault);
      const phoneKey = () => deriveMasterKey(PASS, deviceSecret, header.salt, header.kdf);
      const p = Vault.openWithKey(phoneVault, phoneKey());
      p.remember({ content: 'Typed on the phone.', type: 'semantic', scope: 'personal' });
      p.save();
      p.close();
      expect((await pushVault({ vaultPath: phoneVault, deviceSecret, masterKey: phoneKey() })).ok).toBe(true);
    } finally {
      process.env.NORTHKEEP_HOME = home;
      fs.rmSync(phoneHome, { recursive: true, force: true });
    }

    // The Mac takes the phone's copy: a lost mark is not a drop, so the pull goes through.
    const pulled = await pullVault({ vaultPath: vaultPath(), deviceSecret, masterKey: key(), refuseDrops: true });
    expect(pulled.ok).toBe(true);
    expect(await rowsOf()).toEqual([[PIER_4, false], [PIER_9, false]]);

    const pending = await fetchPending(conn());
    const plan = await withVault((v) => planDownSync({ vault: v, pending }));
    expect(plan.cloud_replaces.map((r) => r.replace_id)).toEqual([replaceId]);
    expect(plan.settled_replaces).toEqual([]);
  });
});

describe('share sync with no vault sync server', () => {
  it('acknowledges an approved replace in the first acknowledgement, as before', async () => {
    const replaceId = await waitingReplace();
    await shareSyncCmd({ yes: true }, deps(), fail);
    expect(await rowsOf()).toEqual([[PIER_4, true], [PIER_9, false]]);
    expect(fake.replaceQueue()).toEqual([]);
    expect(replaceAcks()).toEqual([{ acked: [], forgets: [], replaces: [replaceId] }]);
    const requests = fake.requests();
    expect(requests.lastIndexOf('POST /client/ack')).toBeLessThan(requests.lastIndexOf('PUT /client/entries'));
  });
});
