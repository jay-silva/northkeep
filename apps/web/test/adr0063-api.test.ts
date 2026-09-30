import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, getProjectView, setPlatform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { deriveSyncCreds, pullVault, pushSharedScopes, pushVault, setConnectorServer, setSyncServer } from '@northkeep/sync';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';
import { startFakeConnector, type FakeConnector } from '../../../packages/sync/test/fake-connector.js';
import { fakeServer } from '../../../packages/sync/test/fake-sync-server.js';

/**
 * ADR 0063 API routes the three new screens will use, against the protocol
 * fake of the connector (packages/sync/test/fake-connector.ts). Temp home only.
 */

const passphrase = 'web 0063 passphrase';
const deviceSecret = Buffer.alloc(32, 5);
const prevHome = process.env.NORTHKEEP_HOME;
let dir: string;
let vaultPath: string;
let session: UiSession;
let fake: FakeConnector;

const call = async (method: string, route: string, body?: unknown) => {
  const res = await handleApi(session, method, route, new URLSearchParams(), Buffer.from(body === undefined ? '' : JSON.stringify(body)));
  return { status: res.status, body: res.body as Record<string, unknown> };
};
const cloud = (status: string) => `## What & Why\nDemo.\n\n## Current Status\n${status}\n`;
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);
const view = (slug: string) => session.withVault((v) => getProjectView(v, slug, undefined, { history: true }));

async function sharedProject(slug: string, status: string): Promise<string> {
  return session.withVault(async (v) => {
    const r = v.updateProject({ project: slug, expected_revision: null, what_why: 'Demo.', status }).revision;
    v.setScopeShared(`project:${slug}`, true);
    v.save();
    await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: v.sharedScopes(), vault: v });
    return r;
  });
}

beforeEach(async () => {
  setPlatform(nodePlatform());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-0063-'));
  process.env.NORTHKEEP_HOME = dir;
  fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  vaultPath = path.join(dir, 'vault.nkv');
  const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  v.save();
  v.close();
  fake = await startFakeConnector();
  setConnectorServer(fake.url());
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
});
afterEach(async () => {
  session.autoSync.stop();
  session.connectorAutoPush.stop();
  session.lock();
  await fake.close();
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/share/sync (D3)', () => {
  it('previews by default and writes nothing', async () => {
    await sharedProject('demo', 'Local.');
    const forward = fake.cloudUpdate('project:demo', cloud('Forward.'));
    await call('GET', '/api/share/status'); // runs the one-time ADR 0038 fold, which saves
    const before = fs.readFileSync(vaultPath);
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.needs_confirmation).toBe(true);
    expect(res.body.replacements).toEqual([{ project: 'demo', server_id: forward, local_revision: expect.any(String) }]);
    expect(fs.readFileSync(vaultPath).equals(before)).toBe(true);
  });

  it("the Sync now button's empty approval applies additions only and names what needs review", async () => {
    await sharedProject('demo', 'Local.');
    const forward = fake.cloudUpdate('project:demo', cloud('Forward.'));
    fake.cloudRemember('project:demo', 'A note from the app.');
    const res = await call('POST', '/api/share/sync', { dry_run: false, approve: {} });
    expect(res.status).toBe(200);
    expect([res.body.added, res.body.replaced]).toEqual([1, 0]);
    expect(res.body.review_messages).toEqual(['1 change needs your review before it is applied. Run: northkeep share sync']);
    expect((await view('demo')).status).toBe('Local.');
    expect(pendingIds()).toEqual([forward]);
  });

  it('applies an approved replacement', async () => {
    await sharedProject('demo', 'Local.');
    const forward = fake.cloudUpdate('project:demo', cloud('Forward.'));
    const res = await call('POST', '/api/share/sync', { dry_run: false, approve: { server_ids: [forward] } });
    expect(res.body.replaced).toBe(1);
    expect((await view('demo')).status).toBe('Forward.');
  });
});

describe('conflicts and resolve (D1)', () => {
  it('lists both texts, then take theirs applies the cloud version over the head the user saw', async () => {
    const r1 = await sharedProject('demo', 'R1.');
    const cloudId = fake.cloudUpdate('project:demo', cloud('Cloud on R1.'));
    const r2 = await session.withVault((v) => {
      const r = v.updateProject({ project: 'demo', expected_revision: r1, status: 'R2.' }).revision;
      v.save();
      return r;
    });
    const list = await call('GET', '/api/share/conflicts');
    expect((list.body.conflicts as Array<Record<string, unknown>>).map((c) => [c.project, c.server_id, c.reason, c.in_history])).toEqual([['demo', cloudId, 'moved', false]]);
    expect((list.body.local as Record<string, { revision: string }>).demo!.revision).toBe(r2);

    const stale = await call('POST', '/api/share/resolve', { project: 'demo', choice: 'take-theirs', expected_revision: r1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'stale_project']);

    const res = await call('POST', '/api/share/resolve', { project: 'demo', choice: 'take-theirs', expected_revision: r2 });
    expect(res.status).toBe(200);
    expect((await view('demo')).status).toBe('Cloud on R1.');
    expect(pendingIds()).toEqual([]);
  });
});

