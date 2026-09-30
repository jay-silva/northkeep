import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, onVaultSave } from '@northkeep/core';
import { AutoSync, type AutoSyncEvent } from '../src/auto.js';
import { deriveSyncCreds } from '../src/creds.js';
import { loadSyncConfig, setSyncServer } from '../src/config.js';
import { confirmPull, LocalChangedError, previewPull, pullVault, pushVault, RemoteChangedError, syncState } from '../src/client.js';
import { runSyncAfterSave } from '../../../apps/mobile/src/lib/sync-flow.js';
import { fakeServer, ManualClock } from './fake-sync-server.js';

/**
 * ADR 0063 D6 regressions, ported from the recheck's attack harness
 * (NorthKeep/Reviews/adr-0063/recheck-attacks/adr0063-d6-recheck.test.ts),
 * now against the built drop set, automatic-pull refusal and pinned confirm.
 * The phone is its REAL last-writer-wins policy (runSyncAfterSave).
 */

const passphrase = 'synthetic d6 passphrase';
const deviceSecret = Buffer.alloc(32, 7);
const savedEnv = { ...process.env };
let homeA: string;
let homeB: string;
let fake: ReturnType<typeof fakeServer>;
let engines: AutoSync[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-pullA-'));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-pullB-'));
  fake = fakeServer();
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
  process.env.NORTHKEEP_HOME = homeA;
});
afterEach(async () => {
  for (const e of engines) e.stop();
  engines = [];
  unsubscribe?.();
  unsubscribe = null;
  process.env = { ...savedEnv };
  await new Promise((r) => fake.server.close(r));
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
});

const vaultPath = (home: string) => path.join(home, 'vault.nkv');
const derived = new Map<string, Buffer>();
function keyAt(vp: string): Buffer {
  const header = Vault.readHeader(vp);
  const id = `${Buffer.from(header.salt).toString('hex')} ${JSON.stringify(header.kdf)}`;
  let key = derived.get(id);
  if (!key) {
    key = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
    derived.set(id, Buffer.from(key));
  }
  return Buffer.from(key);
}
const keyFor = (home: string) => keyAt(vaultPath(home));
function withVaultAt<T>(home: string, fn: (v: Vault) => T): T {
  const v = Vault.openWithKey(vaultPath(home), keyFor(home));
  try {
    return fn(v);
  } finally {
    v.close();
  }
}
function write(home: string, content: string, scope?: string): void {
  withVaultAt(home, (v) => {
    v.remember({ content, type: 'semantic', ...(scope ? { scope } : {}) });
    v.save();
  });
}
const contents = (home: string) => withVaultAt(home, (v) => v.list().map((e) => e.content));
function configure(home: string): void {
  const prev = process.env.NORTHKEEP_HOME;
  process.env.NORTHKEEP_HOME = home;
  setSyncServer(fake.url(), deriveSyncCreds(deviceSecret).accountId);
  process.env.NORTHKEEP_HOME = prev;
}
async function asHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  process.env.NORTHKEEP_HOME = home;
  try {
    return await fn();
  } finally {
    process.env.NORTHKEEP_HOME = homeA;
  }
}
async function setupTwoDevices(): Promise<void> {
  const v = Vault.create({ path: vaultPath(homeA), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  v.remember({ content: 'seed', type: 'semantic' });
  v.save();
  v.close();
  configure(homeA);
  configure(homeB);
  expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);
  await asHome(homeB, async () => expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret })).ok).toBe(true));
}
const pushA = async () => expect((await pushVault({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) })).ok).toBe(true);

