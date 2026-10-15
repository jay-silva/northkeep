import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultVaultPath, deviceSecretPath, northkeepHome } from '@northkeep/core';
import { masterKeyFilePath } from '@northkeep/mcp-server';
import { handleApi } from '../src/api.js';
import { devicePhrase } from '../src/device-phrase.js';
import { UiSession } from '../src/session.js';

const VAULT_FILES = ['vault.nkv', 'device.secret', 'master.key'] as const;

function absent(dir: string): void {
  for (const name of VAULT_FILES) {
    expect(fs.existsSync(path.join(dir, name)), name).toBe(false);
    expect(fs.existsSync(path.join(dir, '.northkeep', name)), `.northkeep/${name}`).toBe(false);
  }
}

describe('device phrase for the welcome and unlock dialogs', () => {
  it('names Linux and Windows without calling them a Mac', () => {
    expect(devicePhrase('darwin')).toBe('this Mac');
    expect(devicePhrase('linux')).toBe('this Linux computer');
    expect(devicePhrase('win32')).toBe('this Windows PC');
    expect(devicePhrase('freebsd')).toBe('this computer');
  });

  it('the dialogs take the phrase from status before they are shown', () => {
    const html = fs.readFileSync(fileURLToPath(new URL('../static/index.html', import.meta.url)), 'utf8');
    expect(html).toContain('id="setupLead"');
    expect(html).toContain('id="unlockLead"');
    expect(html).toContain('applyDevicePhrase(status.device_phrase)');
    const setup = html.slice(html.indexOf('id="setupLead"'), html.indexOf('id="setupErr"'));
    const unlock = html.slice(html.indexOf('id="unlockLead"'), html.indexOf('id="unlockErr"'));
    expect(setup).not.toContain('Mac');
    expect(unlock).not.toContain('Mac');
  });
});

// On macOS the file backend is ignored, so unlock and lock would use the real Keychain.
describe.runIf(process.platform === 'linux')('NORTHKEEP_HOME on the desktop server', () => {
  const prev = {
    home: process.env.NORTHKEEP_HOME,
    userHome: process.env.HOME,
    backend: process.env.NORTHKEEP_SECRET_BACKEND,
    noKeychain: process.env.NORTHKEEP_NO_KEYCHAIN,
    passphrase: process.env.NORTHKEEP_PASSPHRASE,
    master: process.env.NORTHKEEP_MASTER_KEY,
  };
  let root = '';
  let session: UiSession | undefined;

  afterEach(() => {
    session?.autoSync.stop();
    session?.connectorAutoPush.stop();
    session?.lock();
    for (const [key, value] of [
      ['NORTHKEEP_HOME', prev.home],
      ['HOME', prev.userHome],
      ['NORTHKEEP_SECRET_BACKEND', prev.backend],
      ['NORTHKEEP_NO_KEYCHAIN', prev.noKeychain],
      ['NORTHKEEP_PASSPHRASE', prev.passphrase],
      ['NORTHKEEP_MASTER_KEY', prev.master],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the vault, device secret, and master key only under NORTHKEEP_HOME', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-linux-home-'));
    const home = path.join(root, 'explicit');
    const decoy = path.join(root, 'account-home');
    fs.mkdirSync(decoy, { mode: 0o700 });
    process.env.HOME = decoy;
    process.env.NORTHKEEP_HOME = home;
    process.env.NORTHKEEP_SECRET_BACKEND = 'file';
    delete process.env.NORTHKEEP_NO_KEYCHAIN;
    delete process.env.NORTHKEEP_PASSPHRASE;
    delete process.env.NORTHKEEP_MASTER_KEY;

    expect(northkeepHome()).toBe(home);
    expect(fs.existsSync(home)).toBe(false);

    session = new UiSession(defaultVaultPath());
    const before = await handleApi(session, 'GET', '/api/status', new URLSearchParams(), Buffer.alloc(0));
    expect(before.status).toBe(200);
    const beforeBody = before.body as { vault_exists: boolean; vault_path: string; device_phrase: string; platform: string };
    expect(beforeBody.vault_exists).toBe(false);
    expect(beforeBody.vault_path).toBe(path.join(home, 'vault.nkv'));
    expect(beforeBody.platform).toBe(process.platform);
    expect(beforeBody.device_phrase).toBe(devicePhrase(process.platform));
    expect(fs.existsSync(home)).toBe(false);
    absent(decoy);

    const passphrase = 'linux home passphrase';
    const created = await handleApi(
      session,
      'POST',
      '/api/setup/create',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ passphrase, confirm: passphrase })),
    );
    expect(created.status).toBe(200);
    const createdBody = created.body as { vault_path: string; device_secret_path: string };
    expect(createdBody.vault_path).toBe(path.join(home, 'vault.nkv'));
    expect(createdBody.device_secret_path).toBe(path.join(home, 'device.secret'));
    expect(deviceSecretPath()).toBe(path.join(home, 'device.secret'));
    expect(fs.statSync(path.join(home, 'device.secret')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, 'vault.nkv')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(home, 'master.key'))).toBe(false);
    absent(decoy);

    session.lock();
    const unlocked = await handleApi(
      session,
      'POST',
      '/api/unlock',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ passphrase, remember: true })),
    );
    expect(unlocked.status).toBe(200);
    expect(masterKeyFilePath()).toBe(path.join(home, 'master.key'));
    expect(fs.statSync(masterKeyFilePath()).mode & 0o777).toBe(0o600);
    const stored = fs.readFileSync(masterKeyFilePath(), 'utf8').trim();
    expect(stored).toMatch(/^[0-9a-f]{64}$/i);
    const body = JSON.stringify(unlocked.body);
    expect(body).not.toContain(stored);
    expect(body).not.toContain(passphrase);
    absent(decoy);
  }, 120_000);
});
