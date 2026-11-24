import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, setPlatform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { pushSharedScopes, setConnectorServer } from '@northkeep/sync';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';
import { startFakeConnector, type FakeConnector } from '../../../packages/sync/test/fake-connector.js';

/** ADR 0085 D4 on /api/share/sync, against the connector fake. Temp home only, fictional data. */

const passphrase = 'web 0085 passphrase';
const deviceSecret = Buffer.alloc(32, 6);
const prevHome = process.env.NORTHKEEP_HOME;
const PIER_4 = 'The harbor office is at Pier 4.';
const PIER_9 = 'The harbor office is now at Pier 9.';
let dir: string;
let session: UiSession;
let fake: FakeConnector;

const call = async (method: string, route: string, body?: unknown) => {
  const res = await handleApi(session, method, route, new URLSearchParams(), Buffer.from(body === undefined ? '' : JSON.stringify(body)));
  return { status: res.status, body: res.body as Record<string, unknown> };
};

async function queuedReplace(): Promise<{ oldId: string; replaceId: string }> {
  const oldId = await session.withVault(async (v) => {
    const old = v.remember({ content: PIER_4, type: 'semantic', scope: 'harbor' });
    v.setScopeShared('harbor', true);
    v.save();
    await pushSharedScopes({ server: fake.url(), deviceSecret, scopes: v.sharedScopes(), vault: v });
    return old.id;
  });
  const { replaceId } = fake.cloudReplace('harbor', PIER_9, oldId);
  return { oldId, replaceId };
}

beforeEach(async () => {
  setPlatform(nodePlatform());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-0085-'));
  process.env.NORTHKEEP_HOME = dir;
  fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  const vaultPath = path.join(dir, 'vault.nkv');
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

describe('POST /api/share/sync with a replace queued by an AI app', () => {
  it('the preview lists it in plain words and needs confirmation', async () => {
    const { oldId, replaceId } = await queuedReplace();
    const res = await call('POST', '/api/share/sync');
    expect(res.status).toBe(200);
    expect(res.body.needs_confirmation).toBe(true);
    expect(res.body.cloud_replaces).toEqual([{
      replace_id: replaceId,
      scope: 'harbor',
      old_first_line: PIER_4,
      new_first_line: PIER_9,
      line: 'Replace "The harbor office is at Pier 4." with "The harbor office is now at Pier 9."',
    }]);
    expect(oldId).not.toBe('');
  });

  it('an empty approval leaves it for review; approving it marks the old memory replaced', async () => {
    const { oldId, replaceId } = await queuedReplace();
    const first = await call('POST', '/api/share/sync', { dry_run: false, approve: {} });
    expect(first.body.cloud_replaced).toBe(0);
    expect((first.body.needs_review as { cloud_replaces: Array<{ replace_id: string }> }).cloud_replaces.map((r) => r.replace_id)).toEqual([replaceId]);
    const second = await call('POST', '/api/share/sync', { dry_run: false, approve: { replace_ids: [replaceId] } });
    expect(second.body.cloud_replaced).toBe(1);
    const live = await session.withVault((v) => v.list({ scope: 'harbor' }).map((e) => e.content));
    expect(live).toEqual([PIER_9]);
    const old = await session.withVault((v) => v.list({ scope: 'harbor', includeSuperseded: true }).find((e) => e.id === oldId));
    expect(old?.superseded_by).not.toBe(null);
    expect(fake.replaceQueue()).toEqual([]);
  });

  it('refuses replace_ids that is not a list of ids', async () => {
    await queuedReplace();
    const res = await call('POST', '/api/share/sync', { dry_run: false, approve: { replace_ids: 'rep_1' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('approve.server_ids, approve.forget_ids and approve.replace_ids must be lists of ids.');
  });
});
