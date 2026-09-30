import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { deriveSyncCreds, foldSidecarScopesIntoVault, pullVault, pushSharedScopes, pushVault, setConnectorServer, setSyncServer } from '@northkeep/sync';
import { shareConflictsCmd, sharePushCmd, shareResolveCmd, shareSyncCmd, type ShareDeps } from '../src/shareCmd.js';
import { projectsDeleteCmd, projectsHistoryCmd, projectsRestoreCmd } from '../src/projectsCmd.js';
import { syncPull } from '../src/syncCmd.js';
import { autoPushAfterWrite } from '../src/autoPush.js';
import { startFakeConnector, type FakeConnector } from '../../sync/test/fake-connector.js';
import { fakeServer } from '../../sync/test/fake-sync-server.js';

/**
 * ADR 0063 on the CLI, against the protocol fake of the connector
 * (packages/sync/test/fake-connector.ts) and the fake sync server. Temp homes
 * only; NORTHKEEP_PASSPHRASE stands in for the Keychain.
 */

const PASS = 'synthetic cli passphrase';
const deviceSecret = generateDeviceSecret();
const savedEnv = { ...process.env };
let home = '';
let fake: FakeConnector;
let vault: Vault;
let lines: string[] = [];

const vaultPath = () => path.join(home, 'vault.nkv');
const fail = (m: string): never => {
  throw new Error(`FAIL: ${m}`);
};
function deps(answer: string | null = null): ShareDeps {
  return {
    withVault: async (fn) => fn(vault),
    vaultPath: vaultPath(),
    masterKey: async () => {
      const header = Vault.readHeader(vaultPath());
      return deriveMasterKey(PASS, deviceSecret, header.salt, header.kdf);
    },
    ask: async () => answer,
  };
}
const withVault = async <T>(fn: (v: Vault) => T | Promise<T>): Promise<T> => fn(vault);
const cloud = (status: string) => `## What & Why\nDemo.\n\n## Current Status\n${status}\n`;
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-0063-'));
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  delete process.env.NORTHKEEP_ASSUME_YES;
  fs.writeFileSync(path.join(home, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  fake = await startFakeConnector();
  setConnectorServer(fake.url());
  vault = Vault.create({ path: vaultPath(), passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE });
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vault.close();
  await fake.close();
  process.env = { ...savedEnv };
  fs.rmSync(home, { recursive: true, force: true });
});

async function sharedProject(slug: string, status: string): Promise<string> {
  const r = vault.updateProject({ project: slug, expected_revision: null, what_why: 'Demo.', status }).revision;
  vault.setScopeShared(`project:${slug}`, true);
  vault.save();
  await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: vault.sharedScopes(), vault });
  return r;
}

