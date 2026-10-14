import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { applyDownSync, pushSharedScopes, resolveConflict } from '../src/connector-client.js';
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
const M2_OPEN = '- [ ] M2 Markets | test: comps';
const M2_YOU = '- [x] M2 Markets | test: comps | passed 2026-10-09 (you)';
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);

describe('down-sync and milestones (ADR 0065 K1)', () => {
  it('holds a cloud create carrying a (you) pass: not applied, not marked Shared, still pending', async () => {
    const created = fake.cloudCreate('project:forged', doc('From the cloud.', PASSED));
    const result = await applyDownSync(conn());
    expect(result.added).toBe(0);
    expect(result.conflicts.map((c) => [c.project, c.server_id, c.reason])).toEqual([['forged', created, 'milestones_changed']]);
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
    expect(held.conflicts.map((c) => [c.server_id, c.reason])).toEqual([[dropping, 'milestones_changed']]);
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

describe('K1 review finding B: rows the K1 rule refuses are resolvable, never stuck', () => {
  it('a held create with a (you) line: keep mine resolves it and leaves the scope private', async () => {
    const createId = fake.cloudCreate('project:fresh', doc('Cloud made it.', `${PASSED}\n${M2_OPEN}`));
    const first = await applyDownSync(conn());
    expect(first.conflicts.map((c) => [c.server_id, c.reason])).toEqual([[createId, 'milestones_changed']]);
    const kept = await resolveConflict({ ...conn(), project: 'fresh', choice: 'keep-mine' });
    expect(kept.server_ids).toEqual([createId]);
    expect(pendingIds()).not.toContain(createId);
    expect(vault.sharedScopes()).not.toContain('project:fresh');
    expect((await applyDownSync(conn())).conflicts).toEqual([]);
  });

  it('an approved fast-forward that adds a (you) pass is held once, named, and take theirs ends it', async () => {
    const r1 = vault.replaceProjectContent({ project: 'a', expected_revision: null, content: doc('Underwriting.', `${PASSED}\n${M2_OPEN}`), source: 'test-owner' }, { actor: 'owner' }).revision;
    vault.setScopeShared('project:a', true);
    vault.save();
    await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });
    const forged = doc('Cloud says M2 passed.', `${PASSED}\n${M2_YOU}`);
    const cloudId = fake.cloudUpdate('project:a', forged);
    const held = await applyDownSync({ ...conn(), approve: { server_ids: [cloudId] } });
    expect(held.replaced).toBe(0);
    expect(held.conflicts.map((c) => ({ id: c.server_id, reason: c.reason, changes: (c as { pass_changes?: Array<{ text: string }> }).pass_changes?.map((p) => p.text) }))).toEqual([{
      id: cloudId,
      reason: 'milestones_changed',
      changes: ['M2 Markets would be marked passed, confirmed by you on 2026-10-09.'],
    }]);
    expect(getProjectView(vault, 'a').revision).toBe(r1);

    await resolveConflict({ ...conn(), project: 'a', choice: 'take-theirs', expected_revision: r1 });
    expect(getProjectView(vault, 'a').content).toBe(forged);
    expect(pendingIds()).toEqual([]);
    expect((await applyDownSync(conn())).conflicts).toEqual([]);
  });
});
