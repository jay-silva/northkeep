import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, ensureDeviceSecret } from '@northkeep/core';
import { masterKeyFilePath } from '@northkeep/mcp-server';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

describe('POST /api/unlock remember on the file store', () => {
  const prev = {
    home: process.env.NORTHKEEP_HOME,
    backend: process.env.NORTHKEEP_SECRET_BACKEND,
    noKeychain: process.env.NORTHKEEP_NO_KEYCHAIN,
    passphrase: process.env.NORTHKEEP_PASSPHRASE,
    master: process.env.NORTHKEEP_MASTER_KEY,
  };
  let dir = '';

  afterEach(() => {
    for (const [key, value] of [
      ['NORTHKEEP_HOME', prev.home],
      ['NORTHKEEP_SECRET_BACKEND', prev.backend],
      ['NORTHKEEP_NO_KEYCHAIN', prev.noKeychain],
      ['NORTHKEEP_PASSPHRASE', prev.passphrase],
      ['NORTHKEEP_MASTER_KEY', prev.master],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a mode-0600 file and does not return the key', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-unlock-file-'));
    process.env.NORTHKEEP_HOME = dir;
    process.env.NORTHKEEP_SECRET_BACKEND = 'file';
    delete process.env.NORTHKEEP_NO_KEYCHAIN;
    delete process.env.NORTHKEEP_PASSPHRASE;
    delete process.env.NORTHKEEP_MASTER_KEY;
    const passphrase = 'correct horse battery';
    const { secret } = ensureDeviceSecret();
    const vaultPath = path.join(dir, 'vault.nkv');
    Vault.create({
      path: vaultPath,
      passphrase,
      deviceSecret: secret,
      kdf: KDF_INTERACTIVE,
    }).close();

    const res = await handleApi(
      new UiSession(vaultPath),
      'POST',
      '/api/unlock',
      new URLSearchParams(),
      Buffer.from(JSON.stringify({ passphrase, remember: true })),
    );
    expect(res.status).toBe(200);
    const stored = fs.readFileSync(masterKeyFilePath(), 'utf8').trim();
    expect(stored).toMatch(/^[0-9a-f]{64}$/i);
    expect(fs.statSync(masterKeyFilePath()).mode & 0o777).toBe(0o600);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(stored);
    expect(body).not.toContain(passphrase);
    expect(body).toContain('file');
    expect(body).toContain('Secret Service is not available');
  });
});