/** The phone's real conflict policy: on a 409 it keeps the server copy as .bak and re-pushes its own vault over it. */
async function phoneSyncAfterSave(content: string): Promise<string> {
  const vp = vaultPath(homeB);
  write(homeB, content);
  let remoteBytes: Buffer | null = null;
  const generationAt = (p: string) => {
    const v = Vault.openWithKey(p, keyAt(p));
    try {
      return v.getSyncGeneration();
    } finally {
      v.close();
    }
  };
  const put = async (base: number) => {
    const r = await fetch(`${fake.url()}/api/blob`, { method: 'PUT', headers: { 'x-base-version': String(base) }, body: fs.readFileSync(vp) });
    const body = (await r.json()) as { version: number };
    return { ok: r.status === 200, conflict: r.status === 409, version: body.version };
  };
  const ev = await runSyncAfterSave({
    hasMasterKey: () => true,
    loadBaseVersion: async () => 1,
    push: (base: number) => put(base),
    fetchRemote: async () => {
      const r = await fetch(`${fake.url()}/api/blob`);
      remoteBytes = Buffer.from(await r.arrayBuffer());
      return { version: Number(r.headers.get('x-version')) };
    },
    verifyRemoteOpens: () => true,
    remoteSyncGeneration: () => {
      fs.writeFileSync(`${vp}.remote-tmp`, remoteBytes!);
      return generationAt(`${vp}.remote-tmp`);
    },
    localSyncGeneration: () => generationAt(vp),
    applyConflictRepushGeneration: (g: number) =>
      withVaultAt(homeB, (w) => {
        w.setSyncGeneration(g);
        w.save();
      }),
    stashRemote: () => fs.writeFileSync(`${vp}.bak`, remoteBytes!),
    saveBaseVersion: async () => {},
  } as unknown as Parameters<typeof runSyncAfterSave>[0]);
  return ev.type;
}

function engine(): { auto: AutoSync; events: AutoSyncEvent[] } {
  const events: AutoSyncEvent[] = [];
  const auto = new AutoSync({
    vaultPath: vaultPath(homeA),
    getMasterKey: () => keyFor(homeA),
    loadDeviceSecret: () => Buffer.from(deviceSecret),
    onEvent: (e) => events.push(e),
    debounceMs: 600_000,
    clock: new ManualClock(),
    allowAnyVault: true,
  });
  unsubscribe = onVaultSave((p) => auto.notifyWrite(p));
  engines.push(auto);
  return { auto, events };
}

describe('ADR 0063 D6: the automatic pull refuses a non-empty drop set', () => {
  it('L1: after the phone re-pushes over the Mac, the Mac wakes behind, refuses the pull, and keeps its pushed work', async () => {
    await setupTwoDevices();
    write(homeA, 'MAC WORK pushed at v2');
    await pushA();
    expect(await phoneSyncAfterSave('phone note')).toBe('conflict-recovered');
    expect((await syncState({ vaultPath: vaultPath(homeA), deviceSecret })).state).toBe('behind');

    const { auto, events } = engine();
    await auto.wake();
    expect(events.map((e) => e.type)).toEqual(['pull-refused']);
    expect(auto.status().pullRefusal?.only_here).toEqual([{ scope: 'personal', first_line: 'MAC WORK pushed at v2' }]);
    expect(auto.status().phase).toBe('error');
    expect(contents(homeA)).toContain('MAC WORK pushed at v2');
  });

  it('L2: a memory forgotten on the Mac that the phone copy still holds is reported, and the forget stays in force', async () => {
    await setupTwoDevices();
    withVaultAt(homeA, (v) => {
      v.remember({ content: 'FORGOTTEN SECRET in shared scope', type: 'semantic', scope: 'work' });
      v.setScopeShared('work', true);
      v.save();
    });
    await pushA();
    await asHome(homeB, async () => expect((await pullVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true));
    withVaultAt(homeA, (v) => {
      v.forget(v.list({ scope: 'work' })[0]!.id);
      v.save();
    });
    await pushA();
    expect(await phoneSyncAfterSave('phone note')).toBe('conflict-recovered');

    const { auto, events } = engine();
    await auto.wake();
    expect(events.map((e) => e.type)).toEqual(['pull-refused']);
    expect(auto.status().pullRefusal?.restored_deletes).toEqual([{ scope: 'work' }]);
    expect(withVaultAt(homeA, (v) => v.list({ scope: 'work' }))).toHaveLength(0);
  });

  it('no wedge: another device adding memories and sharing a scope leaves an empty drop set, so the pull runs', async () => {
    await setupTwoDevices();
    await asHome(homeB, async () => {
      withVaultAt(homeB, (v) => {
        v.remember({ content: 'B shared note', type: 'semantic', scope: 'team' });
        v.setScopeShared('team', true);
        v.save();
      });
      expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true);
    });
    const { auto, events } = engine();
    await auto.wake();
    expect(events.map((e) => e.type)).toEqual(['in-sync', 'pulled']);
    expect(contents(homeA)).toContain('B shared note');
    expect(auto.status().pullRefusal).toBeNull();
  });
});

