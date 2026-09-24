import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { addServer, getMcpCatalogEntry, getServer } from '@northkeep/converse';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

/**
 * ADR 0060 Decision 4 (D6, F8, Jay decision 3): "This is my NorthKeep vault"
 * is offered only for the exact bundled launch with no env and no cwd, and
 * setting it needs the passphrase. The recheck's case, the bundled command
 * with NORTHKEEP_HOME pointing at another vault, is never offered.
 */

const passphrase = 'synthetic trust button passphrase';
let directory = '';
let session: UiSession;

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-trust-button-'));
  process.env.NORTHKEEP_HOME = directory;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  const vaultPath = path.join(directory, 'vault.nkv');
  Vault.create({ path: vaultPath, passphrase, deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE }).close();
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
});

afterEach(() => {
  session.autoSync.stop();
  session.lock();
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('ADR 0060 D6: the vault-trust button', () => {
  it('C14 (route): adding the vault from the catalog records it trusted', async () => {
    const r = await handleApi(session, 'POST', '/api/mcp/add', new URLSearchParams(), body({ id: 'vault', catalogId: 'vault' }));
    expect(r.status).toBe(200);
    expect(getServer('vault')!.trust).toBe('trusted');
  });

  it('C32: offered only for the exact launch with no env or cwd; the other-home entry is refused', async () => {
    const entry = getMcpCatalogEntry('vault')!;
    const other = path.join(directory, 'other-home');
    fs.mkdirSync(other);
    addServer({ id: 'plain', command: entry.command!, args: entry.args! });
    addServer({ id: 'elsewhere', command: entry.command!, args: entry.args!, env: { NORTHKEEP_HOME: other } });

    const list = await handleApi(session, 'GET', '/api/mcp', new URLSearchParams(), Buffer.alloc(0));
    const servers = (list.body as { servers: Array<{ id: string; vault_trust_offer: boolean }> }).servers;
    expect(servers.find((s) => s.id === 'plain')!.vault_trust_offer).toBe(true);
    expect(servers.find((s) => s.id === 'elsewhere')!.vault_trust_offer).toBe(false);

    const refused = await handleApi(session, 'POST', '/api/mcp/trust-vault', new URLSearchParams(), body({ id: 'elsewhere' }));
    expect(refused.status).toBe(400);
    expect(getServer('elsewhere')!.trust).toBe('strict');

    // One click, no passphrase (Jay decision 3): the catalog add of the vault
    // server already yields this same trusted entry from the same session.
    const okay = await handleApi(session, 'POST', '/api/mcp/trust-vault', new URLSearchParams(), body({ id: 'plain' }));
    expect(okay.status).toBe(200);
    expect(getServer('plain')!.trust).toBe('trusted');
  });
});
