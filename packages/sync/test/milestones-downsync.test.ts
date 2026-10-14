import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { applyDownSync, pushSharedScopes } from '../src/connector-client.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

/** ADR 0065 K1: a cloud row is an AI app's write, so the agent write rule runs before it applies. */

const deviceSecret = generateDeviceSecret();
let home = '';
let fake: FakeConnector;
let vault: Vault;
const priorHome = process.env.NORTHKEEP_HOME;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0065-down-'));
  process.env.NORTHKEEP_HOME = home;
  fake = await startFakeConnector();
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: 'synthetic passphrase', deviceSecret, kdf: KDF_INTERACTIVE });
});
afterEach(async () => {
  vault.close();
  await fake.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const conn = () => ({ server: fake.url(), deviceSecret, vault });
const PASSED = '- [x] M1 Buy box | test: agreed | passed 2026-10-01 (you)';
const doc = (status: string, milestones: string) => `## What & Why\nDemo.\n\n## Current Status\n${status}\n\n## Milestones\n\n${milestones}\n`;
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);

describe('down-sync and milestones (ADR 0065 K1)', () => {
  it('holds a cloud create carrying a (you) pass: not applied, not marked Shared, still pending', async () => {
    const created = fake.cloudCreate('project:forged', doc('From the cloud.', PASSED));
    const result = await applyDownSync(conn());
    expect(result.added).toBe(0);
    expect(result.conflicts.map((c) => [c.project, c.server_id, c.reason])).toEqual([['forged', created, 'moved']]);
    expect(vault.sharedScopes()).toEqual([]);
    expect(vault.list({ scope: 'project:forged' })).toEqual([]);
    expect(pendingIds()).toContain(created);
  });

  it('holds an approved fast-forward that drops a pass, and applies one that keeps it', async () => {
    const r1 = vault.replaceProjectContent({ project: 'a', expected_revision: null, content: doc('R1.', `${PASSED}\n- [ ] M2 Markets | test: comps`), source: 'test-owner' }, { actor: 'owner' }).revision;
    vault.setScopeShared('project:a', true);
    vault.save();
    await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });

    const dropping = fake.cloudUpdate('project:a', doc('Cloud dropped M1.', '- [ ] M2 Markets | test: comps'));
    const held = await applyDownSync({ ...conn(), approve: { server_ids: [dropping] } });
    expect(held.replaced).toBe(0);
    expect(held.conflicts.map((c) => [c.server_id, c.reason])).toEqual([[dropping, 'moved']]);
    expect(getProjectView(vault, 'a').revision).toBe(r1);
  });

  it('applies an approved fast-forward that keeps every pass', async () => {
    vault.replaceProjectContent({ project: 'a', expected_revision: null, content: doc('R1.', `${PASSED}\n- [ ] M2 Markets | test: comps`), source: 'test-owner' }, { actor: 'owner' });
    vault.setScopeShared('project:a', true);
    vault.save();
    await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });
    const keeping = fake.cloudUpdate('project:a', doc('Cloud kept M1.', `${PASSED}\n- [ ] M2 Markets | test: comps`));
    const applied = await applyDownSync({ ...conn(), approve: { server_ids: [keeping] } });
    expect(applied.replaced).toBe(1);
    expect(getProjectView(vault, 'a').status).toBe('Cloud kept M1.');
  });
});
