import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret, onVaultSave, withFileLock } from '@northkeep/core';
import { deriveConnectorToken, pullDownSync, pushSharedScopes, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { startServer } from './adr0061-support.js';
import { decryptedEntries, seedEncryptedEntry } from './helpers.js';

/**
 * Merge review of the defect B fix: an acknowledgement sent after the vault
 * lock is released can land after another process forgot the pulled memory and
 * pushed, renaming the still-waiting row into a delivered one. Real in-memory
 * connector storage; a proxy slows the ack. Temp files, fictional data.
 */

const FROM_APP = 'The harbor office moved to Pier 9.';
const ACK_DELAY_MS = 400;

/** Forwards every request to the connector, holding POST /client/ack back for ACK_DELAY_MS. */
async function slowAckProxy(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.method === 'POST' && req.url === '/client/ack') await new Promise((r) => setTimeout(r, ACK_DELAY_MS));
      const headers: Record<string, string> = {};
      for (const name of ['authorization', 'content-type', 'x-nb-entitlement']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('a pull and another process that forgets the pulled memory (real in-memory connector)', () => {
  const storage = new InMemoryConnectorStorage();
  const deviceSecret = generateDeviceSecret();
  const connToken = deriveConnectorToken(deviceSecret);
  const account = tokenHash(connToken);
  const passphrase = 'harbor race passphrase';
  let tmp = '';
  let vaultPath = '';
  let base = '';
  let close: () => Promise<void> = async () => {};

  const key = () => {
    const header = Vault.readHeader(vaultPath);
    return deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
  };
  /** One locked vault section, as every NorthKeep process takes it. */
  const withVault = <T>(fn: (v: Vault) => T | Promise<T>, lock: { timeoutMs?: number } = {}) =>
    withFileLock(vaultPath, async () => {
      const v = Vault.openWithKey(vaultPath, key());
      try {
        return await fn(v);
      } finally {
        v.close();
      }
    }, lock);
  const rowsWithText = async () =>
    (await decryptedEntries(storage, account, connToken)).filter((e) => e.content === FROM_APP).map((e) => ({ id: e.entryId, pending: e.pending === true }));

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ack-race-'));
    vaultPath = path.join(tmp, 'vault.nkv');
    ({ base, close } = await startServer(() => createConnectorServer(storage)));
    const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.setScopeShared('harbor', true);
    v.remember({ content: 'The boatyard opens at seven.', type: 'semantic', scope: 'harbor' });
    v.save();
    await pushSharedScopes({ server: base, deviceSecret, scopes: ['harbor'], vault: v });
    v.close();
  }, 60_000);
  afterAll(async () => {
    await close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the forget cannot land between the save and the acknowledgement, and the forgotten memory is never served as delivered', async () => {
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'conn_pier9',
      scope: 'harbor',
      type: 'semantic',
      content: FROM_APP,
      origin: 'connector',
      pending: true,
      createdAt: new Date().toISOString(),
    });
    const proxy = await slowAckProxy(base);
    let second: Promise<{ whenItGotTheLock: Array<{ id: string; pending: boolean }>; pulledId: string }> | null = null;
    // The other process starts the moment the pull saves, and needs the lock to forget.
    const stop = onVaultSave(() => {
      if (second !== null) return;
      second = withVault(async (v) => {
        const whenItGotTheLock = await rowsWithText();
        const pulled = v.list({ scope: 'harbor' }).find((e) => e.content === FROM_APP)!;
        v.forget(pulled.id, { actor: 'owner' });
        v.save();
        await pushSharedScopes({ server: base, deviceSecret, scopes: ['harbor'], vault: v });
        return { whenItGotTheLock, pulledId: pulled.id };
      }, { timeoutMs: 5_000 });
    });
    try {
      const result = await pullDownSync({ server: proxy.url, deviceSecret, withVault: (fn) => withVault(fn) });
      expect(result.added).toBe(1);
      expect(second).not.toBeNull();
      const other = await second!;
      // It waited for the lock: by then the acknowledgement had already turned the waiting row into the delivered one.
      expect(other.whenItGotTheLock).toEqual([{ id: other.pulledId, pending: false }]);
      expect(await rowsWithText()).toEqual([]);

      await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: ['harbor'], vault: v }));
      expect(await rowsWithText()).toEqual([]);
      expect(await withVault((v) => v.list({ scope: 'harbor' }).map((e) => e.content))).toEqual(['The boatyard opens at seven.']);
    } finally {
      stop();
      await proxy.close();
    }
  });
});
