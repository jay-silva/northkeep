import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, getProjectView, onVaultSave } from '@northkeep/core';
import { AutoSync, type AutoSyncEvent } from '../src/auto.js';
import { deriveSyncCreds } from '../src/creds.js';
import { setSyncServer } from '../src/config.js';
import { pullVault, pushVault } from '../src/client.js';
import { ConnectorAutoPush } from '../src/connector-auto.js';
import { applyDownSync, ConnectorStalePushError, pushSharedScopes } from '../src/connector-client.js';
import { connectorPushFingerprint, setConnectorAutoPush, setConnectorServer } from '../src/connector-config.js';
import { manualConnectorPush, ConnectorPushBlockedError, vaultServerHash } from '../src/connector-push.js';
import { fakeServer, ManualClock } from './fake-sync-server.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

/**
 * ADR 0063 D5 against the fake sync server and the protocol fake of the
 * connector (fake-connector.ts). The engines run on a manual clock.
 */

const passphrase = 'synthetic d5 passphrase';
const deviceSecret = Buffer.alloc(32, 9);
const savedEnv = { ...process.env };
let homeA: string;
let homeB: string;
let sync: ReturnType<typeof fakeServer>;
let conn: FakeConnector;
let offs: Array<() => void> = [];
let stops: Array<() => void> = [];

beforeEach(async () => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-apA-'));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-apB-'));
  sync = fakeServer();
  await new Promise<void>((r) => sync.server.listen(0, '127.0.0.1', r));
  conn = await startFakeConnector();
  process.env.NORTHKEEP_HOME = homeA;
});
afterEach(async () => {
  for (const off of offs) off();
  for (const stop of stops) stop();
  offs = [];
  stops = [];
  process.env = { ...savedEnv };
  await new Promise((r) => sync.server.close(r));
  await conn.close();
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
});

const vaultPath = (home: string) => path.join(home, 'vault.nkv');
const derived = new Map<string, Buffer>();
function keyFor(home: string): Buffer {
  const header = Vault.readHeader(vaultPath(home));
  const id = Buffer.from(header.salt).toString('hex');
  if (!derived.has(id)) derived.set(id, deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf));
  return Buffer.from(derived.get(id)!);
}
function withVaultAt<T>(home: string, fn: (v: Vault) => T): T {
  const v = Vault.openWithKey(vaultPath(home), keyFor(home));
  try {
    return fn(v);
  } finally {
    v.close();
  }
}
async function withVaultAsync<T>(home: string, fn: (v: Vault) => Promise<T>): Promise<T> {
  const v = Vault.openWithKey(vaultPath(home), keyFor(home));
  try {
    return await fn(v);
  } finally {
    v.close();
  }
}
function write(home: string, content: string, scope: string): void {
  withVaultAt(home, (v) => {
    v.remember({ content, type: 'semantic', scope });
    v.save();
  });
}
function configureSync(home: string): void {
  const prev = process.env.NORTHKEEP_HOME;
  process.env.NORTHKEEP_HOME = home;
  setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
  process.env.NORTHKEEP_HOME = prev;
}

/** Mac A with a shared scope 'work', in sync at v1, connector configured. */
async function setup(opts: { vaultSync?: boolean } = {}): Promise<void> {
  const v = Vault.create({ path: vaultPath(homeA), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  v.remember({ content: 'shared seed', type: 'semantic', scope: 'work' });
  v.remember({ content: 'private seed', type: 'semantic', scope: 'private' });
  v.setScopeShared('work', true);
  v.save();
  v.close();
  setConnectorServer(conn.url());
  if (opts.vaultSync !== false) {
    configureSync(homeA);
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
  }
}

function engines(opts: { locked?: () => boolean } = {}) {
  const clock = new ManualClock();
  const events: AutoSyncEvent[] = [];
  const getMasterKey = () => (opts.locked?.() ? null : keyFor(homeA));
  let cap!: ConnectorAutoPush;
  const auto = new AutoSync({
    vaultPath: vaultPath(homeA),
    getMasterKey,
    loadDeviceSecret: () => Buffer.from(deviceSecret),
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'pushed' || e.type === 'pulled' || e.type === 'in-sync') cap.onVaultCurrent();
    },
    debounceMs: 100,
    clock,
    allowAnyVault: true,
  });
  cap = new ConnectorAutoPush({
    vaultPath: vaultPath(homeA),
    getMasterKey,
    loadDeviceSecret: () => Buffer.from(deviceSecret),
    autoSyncStatus: () => auto.status(),
    debounceMs: 100,
    clock,
    allowAnyVault: true,
  });
  offs.push(onVaultSave((p) => {
    auto.notifyWrite(p);
    cap.notifyWrite(p);
  }));
  stops.push(() => auto.stop(), () => cap.stop());
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await clock.advance(1_000, auto);
      await cap.whenIdle();
    }
  };
  return { auto, cap, events, settle };
}
const pushedToConnector = () => conn.pushes().filter((p) => p.status === 200);