describe('POST /api/projects/<slug>/restore (D4)', () => {
  it('restores an earlier version bound to the current head, and refuses a stale one', async () => {
    const r1 = await session.withVault((v) => {
      const r = v.updateProject({ project: 'demo', expected_revision: null, status: 'Good.' }).revision;
      v.save();
      return r;
    });
    const r2 = await session.withVault((v) => {
      const r = v.updateProject({ project: 'demo', expected_revision: r1, status: 'Bad.' }).revision;
      v.save();
      return r;
    });
    const res = await call('POST', '/api/projects/demo/restore', { revision: r1, expected_revision: r2 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Good.');
    const stale = await call('POST', '/api/projects/demo/restore', { revision: r1, expected_revision: r2 });
    expect([stale.status, stale.body.code]).toEqual([409, 'stale_project']);
  });
});

describe('DELETE /api/projects/<slug> unshares first (recheck R-S2)', () => {
  it('deletes the scope from the connector and unmarks it with the local delete', async () => {
    await sharedProject('n', 'Mine.');
    fake.cloudCreate('project:n', cloud('Stale create.'));
    const res = await call('DELETE', '/api/projects/n');
    expect(res.status).toBe(200);
    expect(res.body.unshared).toBe(true);
    expect(fake.rows().filter((r) => r.scope === 'project:n')).toEqual([]);
    expect(await session.withVault((v) => v.sharedScopes())).not.toContain('project:n');
  });

  it('deletes nothing when the connector refuses', async () => {
    await sharedProject('n', 'Mine.');
    fake.failNext('/client/scope/project%3An', 502);
    const res = await call('DELETE', '/api/projects/n');
    expect([res.status, res.body.code]).toEqual([502, 'unshare_failed']);
    expect((await view('n')).status).toBe('Mine.');
  });
});

describe('automatic push switch and status (D5)', () => {
  it('reports on by default, turns off, and reports why', async () => {
    const on = await call('GET', '/api/share/auto-push');
    expect(on.body.enabled).toBe(true);
    const off = await call('POST', '/api/share/auto-push', { enabled: false });
    expect([off.body.enabled, off.body.reason]).toEqual([false, 'switched_off']);
    const status = await call('GET', '/api/share/status');
    expect((status.body.auto_push as Record<string, unknown>).enabled).toBe(false);
  });
});

describe('POST /api/sync/pull (D6)', () => {
  let sync: ReturnType<typeof fakeServer>;
  beforeEach(async () => {
    sync = fakeServer();
    await new Promise<void>((r) => sync.server.listen(0, '127.0.0.1', r));
    setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
  });
  afterEach(async () => {
    await new Promise((r) => sync.server.close(r));
  });
  const key = (p: string) => {
    const header = Vault.readHeader(p);
    return deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
  };

  it('answers 409 with the drop report, installs only on a confirm naming that report', async () => {
    expect((await pushVault({ vaultPath, deviceSecret, masterKey: key(vaultPath) })).ok).toBe(true);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-0063-other-'));
    try {
      process.env.NORTHKEEP_HOME = other;
      setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
      const otherVault = path.join(other, 'vault.nkv');
      expect((await pullVault({ vaultPath: otherVault, deviceSecret })).ok).toBe(true);
      const v = Vault.openWithKey(otherVault, key(otherVault));
      v.remember({ content: 'from the other device', type: 'semantic' });
      v.save();
      v.close();
      expect((await pushVault({ vaultPath: otherVault, deviceSecret, masterKey: key(otherVault) })).ok).toBe(true);
    } finally {
      process.env.NORTHKEEP_HOME = dir;
      fs.rmSync(other, { recursive: true, force: true });
    }
    await session.withVault((v) => {
      v.remember({ content: 'only on this Mac', type: 'semantic' });
      v.save();
    });

    const first = await call('POST', '/api/sync/pull');
    expect([first.status, first.body.code]).toEqual([409, 'pull_would_drop']);
    expect((first.body.report as { only_here: unknown[] }).only_here).toEqual([{ scope: 'personal', first_line: 'only on this Mac' }]);

    const wrong = await call('POST', '/api/sync/pull', { confirm: true, version: first.body.version, sha256: '0'.repeat(64) });
    expect([wrong.status, wrong.body.code]).toEqual([409, 'remote_changed']);

    const res = await call('POST', '/api/sync/pull', { confirm: true, version: wrong.body.version, sha256: wrong.body.sha256 });
    expect(res.status).toBe(200);
    expect(await session.withVault((v) => v.list().map((e) => e.content))).toEqual(['from the other device']);
  });
});
