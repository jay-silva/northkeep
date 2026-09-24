import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, setPlatform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { LAPSED_UNSHARE_HINT, UNSHARE_FAILED_MESSAGE, setConnectorServer } from '@northkeep/sync';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

/**
 * ADR 0061 claim 20 on the desktop: a failed unshare says the scope is still
 * Shared (never a raw status or subscription copy) and keeps the mark; a 402
 * on share carries the "you can still unshare" sentence.
 */

describe('ADR 0061 desktop copy', () => {
  const prevHome = process.env.NORTHKEEP_HOME;
  const passphrase = 'adr0061 web copy';
  const deviceSecret = Buffer.alloc(32, 9);
  let dir: string;
  let session: UiSession;
  const call = (method: string, route: string, body: unknown = '') =>
    handleApi(session, method, route, new URLSearchParams(), Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));

  beforeEach(async () => {
    setPlatform(nodePlatform());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-0061-'));
    process.env.NORTHKEEP_HOME = dir;
    fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
    const vaultPath = path.join(dir, 'vault.nkv');
    const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.setScopeShared('work', true);
    v.save();
    v.close();
    session = new UiSession(vaultPath);
    setConnectorServer('http://127.0.0.1:9');
    await session.unlock(passphrase);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    session.autoSync.stop();
    session.lock();
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed unshare shows the still-Shared copy and keeps the mark', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 402 }));
    const res = await call('POST', '/api/share/remove', { scope: 'work' });
    expect(res.status).toBe(502);
    const error = (res.body as { error: string }).error;
    expect(error).toBe(UNSHARE_FAILED_MESSAGE);
    expect(error).not.toMatch(/402|subscription/i);
    const still = await session.withVault((v) => v.sharedScopes());
    expect(still).toContain('work');
  });

  it('a 402 on share adds the unshare sentence', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 402 }));
    const res = await call('POST', '/api/share/add', { scope: 'personal' });
    expect(res.status).toBe(402);
    expect((res.body as { error: string }).error).toContain(LAPSED_UNSHARE_HINT);
  });

  it('the new copy has no em dash', () => {
    expect(UNSHARE_FAILED_MESSAGE + LAPSED_UNSHARE_HINT).not.toMatch(/\u2014/);
  });
});
