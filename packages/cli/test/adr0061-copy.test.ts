import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, type Vault as VaultType } from '@northkeep/core';
import { LAPSED_UNSHARE_HINT, UNSHARE_FAILED_MESSAGE, setConnectorServer } from '@northkeep/sync';
import { sharePushCmd, shareRemoveCmd, type WithVault } from '../src/shareCmd.js';

/** ADR 0061 claim 20 on the CLI. */

const deviceSecret = generateDeviceSecret();
const priorHome = process.env.NORTHKEEP_HOME;
let home = '';
let vault: VaultType;

const withVault: WithVault = async (fn) => fn(vault);
const fail = (m: string): never => {
  throw new Error(`FAIL: ${m}`);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-0061-'));
  process.env.NORTHKEEP_HOME = home;
  fs.writeFileSync(path.join(home, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  setConnectorServer('http://127.0.0.1:9');
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: 'cli 0061', deviceSecret, kdf: KDF_INTERACTIVE });
  vault.setScopeShared('work', true);
  vault.save();
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 402 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vault.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0061 CLI copy', () => {
  it('a failed unshare says the scope is still Shared and keeps the mark', async () => {
    await expect(shareRemoveCmd('work', withVault, fail)).rejects.toThrow(`FAIL: ${UNSHARE_FAILED_MESSAGE}`);
    expect(vault.sharedScopes()).toContain('work');
  });

  it('a 402 on push carries the unshare sentence', async () => {
    await expect(sharePushCmd(withVault, fail)).rejects.toThrow(LAPSED_UNSHARE_HINT);
  });
});
