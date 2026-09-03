import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey } from '@northkeep/core';
import { deriveSyncCreds, setSyncServer } from '@northkeep/sync';
import { NOT_UNLOCKED_HINT, autoPushAfterWrite, trackSaves } from '../src/autoPush.js';

/**
 * ADR 0044 push-on-exit for the CLI: a command that saved the vault pushes
 * once, prints one line, and never changes the exit path on failure.
 */

function fakeServer(mode: { crash: boolean }): { server: Server; url: () => string; version: () => number } {
  let blob: Buffer | null = null;
  let version = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (mode.crash) {
        res.writeHead(500).end();
        return;
      }
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      if (req.method === 'GET' && req.url === '/api/status') {
        if (blob === null) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ version, sha256: sha(blob), size: blob.length, updatedAt: '' }));
      }
      if (req.method === 'PUT' && req.url === '/api/blob') {
        const base = Number(req.headers['x-base-version'] ?? '0');
        if (base !== version) {
          res.writeHead(409, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ version }));
        }
        blob = Buffer.concat(chunks);
        version += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ version }));
      }
      res.writeHead(404).end();
    });
  });
  return { server, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, version: () => version };
}

describe('autoPushAfterWrite', () => {
  const savedEnv = { ...process.env };
  const passphrase = 'cli auto push';
  const deviceSecret = Buffer.alloc(32, 9);
  const mode = { crash: false };
  let home: string;
  let fake: ReturnType<typeof fakeServer>;
  let lines: string[];
  const vaultPath = () => path.join(home, 'vault.nkv');
  const key = () => {
    const h = Vault.readHeader(vaultPath());
    return deriveMasterKey(passphrase, deviceSecret, h.salt, h.kdf);
  };

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-autopush-'));
    process.env.NORTHKEEP_HOME = home;
    mode.crash = false;
    fake = fakeServer(mode);
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    lines = [];
    const v = Vault.create({ path: vaultPath(), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    v.close();
    fs.writeFileSync(path.join(home, 'device.secret'), deviceSecret.toString('hex'));
  });
  afterEach(async () => {
    process.env = { ...savedEnv };
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const configure = () => setSyncServer(fake.url(), deriveSyncCreds(deviceSecret).accountId);
  const log = (l: string) => lines.push(l);

  it('trackSaves reports whether the vault was saved inside fn', async () => {
    const readOnly = await trackSaves(vaultPath(), async () => {
      const v = Vault.openWithKey(vaultPath(), key());
      v.list();
      v.close();
      return 1;
    });
    expect(readOnly).toEqual({ result: 1, saved: false });
    const write = await trackSaves(vaultPath(), async () => {
      const v = Vault.openWithKey(vaultPath(), key());
      v.remember({ content: 'x', type: 'semantic' });
      v.save();
      v.close();
    });
    expect(write.saved).toBe(true);
  });

  it('pushes once after a saved write and prints the synced line', async () => {
    configure();
    const outcome = await autoPushAfterWrite({ vaultPath: vaultPath(), masterKey: key(), saved: true, log });
    expect(outcome).toBe('pushed');
    expect(fake.version()).toBe(1);
    expect(lines).toEqual(['↑ synced (version 1)']);
  });

  it('does nothing for a read-only command or when sync is not configured', async () => {
    expect(await autoPushAfterWrite({ vaultPath: vaultPath(), masterKey: key(), saved: false, log })).toBe('skipped');
    expect(await autoPushAfterWrite({ vaultPath: vaultPath(), masterKey: key(), saved: true, log })).toBe('not-configured');
    expect(fake.version()).toBe(0);
    expect(lines).toEqual([]);
  });

  it('skips with a hint when the key came from a prompt', async () => {
    configure();
    expect(await autoPushAfterWrite({ vaultPath: vaultPath(), masterKey: null, saved: true, log })).toBe('locked');
    expect(lines).toEqual([NOT_UNLOCKED_HINT]);
    expect(fake.version()).toBe(0);
  });

  it('a failed push is reported in one line and resolves rather than throwing', async () => {
    configure();
    mode.crash = true;
    await expect(
      autoPushAfterWrite({ vaultPath: vaultPath(), masterKey: key(), saved: true, log }),
    ).resolves.toBe('failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^sync: .*HTTP 500.*Run "northkeep sync push" later\.$/);
  });
});