describe('share sync (D3)', () => {
  it('refuses a replacement with no terminal and no --yes, changing nothing', async () => {
    await sharedProject('demo', 'Local.');
    const forward = fake.cloudUpdate('project:demo', cloud('Cloud forward.'));
    // The ADR 0038 one-time fold saves on first use; the preview itself must write nothing.
    foldSidecarScopesIntoVault(vault);
    const before = fs.readFileSync(vaultPath());
    await expect(shareSyncCmd({}, deps(null), fail)).rejects.toThrow('there is no terminal to ask on. Nothing was changed.');
    expect(fs.readFileSync(vaultPath()).equals(before)).toBe(true);
    expect(pendingIds()).toEqual([forward]);
    expect(lines).toContain('  1 project would be replaced by the cloud version (the current one stays in history): demo');
  });

  it('answering no applies nothing; answering yes applies and re-pushes', async () => {
    await sharedProject('demo', 'Local.');
    fake.cloudUpdate('project:demo', cloud('Cloud forward.'));
    await expect(shareSyncCmd({}, deps('n'), fail)).rejects.toThrow('Cancelled. Nothing was changed.');
    expect(getProjectView(vault, 'demo').status).toBe('Local.');
    await shareSyncCmd({}, deps('y'), fail);
    expect(getProjectView(vault, 'demo').status).toBe('Cloud forward.');
    expect(pendingIds()).toEqual([]);
    expect(lines.some((l) => l.startsWith('✓ Re-pushed'))).toBe(true);
  });

  it('--yes and NORTHKEEP_ASSUME_YES=1 skip the prompt', async () => {
    await sharedProject('demo', 'Local.');
    fake.cloudUpdate('project:demo', cloud('One.'));
    await shareSyncCmd({ yes: true }, deps(null), fail);
    expect(getProjectView(vault, 'demo').status).toBe('One.');
    fake.cloudUpdate('project:demo', cloud('Two.'));
    process.env.NORTHKEEP_ASSUME_YES = '1';
    await shareSyncCmd({}, deps(null), fail);
    expect(getProjectView(vault, 'demo').status).toBe('Two.');
  });

  it('a conflict is shown and never applied; resolve --take-theirs and --keep-mine settle it', async () => {
    const r1 = await sharedProject('demo', 'R1.');
    fake.cloudUpdate('project:demo', cloud('Cloud on R1.'));
    vault.updateProject({ project: 'demo', expected_revision: r1, status: 'R2 local.' });
    vault.save();
    await shareSyncCmd({}, deps(null), fail);
    expect(getProjectView(vault, 'demo').status).toBe('R2 local.');
    expect(lines.some((l) => l.includes('Conflict, not applied: demo: this Mac changed it after the cloud version was written'))).toBe(true);

    lines = [];
    await shareConflictsCmd({ show: 'demo' }, deps(), fail);
    expect(lines.some((l) => l.includes('Cloud on R1.'))).toBe(true);
    expect(lines.some((l) => l.includes('R2 local.'))).toBe(true);

    await shareResolveCmd('demo', { keepMine: true }, deps(), fail);
    expect(getProjectView(vault, 'demo').status).toBe('R2 local.');
    expect(vault.list({ scope: 'project:demo', type: 'episodic' }).map((e) => e.content.split('\n')[0])).toEqual([
      `# Cloud version not kept, ${new Date().toISOString().slice(0, 10)}`,
    ]);
    expect(pendingIds()).toEqual([]);

    const r3 = getProjectView(vault, 'demo').revision;
    await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: vault.sharedScopes(), vault });
    fake.cloudUpdate('project:demo', cloud('Cloud on R3.'));
    vault.updateProject({ project: 'demo', expected_revision: r3, status: 'R4 local.' });
    vault.save();
    await expect(shareResolveCmd('demo', { takeTheirs: true, expectedRevision: r3 }, deps(), fail)).rejects.toThrow('Project changed after it was read.');
    expect(getProjectView(vault, 'demo').status).toBe('R4 local.');
    await shareResolveCmd('demo', { takeTheirs: true }, deps(), fail);
    expect(getProjectView(vault, 'demo').status).toBe('Cloud on R3.');
  });

  it('resolve needs exactly one choice', async () => {
    await expect(shareResolveCmd('demo', {}, deps(), fail)).rejects.toThrow('Choose one: --take-theirs or --keep-mine.');
  });
});

describe('projects history and restore (D4)', () => {
  it('lists versions, previews a restore, restores with --yes, and refuses a stale expected version', async () => {
    const r1 = vault.updateProject({ project: 'demo', expected_revision: null, status: 'Good.' }).revision;
    const r2 = vault.updateProject({ project: 'demo', expected_revision: r1, status: 'Rolled back.' }).revision;
    vault.save();
    await projectsHistoryCmd('demo', withVault, fail);
    expect(lines.some((l) => l.startsWith(`  ${r1}`))).toBe(true);

    await projectsRestoreCmd('demo', r1, {}, withVault, fail);
    expect(lines).toContain('Preview only: nothing changed. Add --yes to restore.');
    expect(getProjectView(vault, 'demo').revision).toBe(r2);

    await projectsRestoreCmd('demo', r1, { yes: true }, withVault, fail);
    expect(getProjectView(vault, 'demo').status).toBe('Good.');

    await expect(projectsRestoreCmd('demo', r1, { yes: true, expectedRevision: r2 }, withVault, fail)).rejects.toThrow('Project changed after it was read.');
  });
});

describe('projects delete unshares a shared project first (recheck R-S2)', () => {
  it('deletes the scope on the connector, so a stale cloud create cannot come back on the next sync', async () => {
    vault.updateProject({ project: 'n', expected_revision: null, status: 'Mine.' });
    vault.save();
    fake.cloudCreate('project:n', cloud('Made in an app.'));
    vault.setScopeShared('project:n', true);
    vault.save();
    await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: vault.sharedScopes(), vault });
    expect(fake.rows().filter((r) => r.scope === 'project:n' && r.pending)).toHaveLength(1);

    const unshare = async (scope: string) => {
      await fetch(`${fake.url()}/client/scope/${encodeURIComponent(scope)}`, { method: 'DELETE' });
    };
    await projectsDeleteCmd('n', { yes: true }, { withVault, fail, ask: async () => null, unshare, out: (l) => lines.push(l) });
    expect(fake.rows().filter((r) => r.scope === 'project:n')).toEqual([]);
    expect(vault.sharedScopes()).not.toContain('project:n');
    expect(lines).toContain('  It was also deleted from Cloud Connect and is no longer shared.');

    await shareSyncCmd({}, deps(null), fail);
    expect(vault.list({ scope: 'project:n' })).toEqual([]);
  });

  it('a failed server delete deletes nothing anywhere', async () => {
    await sharedProject('n', 'Mine.');
    const refuse = async () => {
      throw new Error('Connector server returned HTTP 502 on unshare.');
    };
    await expect(projectsDeleteCmd('n', { yes: true }, { withVault, fail, ask: async () => null, unshare: refuse })).rejects.toThrow(
      'Could not delete project n from Cloud Connect, so nothing was deleted.',
    );
    expect(getProjectView(vault, 'n').status).toBe('Mine.');
    expect(vault.sharedScopes()).toContain('project:n');
  });
});

