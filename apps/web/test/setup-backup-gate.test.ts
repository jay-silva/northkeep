import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, defaultVaultPath, ensureDeviceSecret } from '@northkeep/core';
import { SYNC_NEEDS_BACKUP_MESSAGE, handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

// First-run backup gate: setup cannot finish, and sync cannot be turned on,
// until the person confirms they backed up the device key.
describe('first-run backup gate', () => {
  const keys = ['NORTHKEEP_HOME', 'NORTHKEEP_SECRET_BACKEND', 'NORTHKEEP_NO_KEYCHAIN', 'NORTHKEEP_PASSPHRASE', 'NORTHKEEP_MASTER_KEY'] as const;
  const prev: Record<string, string | undefined> = {};
  let home = '';
  const sessions: UiSession[] = [];

  function session(): UiSession {
    const s = new UiSession(defaultVaultPath());
    sessions.push(s);
    return s;
  }
  const call = (s: UiSession, method: string, route: string, json?: unknown) =>
    handleApi(s, method, route, new URLSearchParams(), Buffer.from(json === undefined ? '' : JSON.stringify(json)));
  const flagFile = () => path.join(home, 'setup.json');
  const syncFile = () => path.join(home, 'sync.json');

  beforeEach(() => {
    for (const k of keys) prev[k] = process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-setup-gate-'));
    process.env.NORTHKEEP_HOME = home;
    process.env.NORTHKEEP_SECRET_BACKEND = 'file';
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
    delete process.env.NORTHKEEP_PASSPHRASE;
    delete process.env.NORTHKEEP_MASTER_KEY;
  });

  afterEach(() => {
    for (const s of sessions.splice(0)) {
      s.autoSync.stop();
      s.connectorAutoPush.stop();
      s.lock();
    }
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a vault made before the gate (no flag file) counts as backed up, and sync can be turned on', async () => {
    Vault.create({ path: defaultVaultPath(), passphrase: 'old vault pass', deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE }).close();
    const s = session();
    const status = await call(s, 'GET', '/api/status');
    expect((status.body as { backup_confirmed: boolean }).backup_confirmed).toBe(true);
    const config = await call(s, 'POST', '/api/sync/config', { server_url: 'http://127.0.0.1:9' });
    expect(config.status).toBe(200);
    expect(fs.existsSync(syncFile())).toBe(true);
    expect(fs.existsSync(flagFile())).toBe(false);
  });

  it('a vault from the new setup starts unconfirmed: sync refuses until the confirm route runs', async () => {
    const s = session();
    const created = await call(s, 'POST', '/api/setup/create', { passphrase: 'new setup pass', confirm: 'new setup pass' });
    expect(created.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(flagFile(), 'utf8'))).toEqual({ backup_confirmed: false, vault_path: path.resolve(defaultVaultPath()) });

    const before = (await call(s, 'GET', '/api/status')).body as { backup_confirmed: boolean; device_secret_path: string };
    expect(before.backup_confirmed).toBe(false);
    expect(before.device_secret_path).toBe(path.join(home, 'device.secret'));

    const refused = await call(s, 'POST', '/api/sync/config', { server_url: 'http://127.0.0.1:9' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: SYNC_NEEDS_BACKUP_MESSAGE });
    expect(fs.existsSync(syncFile())).toBe(false);

    const unticked = await call(s, 'POST', '/api/setup/backup-confirmed', {});
    expect(unticked.status).toBe(400);
    expect((unticked.body as { error: string }).error).toMatch(/somewhere other than this computer/);

    const locked = await call(session(), 'POST', '/api/setup/backup-confirmed', { confirmed: true });
    expect(locked.status).toBe(423);
    expect(JSON.parse(fs.readFileSync(flagFile(), 'utf8'))).toEqual({ backup_confirmed: false, vault_path: path.resolve(defaultVaultPath()) });

    const confirmed = await call(s, 'POST', '/api/setup/backup-confirmed', { confirmed: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({ backup_confirmed: true });
    expect(fs.statSync(flagFile()).mode & 0o777).toBe(0o600);
    expect(((await call(s, 'GET', '/api/status')).body as { backup_confirmed: boolean }).backup_confirmed).toBe(true);

    const allowed = await call(s, 'POST', '/api/sync/config', { server_url: 'http://127.0.0.1:9' });
    expect(allowed.status).toBe(200);
    expect(fs.existsSync(syncFile())).toBe(true);
  }, 120_000);

  it('a damaged flag file asks again instead of counting as backed up', async () => {
    Vault.create({ path: defaultVaultPath(), passphrase: 'damaged pass', deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE }).close();
    fs.writeFileSync(flagFile(), '{ not json');
    const s = session();
    expect(((await call(s, 'GET', '/api/status')).body as { backup_confirmed: boolean }).backup_confirmed).toBe(false);
    const refused = await call(s, 'POST', '/api/sync/config', { server_url: 'http://127.0.0.1:9' });
    expect(refused.status).toBe(409);
  });

  it('the confirm route refuses when there is no vault yet', async () => {
    const res = await call(session(), 'POST', '/api/setup/backup-confirmed', { confirmed: true });
    expect(res.status).toBe(409);
    expect(fs.existsSync(flagFile())).toBe(false);
  });

  it('a flag left by setup of a different vault does not gate this one', async () => {
    Vault.create({ path: defaultVaultPath(), passphrase: 'other vault pass', deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE }).close();
    fs.writeFileSync(flagFile(), JSON.stringify({ backup_confirmed: false, vault_path: path.join(home, 'elsewhere', 'vault.nkv') }));
    const s = session();
    expect(((await call(s, 'GET', '/api/status')).body as { backup_confirmed: boolean }).backup_confirmed).toBe(true);
    expect((await call(s, 'POST', '/api/sync/config', { server_url: 'http://127.0.0.1:9' })).status).toBe(200);
  });
});
