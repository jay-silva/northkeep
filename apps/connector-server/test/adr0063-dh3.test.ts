import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { applyDownSync, fetchPending, planDownSync, pushSharedScopes, resolveConflict, startPairing } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { connectMcpApp, pgliteAsNeon, startServer, TEST_PEPPER_B64, withEnv } from './adr0061-support.js';

/**
 * Build recheck DH3, on both stores. A private project deleted here and then
 * created again by a connected app is held as deleted_here. Holding it must
 * never mark the scope Shared: keep mine leaves it private, so a later local
 * note there never reaches a connected app. Take theirs applies the create
 * and marks the scope, as the ADR 0050 fold does.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-dh3-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0063 DH3: a held deleted_here create never shares the scope (${kind})`, () => {
    let storage: ConnectorStorage;
    let base = '';
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
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
      delete process.env.CONNECTOR_KEK_PEPPER;
    });

    async function deletedPrivateProjectRecreatedInCloud(name: string) {
      const deviceSecret = generateDeviceSecret();
      const vault = Vault.create({ path: path.join(tmpRoot, `${name}-${kind}.nkv`), passphrase: 'dh3 pass', deviceSecret, kdf: KDF_INTERACTIVE });
      vault.remember({ content: 'work seed', type: 'semantic', scope: 'work' });
      vault.setScopeShared('work', true);
      vault.remember({ content: '# old private n\n\nold', type: 'working', scope: 'project:n' });
      vault.save();
      await pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
      vault.deleteProject('n');
      vault.save();
      const mcp = await connectMcpApp(base, await startPairing({ server: base, deviceSecret }));
      expect((await mcp('project_create', { project: 'n', what_why: 'CLOUD n.', status: 'new' })).isError).toBe(false);
      return { deviceSecret, vault, mcp };
    }

    it('Mac: the plan marks nothing, the down-sync leaves project:n private, and keep mine keeps it private', async () => {
      const { deviceSecret, vault, mcp } = await deletedPrivateProjectRecreatedInCloud('keep');
      try {
        const plan = planDownSync({ vault, pending: await fetchPending({ server: base, deviceSecret }) });
        expect(plan.conflicts.map((c) => [c.project, c.reason])).toEqual([['n', 'deleted_here']]);
        expect(plan.additions).toEqual([]);
        expect(plan.to_mark).toEqual([]);

        expect((await applyDownSync({ server: base, deviceSecret, vault })).added).toBe(0);
        expect(vault.sharedScopes()).toEqual(['work']);

        const keep = await resolveConflict({ server: base, deviceSecret, vault, project: 'n', choice: 'keep-mine' });
        expect(keep.choice).toBe('keep-mine');
        expect(vault.sharedScopes()).toEqual(['work']);

        vault.remember({ content: 'PRIVATE: a note the user never shared', type: 'semantic', scope: 'project:n' });
        vault.save();
        await pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
        const listed = await mcp('memory_list', { scope: 'project:n' });
        const reads = listed.text.includes('PRIVATE: a note');
        console.log(`DH3 (${kind}) connected app reads the later private note: ${reads}`);
        expect(reads).toBe(false);
      } finally {
        vault.close();
      }
    });

    it('Mac: take theirs applies the create and marks project:n Shared in the same save', async () => {
      const { deviceSecret, vault } = await deletedPrivateProjectRecreatedInCloud('theirs');
      try {
        await applyDownSync({ server: base, deviceSecret, vault });
        expect(vault.sharedScopes()).toEqual(['work']);
        await resolveConflict({ server: base, deviceSecret, vault, project: 'n', choice: 'take-theirs' });
        expect(getProjectView(vault, 'n').content).toContain('CLOUD n.');
        expect(vault.sharedScopes()).toEqual(['project:n', 'work']);
        const reopened = Vault.open({ path: path.join(tmpRoot, `theirs-${kind}.nkv`), passphrase: 'dh3 pass', deviceSecret });
        try {
          expect(reopened.sharedScopes()).toEqual(['project:n', 'work']);
        } finally {
          reopened.close();
        }
      } finally {
        vault.close();
      }
    });

    it('phone: an additive-only down-sync adds nothing and leaves project:n private', async () => {
      const { deviceSecret, vault } = await deletedPrivateProjectRecreatedInCloud('phone');
      try {
        const res = await applyDownSync({ server: base, deviceSecret, vault, additiveOnly: true });
        expect(res.added).toBe(0);
        expect(res.conflicts.map((c) => c.reason)).toEqual(['deleted_here']);
        expect(vault.sharedScopes()).toEqual(['work']);
        expect(() => getProjectView(vault, 'n')).toThrow();
      } finally {
        vault.close();
      }
    });
  });
}