describe('manual pushes (D5) and the pull report (D6)', () => {
  let sync: ReturnType<typeof fakeServer>;
  beforeEach(async () => {
    sync = fakeServer();
    await new Promise<void>((r) => sync.server.listen(0, '127.0.0.1', r));
    setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
    process.env.NORTHKEEP_PASSPHRASE = PASS;
  });
  afterEach(async () => {
    await new Promise((r) => sync.server.close(r));
  });
  const key = () => {
    const header = Vault.readHeader(vaultPath());
    return deriveMasterKey(PASS, deviceSecret, header.salt, header.kdf);
  };

  it('share push syncs the vault first when ahead, and --reset-order sends reset', async () => {
    vault.remember({ content: 'shared', type: 'semantic', scope: 'work' });
    vault.setScopeShared('work', true);
    vault.save();
    await sharePushCmd({}, deps(), fail);
    expect(sync.version()).toBe(1);
    expect(fake.pushes().at(-1)?.vault?.version).toBe(1);
    await sharePushCmd({ resetOrder: true }, deps(), fail);
    expect(fake.pushes().at(-1)?.reset).toBe(true);
  });

  it('a command that saves pushes the vault, then Cloud Connect once, and only when the shared entries changed', async () => {
    vault.setScopeShared('work', true);
    vault.remember({ content: 'shared from the CLI', type: 'semantic', scope: 'work' });
    vault.save();
    const log: string[] = [];
    const opts = { vaultPath: vaultPath(), masterKey: key(), saved: true, log: (l: string) => log.push(l), loadDeviceSecret: () => Buffer.from(deviceSecret) };
    expect(await autoPushAfterWrite(opts)).toBe('pushed');
    expect(log).toEqual(['↑ synced (version 1)', '↑ Cloud Connect updated']);
    expect(fake.pushes().map((p) => p.vault?.version)).toEqual([1]);

    vault.remember({ content: 'private', type: 'semantic', scope: 'private' });
    vault.save();
    log.length = 0;
    expect(await autoPushAfterWrite({ ...opts, masterKey: key() })).toBe('pushed');
    expect(log).toEqual(['↑ synced (version 2)']);
    expect(fake.pushes()).toHaveLength(1);
  });

  it('sync pull shows what would drop and refuses with no terminal; --yes installs, keeping vault.nkv.bak', async () => {
    vault.remember({ content: 'seed', type: 'semantic' });
    vault.save();
    expect((await pushVault({ vaultPath: vaultPath(), deviceSecret, masterKey: key() })).ok).toBe(true);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-0063-other-'));
    try {
      process.env.NORTHKEEP_HOME = other;
      fs.writeFileSync(path.join(other, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
      setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
      const otherVault = path.join(other, 'vault.nkv');
      expect((await pullVault({ vaultPath: otherVault, deviceSecret })).ok).toBe(true);
      const v = Vault.openWithKey(otherVault, key());
      v.remember({ content: 'from the other device', type: 'semantic' });
      v.save();
      v.close();
      expect((await pushVault({ vaultPath: otherVault, deviceSecret, masterKey: key() })).ok).toBe(true);
    } finally {
      process.env.NORTHKEEP_HOME = home;
      fs.rmSync(other, { recursive: true, force: true });
    }
    vault.remember({ content: 'only on this Mac', type: 'semantic' });
    vault.save();
    vault.close();

    await expect(syncPull(vaultPath(), {}, fail, async () => null)).rejects.toThrow('there is no terminal to ask on. Nothing was changed.');
    expect(lines.some((l) => l.includes('"only on this Mac"'))).toBe(true);
    await syncPull(vaultPath(), { yes: true }, fail, async () => null);
    vault = Vault.openWithKey(vaultPath(), key());
    expect(vault.list().map((e) => e.content).sort()).toEqual(['from the other device', 'seed']);
    expect(fs.existsSync(`${vaultPath()}.bak`)).toBe(true);
  });
});
