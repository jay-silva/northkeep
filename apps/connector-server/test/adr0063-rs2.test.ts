import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { emptyProjectDoc, mergeProjectDoc, serializeProjectDoc } from '@northkeep/core/project-doc';
import { applyDownSync, fetchPending, planDownSync, pushSharedScopes, resolveConflict, startPairing } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { connectMcpApp, pgliteAsNeon, startServer, TEST_PEPPER_B64, withEnv } from './adr0061-support.js';

/**
 * Recheck R-S2 through forgetting the document (build review A7), on both
 * stores. A cloud create held as stale must not come back unasked after the
 * user forgets the shared project's document and pushes, on the Mac or the
 * phone. A cloud project in a scope that never existed here still arrives.
 */

const doc = (status: string) => serializeProjectDoc(mergeProjectDoc(emptyProjectDoc(), { whatWhy: 'R-S2.', status, logEntry: 'seed' }));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-rs2-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0063 R-S2 through a forgotten document (${kind})`, () => {
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

    it('holds a stale cloud create as deleted_here after the document is forgotten and pushed; take theirs brings it back on request', async () => {
      const deviceSecret = generateDeviceSecret();
      const vault = Vault.create({ path: path.join(tmpRoot, `a7-${kind}.nkv`), passphrase: 'rs2 pass', deviceSecret, kdf: KDF_INTERACTIVE });
      try {
        vault.remember({ content: 'work seed', type: 'semantic', scope: 'work' });
        vault.setScopeShared('work', true);
        const mine = vault.remember({ content: doc('MAC OWN n.'), type: 'working', scope: 'project:n' });
        vault.save();
        await pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
        const mcp = await connectMcpApp(base, await startPairing({ server: base, deviceSecret }));
        expect((await mcp('project_create', { project: 'n', what_why: 'CLOUD CREATED n.', status: 'cloud' })).isError).toBe(false);

        vault.setScopeShared('project:n', true);
        vault.save();
        await pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
        expect(planDownSync({ vault, pending: await fetchPending({ server: base, deviceSecret }) }).conflicts.map((c) => c.reason)).toEqual(['stale']);

        vault.forget(mine.id);
        vault.save();
        await pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
        const pending = await fetchPending({ server: base, deviceSecret });
        const plan = planDownSync({ vault, pending });
        expect(plan.conflicts.map((c) => [c.project, c.reason])).toEqual([['n', 'deleted_here']]);
        expect(plan.additions).toEqual([]);
        expect(planDownSync({ vault, pending, additiveOnly: true }).additions).toEqual([]);

        expect((await applyDownSync({ server: base, deviceSecret, vault })).added).toBe(0);
        expect(() => getProjectView(vault, 'n')).toThrow();

        await resolveConflict({ server: base, deviceSecret, vault, project: 'n', choice: 'take-theirs' });
        expect(getProjectView(vault, 'n').content).toContain('CLOUD CREATED n.');
      } finally {
        vault.close();
      }
    });

    it('a cloud project in a scope that never existed here still arrives as an addition', async () => {
      const deviceSecret = generateDeviceSecret();
      const vault = Vault.create({ path: path.join(tmpRoot, `fresh-${kind}.nkv`), passphrase: 'rs2 pass', deviceSecret, kdf: KDF_INTERACTIVE });
      try {
        vault.remember({ content: 'work seed', type: 'semantic', scope: 'work' });
        vault.setScopeShared('work', true);
        vault.setScopeShared('project:fresh', true);
        vault.save();
        await pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
        const mcp = await connectMcpApp(base, await startPairing({ server: base, deviceSecret }));
        expect((await mcp('project_create', { project: 'fresh', what_why: 'CLOUD FRESH.', status: 'cloud' })).isError).toBe(false);
        const plan = planDownSync({ vault, pending: await fetchPending({ server: base, deviceSecret }) });
        expect(plan.conflicts).toEqual([]);
        expect(plan.additions.map((a) => [a.scope, a.kind])).toEqual([['project:fresh', 'project']]);
      } finally {
        vault.close();
      }
    });
  });
}
