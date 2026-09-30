import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { KDF_INTERACTIVE, Vault, deriveMasterKey } from '@northkeep/core';
import {
  applyDownSync,
  ConnectorAutoPush,
  deriveConnectorToken,
  deriveSyncCreds,
  pullVault,
  pushVault,
  setConnectorServer,
  setSyncServer,
  startPairing,
  syncState,
  tokenHash,
} from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { connectMcpApp, pgliteAsNeon, startServer, TEST_PEPPER_B64, withEnv } from './adr0061-support.js';
import { fakeServer } from '../../../packages/sync/test/fake-sync-server.js';

/**
 * ADR 0063 D5 against the real connector on both stores and the repo's fake
 * sync server. The build review's P1: the phone (additions-only down-sync, no
 * push to Cloud Connect) acks a cloud memory and later forgets it; the Mac,
 * asleep in between, pulls the newest vault and is exactly in sync with no
 * write of its own. Its automatic push must still take the memory off Cloud
 * Connect, because it compares with what the connector holds.
 */

const passphrase = 'adr0063 autopush passphrase';

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0063 D5 automatic push, real connector (${kind})`, () => {
    let storage: ConnectorStorage;
    let base = '';
    let close: () => Promise<void> = async () => {};
    const sync = fakeServer();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nk-0063-autopush-${kind}-`));
    const home0 = process.env.NORTHKEEP_HOME;

    beforeAll(async () => {
      await new Promise<void>((r) => sync.server.listen(0, '127.0.0.1', r));
      if (kind === 'memory') storage = new InMemoryConnectorStorage();
      else {
        const s = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite(), { numbersAsStrings: true }));
        await s.ensureSchema();
        storage = s;
      }
      await withEnv({ CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64 }, async () => {
        ({ base, close } = await startServer(() => createConnectorServer(storage, { tombstoneEnforce: true })));
      });
      if (kind === 'pglite') process.env.CONNECTOR_KEK_PEPPER = TEST_PEPPER_B64;
    }, 60_000);
    afterAll(async () => {
      await close();
      await new Promise((r) => sync.server.close(r));
      delete process.env.CONNECTOR_KEK_PEPPER;
      process.env.NORTHKEEP_HOME = home0;
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('P1: a memory acked and then deleted on the phone leaves Cloud Connect on the in-sync Mac\'s next run', async () => {
      const deviceSecret = Buffer.alloc(32, 3);
      const homeA = path.join(root, 'mac');
      const homeB = path.join(root, 'phone');
      fs.mkdirSync(homeA);
      fs.mkdirSync(homeB);
      const vp = (h: string) => path.join(h, 'vault.nkv');
      const key = (h: string) => {
        const hd = Vault.readHeader(vp(h));
        return deriveMasterKey(passphrase, deviceSecret, hd.salt, hd.kdf);
      };
      const at = (h: string) => {
        process.env.NORTHKEEP_HOME = h;
      };
      const open = (h: string) => Vault.openWithKey(vp(h), key(h));

      at(homeA);
      const a = Vault.create({ path: vp(homeA), passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
      a.remember({ content: 'x: kept memory', type: 'semantic', scope: 'work' });
      a.setScopeShared('work', true);
      a.save();
      a.close();
      setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
      setConnectorServer(base);
      expect((await pushVault({ vaultPath: vp(homeA), deviceSecret, masterKey: key(homeA) })).ok).toBe(true);
      const engine = new ConnectorAutoPush({
        vaultPath: vp(homeA),
        getMasterKey: () => key(homeA),
        loadDeviceSecret: () => Buffer.from(deviceSecret),
        allowAnyVault: true,
        entitlement: async () => undefined,
      });
      expect((await engine.runOnce()).phase).toBe('idle');
      const account = tokenHash(deriveConnectorToken(deviceSecret));
      const workRows = async () => (await storage.listEntries(account)).filter((e) => e.scope === 'work').length;
      expect(await workRows()).toBe(1);

      const app = await connectMcpApp(base, await startPairing({ server: base, deviceSecret }));
      const mcp = async (name: string, args: Record<string, unknown>) => (await app(name, args)).text;
      expect(await mcp('memory_remember', { content: 'y: SECRET the user later deletes', type: 'semantic', scope: 'work' })).not.toBe('');

      at(homeB);
      setSyncServer(sync.url(), deriveSyncCreds(deviceSecret).accountId);
      expect((await pullVault({ vaultPath: vp(homeB), deviceSecret })).ok).toBe(true);
      let b = open(homeB);
      const down = await applyDownSync({ server: base, deviceSecret, vault: b, additiveOnly: true });
      const yId = b.list({ scope: 'work' }).find((e) => e.content.startsWith('y:'))!.id;
      b.close();
      expect(down.added).toBe(1);
      expect((await pushVault({ vaultPath: vp(homeB), deviceSecret, masterKey: key(homeB) })).ok).toBe(true);
      b = open(homeB);
      b.forget(yId);
      b.save();
      b.close();
      expect((await pushVault({ vaultPath: vp(homeB), deviceSecret, masterKey: key(homeB) })).ok).toBe(true);
      expect((await mcp('memory_list', { scope: 'work' })).includes('SECRET')).toBe(true);

      at(homeA);
      expect((await pullVault({ vaultPath: vp(homeA), deviceSecret, masterKey: key(homeA) })).ok).toBe(true);
      expect((await syncState({ vaultPath: vp(homeA), deviceSecret })).state).toBe('in-sync');
      const run = await engine.runOnce();
      expect([run.phase, run.reason]).toEqual(['idle', null]);
      expect((await mcp('memory_list', { scope: 'work' })).includes('SECRET')).toBe(false);
      expect(await workRows()).toBe(1);

      const before = (await storage.listEntries(account)).map((e) => `${e.entryId} ${e.writeSeq}`).sort();
      await engine.runOnce();
      await engine.runOnce();
      expect((await storage.listEntries(account)).map((e) => `${e.entryId} ${e.writeSeq}`).sort()).toEqual(before);

      await mcp('memory_remember', { content: 'z: applied on the Mac', type: 'semantic', scope: 'work' });
      const m = open(homeA);
      try {
        expect((await applyDownSync({ server: base, deviceSecret, vault: m })).added).toBe(1);
      } finally {
        m.close();
      }
      expect((await pushVault({ vaultPath: vp(homeA), deviceSecret, masterKey: key(homeA) })).ok).toBe(true);
      await engine.runOnce();
      const local = open(homeA);
      const want = local.list({ scope: 'work' }).map((e) => `${e.id} ${e.entry_hash}`).sort();
      local.close();
      const held = async () => (await storage.listEntries(account)).filter((e) => e.scope === 'work').map((e) => `${e.entryId} ${e.entryHash}`).sort();
      expect(await held()).toEqual(want);
      const settled = (await storage.listEntries(account)).map((e) => `${e.entryId} ${e.writeSeq}`).sort();
      await engine.runOnce();
      await engine.runOnce();
      expect((await storage.listEntries(account)).map((e) => `${e.entryId} ${e.writeSeq}`).sort()).toEqual(settled);
    });
  });
}