describe('ADR 0063 D5: automatic push to Cloud Connect', () => {
  it('after a vault push, a write in a shared scope pushes once with the sync version; a private write pushes nothing', async () => {
    await setup();
    const { settle } = engines();
    write(homeA, 'new shared note', 'work');
    await settle();
    expect(pushedToConnector().map((p) => [p.scopes, p.vault])).toEqual([[['work'], { server: vaultServerHash(sync.url()), version: 2 }]]);
    expect(conn.rows().filter((r) => r.scope === 'work').map((r) => r.content).sort()).toEqual(['new shared note', 'shared seed']);

    write(homeA, 'private only', 'private');
    await settle();
    expect(sync.version()).toBe(3);
    expect(pushedToConnector()).toHaveLength(1);
  });

  it('pushes nothing while behind or diverged, and says why', async () => {
    await setup();
    configureSync(homeB);
    process.env.NORTHKEEP_HOME = homeB;
    expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true);
    write(homeB, 'from B', 'work');
    expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true);
    process.env.NORTHKEEP_HOME = homeA;

    const behind = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => behind.stop());
    expect((await behind.runOnce()).reason).toBe('behind');

    write(homeA, 'from A, unsynced', 'work');
    expect((await behind.runOnce()).reason).toBe('diverged');
    expect(pushedToConnector()).toHaveLength(0);
  });

  it('pushes nothing while only ahead: it waits for the vault push', async () => {
    await setup();
    write(homeA, 'unsynced', 'work');
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    const status = await cap.runOnce();
    expect([status.phase, status.reason]).toEqual(['pending', 'ahead']);
    expect(pushedToConnector()).toHaveLength(0);
  });

  it('does nothing while locked', async () => {
    await setup();
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => null, loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    expect((await cap.runOnce()).reason).toBe('locked');
    expect(conn.requests()).toEqual([]);
  });

  it('stays paused when the connector does not enforce tombstones', async () => {
    await setup();
    conn.setTombstoneEnforce(false);
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    const status = await cap.runOnce();
    expect([status.phase, status.reason]).toEqual(['paused', 'tombstone_off']);
    expect(conn.pushes()).toHaveLength(0);
  });

  it('is off when the switch is off', async () => {
    await setup();
    setConnectorAutoPush(false);
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    const status = await cap.runOnce();
    expect([status.enabled, status.phase, status.reason]).toEqual([false, 'off', 'switched_off']);
    expect(conn.pushes()).toHaveLength(0);
  });

  it('A4 replay: an older vault version gets 428, the connector keeps the newer document, and the engine pauses until the user acts', async () => {
    await setup();
    withVaultAt(homeA, (v) => {
      v.updateProject({ project: 'a', expected_revision: null, status: 'R2 newer.' });
      v.setScopeShared('project:a', true);
      v.save();
    });
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    const r2 = withVaultAt(homeA, (v) => getProjectView(v, 'a').revision);
    const server = vaultServerHash(sync.url());
    await withVaultAsync(homeA, (v) => pushSharedScopes({ server: conn.url(), deviceSecret, scopes: v.sharedScopes(), vault: v, vaultStamp: { server, version: 2 } }));

    const rows = withVaultAt(homeA, (v) => v.sharedScopeRows());
    const older = { list: () => [], sharedScopeRows: () => rows };
    await expect(pushSharedScopes({ server: conn.url(), deviceSecret, scopes: ['project:a'], vault: older as never, vaultStamp: { server, version: 1 } })).rejects.toBeInstanceOf(ConnectorStalePushError);
    expect(conn.head('project:a')?.entry_id).toBe(r2);

    // Another device already pushed a newer vault version: the engine is refused and pauses.
    await withVaultAsync(homeA, (v) => pushSharedScopes({ server: conn.url(), deviceSecret, scopes: v.sharedScopes(), vault: v, vaultStamp: { server, version: 99 } }));
    write(homeA, 'change to send', 'work');
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    expect((await cap.runOnce()).reason).toBe('stale_push');
    const refused = conn.pushes().length;
    expect((await cap.runOnce()).reason).toBe('stale_push');
    expect(conn.pushes()).toHaveLength(refused);
  });

  it('a device with no vault sync pushes on a debounced save and sends no version', async () => {
    await setup({ vaultSync: false });
    const { settle } = engines();
    write(homeA, 'only copy', 'work');
    await settle();
    expect(pushedToConnector().map((p) => [p.scopes, p.vault])).toEqual([[['work'], undefined]]);
  });

  it('forwards the sync server entitlement, which the hosted billing gate requires on every /client call', async () => {
    await setup();
    await conn.close();
    conn = await startFakeConnector({ requireEntitlement: 'ent-attestation' });
    setConnectorServer(conn.url());
    sync.entitle('ent-attestation');
    write(homeA, 'change to send', 'work');
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    const status = await cap.runOnce();
    expect([status.phase, status.reason]).toEqual(['idle', null]);
    expect(pushedToConnector()).toHaveLength(1);
  });

  it('makes no network call when nothing is shared', async () => {
    await setup();
    withVaultAt(homeA, (v) => {
      v.setScopeShared('work', false);
      v.save();
    });
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    expect((await cap.runOnce()).reason).toBe('nothing_shared');
    expect(conn.requests()).toEqual([]);
  });

  it('nothing changed on an in-sync device: reads the manifest once and pushes nothing', async () => {
    await setup();
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    await cap.runOnce();
    expect(pushedToConnector()).toHaveLength(1);
    const before = conn.requests().length;
    const status = await cap.runOnce();
    expect([status.phase, status.reason]).toEqual(['idle', null]);
    expect(conn.requests().slice(before)).toEqual(['GET /client/manifest']);
    expect(pushedToConnector()).toHaveLength(1);
  });

  it('nothing changed on a device with no vault sync: no network call', async () => {
    await setup({ vaultSync: false });
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    await cap.runOnce();
    expect(pushedToConnector()).toHaveLength(1);
    const before = conn.requests().length;
    await cap.runOnce();
    expect(conn.requests()).toHaveLength(before);
  });

  it('P1: another device acked and then forgot a cloud memory; the in-sync Mac, with no write of its own, removes it from Cloud Connect', async () => {
    await setup();
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    await cap.runOnce();
    const fingerprint = connectorPushFingerprint();
    conn.cloudRemember('work', 'y: deleted on the phone');

    // The phone: additions only, ack, vault push; then forget, vault push. It never pushes to Cloud Connect.
    configureSync(homeB);
    process.env.NORTHKEEP_HOME = homeB;
    expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true);
    const added = await withVaultAsync(homeB, (v) => applyDownSync({ server: conn.url(), deviceSecret, vault: v, additiveOnly: true }));
    expect(added.added).toBe(1);
    expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true);
    withVaultAt(homeB, (v) => {
      v.forget(v.list({ scope: 'work' }).find((e) => e.content.startsWith('y:'))!.id);
      v.save();
    });
    expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true);

    process.env.NORTHKEEP_HOME = homeA;
    expect((await pullVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    expect(connectorPushFingerprint()).toBe(fingerprint);
    const status = await cap.runOnce();
    expect([status.phase, status.reason]).toEqual(['idle', null]);
    expect(conn.rows().filter((r) => r.scope === 'work').map((r) => r.content)).toEqual(['shared seed']);
    expect(pushedToConnector().at(-1)!.vault).toEqual({ server: vaultServerHash(sync.url()), version: 3 });

    const pushes = pushedToConnector().length;
    await cap.runOnce();
    expect(pushedToConnector()).toHaveLength(pushes);
  });

  it('a row acked on the connector with no hash is pushed once, then the engine settles', async () => {
    await setup();
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    await cap.runOnce();
    conn.cloudRemember('work', 'from the app');
    await withVaultAsync(homeA, (v) => applyDownSync({ server: conn.url(), deviceSecret, vault: v }));
    expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
    await cap.runOnce();
    expect(pushedToConnector()).toHaveLength(2);
    await cap.runOnce();
    await cap.runOnce();
    expect(pushedToConnector()).toHaveLength(2);
  });

  it('an undelivered cloud write on the connector is not a difference to push', async () => {
    await setup();
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    await cap.runOnce();
    conn.cloudRemember('work', 'still pending');
    await cap.runOnce();
    await cap.runOnce();
    expect(pushedToConnector()).toHaveLength(1);
  });

  it('R-428b: a down-sync apply and ack never update the fingerprint; only an accepted push does', async () => {
    await setup();
    const cap = new ConnectorAutoPush({ vaultPath: vaultPath(homeA), getMasterKey: () => keyFor(homeA), loadDeviceSecret: () => Buffer.from(deviceSecret), allowAnyVault: true });
    stops.push(() => cap.stop());
    await cap.runOnce();
    const pushed = connectorPushFingerprint();
    expect(pushed).not.toBeNull();
    conn.cloudRemember('work', 'written in the app');
    await withVaultAsync(homeA, (v) => applyDownSync({ server: conn.url(), deviceSecret, vault: v }));
    expect(connectorPushFingerprint()).toBe(pushed);
  });
});