describe('ADR 0063 D6: the manual pull reports, then installs exactly what it reported', () => {
  async function diverge(): Promise<void> {
    await setupTwoDevices();
    await asHome(homeB, async () => {
      write(homeB, 'N: from the other device');
      expect((await pushVault({ vaultPath: vaultPath(homeB), deviceSecret, masterKey: keyFor(homeB) })).ok).toBe(true);
    });
    write(homeA, 'M: local-only, unpushed');
    withVaultAt(homeA, (v) => {
      v.updateProject({ project: 'demo', expected_revision: null, status: 'Only on this Mac.' });
      v.save();
    });
  }

  it('the dry pass names the local-only memory and project and changes nothing', async () => {
    await diverge();
    const before = fs.readFileSync(vaultPath(homeA));
    const preview = await previewPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
    if (!preview.ok) throw new Error('expected a remote');
    expect(preview.wouldDrop).toBe(true);
    expect(preview.report.only_here.map((i) => i.first_line)).toContain('M: local-only, unpushed');
    expect(preview.report.projects).toEqual(['demo']);
    expect(fs.readFileSync(vaultPath(homeA)).equals(before)).toBe(true);
  });

  it('L3: a server that moved after the dry pass refuses with RemoteChangedError and installs nothing', async () => {
    await diverge();
    const preview = await previewPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
    if (!preview.ok) throw new Error('expected a remote');
    const before = fs.readFileSync(vaultPath(homeA));
    expect(await phoneSyncAfterSave('phone note')).toBe('conflict-recovered');
    await expect(confirmPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA), version: preview.version, sha256: preview.sha256 })).rejects.toBeInstanceOf(RemoteChangedError);
    expect(fs.readFileSync(vaultPath(homeA)).equals(before)).toBe(true);
    expect(fs.existsSync(`${vaultPath(homeA)}.pulled.hold`)).toBe(false);
  });

  it('a local write after the dry pass refuses with LocalChangedError', async () => {
    await diverge();
    const preview = await previewPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
    if (!preview.ok) throw new Error('expected a remote');
    write(homeA, 'written after the review');
    await expect(confirmPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA), version: preview.version, sha256: preview.sha256 })).rejects.toBeInstanceOf(LocalChangedError);
    expect(contents(homeA)).toContain('written after the review');
  });

  it('confirm installs the held bytes: what dropped is exactly the report, and sync.json records the dry-pass version', async () => {
    await diverge();
    const before = contents(homeA);
    const preview = await previewPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA) });
    if (!preview.ok) throw new Error('expected a remote');
    const result = await confirmPull({ vaultPath: vaultPath(homeA), deviceSecret, masterKey: keyFor(homeA), version: preview.version, sha256: preview.sha256 });
    expect(result).toEqual({ ok: true, version: preview.version, wroteVault: true });
    const after = contents(homeA);
    const dropped = before.filter((c) => !after.includes(c)).map((c) => c.split('\n')[0]);
    expect(dropped.sort()).toEqual(preview.report.only_here.map((i) => i.first_line).sort());
    expect(after).toContain('N: from the other device');
    expect(loadSyncConfig()?.lastVersion).toBe(preview.version);
    expect(fs.existsSync(`${vaultPath(homeA)}.bak`)).toBe(true);
  });
});