describe('ADR 0063 D5: manual pushes', () => {
  const withVaultA = <T>(fn: (v: Vault) => T | Promise<T>) => withVaultAsync(homeA, async (v) => fn(v));

  it('pushes the vault first when ahead and sends the version the sync server returned', async () => {
    await setup();
    write(homeA, 'unsynced shared', 'work');
    const result = await manualConnectorPush({ server: conn.url(), deviceSecret, vaultPath: vaultPath(homeA), masterKey: keyFor(homeA), withVault: withVaultA });
    expect(result?.scopes).toEqual(['work']);
    expect(sync.version()).toBe(2);
    expect(conn.pushes().at(-1)?.vault).toEqual({ server: vaultServerHash(sync.url()), version: 2 });
  });

  it('refuses when behind, sending nothing', async () => {
    await setup();
    configureSync(homeB);
    process.env.NORTHKEEP_HOME = homeB;
    expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true);
    write(homeB, 'from B', 'work');
    expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true);
    process.env.NORTHKEEP_HOME = homeA;
    const attempt = manualConnectorPush({ server: conn.url(), deviceSecret, vaultPath: vaultPath(homeA), masterKey: keyFor(homeA), withVault: withVaultA });
    await expect(attempt).rejects.toBeInstanceOf(ConnectorPushBlockedError);
    expect(conn.pushes()).toHaveLength(0);
  });

  it('--reset-order sends reset and replaces the recorded order', async () => {
    await setup();
    const server = vaultServerHash(sync.url());
    await withVaultAsync(homeA, (v) => pushSharedScopes({ server: conn.url(), deviceSecret, scopes: ['work'], vault: v, vaultStamp: { server, version: 50 } }));
    await expect(manualConnectorPush({ server: conn.url(), deviceSecret, vaultPath: vaultPath(homeA), masterKey: keyFor(homeA), withVault: withVaultA })).rejects.toBeInstanceOf(ConnectorStalePushError);
    await manualConnectorPush({ server: conn.url(), deviceSecret, vaultPath: vaultPath(homeA), masterKey: keyFor(homeA), withVault: withVaultA, reset: true });
    expect(conn.vaultPair()).toEqual({ server, version: 1 });
    expect(conn.pushes().at(-1)?.reset).toBe(true);
  });
});
