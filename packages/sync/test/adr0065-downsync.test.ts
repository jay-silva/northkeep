import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { applyDownSync, fetchPending, planDownSync, pushSharedScopes, resolveConflict } from '../src/connector-client.js';
import { milestonePassChanges } from '../src/milestone-changes.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

/**
 * ADR 0065 Decision 3, down-sync. The fake connector enforces nothing, as a
 * pre-K4 or faulty connector would not: the Mac's own rule is what holds.
 * Ported into K1 from K4 (42af8d3), because K1's write rule otherwise strands held rows.
 */

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
const M1_YOU = '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)';
const M2_OPEN = '- [ ] M2 Shortlist 3 markets | test: 3 markets with comps';
const M2_AGENT = '- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-09 (agent)';
const doc = (status: string, milestones: string[]) =>
  `## What & Why\n\nDemo.\n\n## Current Status\n\n${status}\n\n## Milestones\n\n${milestones.join('\n')}\n\n## Log`;

async function sharedProject(slug: string, content: string): Promise<string> {
  const r = vault.replaceProjectContent({ project: slug, expected_revision: null, content, source: 'test' }, { actor: 'owner' }).revision;
  vault.setScopeShared(`project:${slug}`, true);
  vault.save();
  await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });
  return r;
}
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);
const plan = async () => planDownSync({ vault, pending: await fetchPending(conn()) });

describe('ADR 0065 down-sync: the agent write rule against the local head', () => {
  it('applies a fast-forward that keeps every pass', async () => {
    const r1 = await sharedProject('a', doc('Underwriting.', [M1_YOU, M2_OPEN]));
    const cloudId = fake.cloudUpdate('project:a', doc('Shortlisting.', [M1_YOU, M2_OPEN]));
    const p = await plan();
    expect(p.conflicts).toEqual([]);
    expect(p.replacements.map((r) => ({ id: r.server_id, local: r.local_revision }))).toEqual([{ id: cloudId, local: r1 }]);
  });

  it('holds a fast-forward that removes a confirmed pass as milestones_changed, and take theirs applies it', async () => {
    const r1 = await sharedProject('a', doc('Underwriting.', [M1_YOU, M2_OPEN]));
    const cloud = doc('Reset.', ['- [ ] M1 Define the buy box | test: buy box written and agreed', M2_OPEN]);
    const cloudId = fake.cloudUpdate('project:a', cloud);

    const result = await applyDownSync({ ...conn(), approve: { server_ids: [cloudId] } });
    expect(result.replaced).toBe(0);
    expect(getProjectView(vault, 'a').revision).toBe(r1);
    expect(result.conflicts.map(({ content: _c, ...c }) => c)).toEqual([{
      scope: 'project:a',
      project: 'a',
      server_id: cloudId,
      base_revision: r1,
      local_revision: r1,
      reason: 'milestones_changed',
      pass_changes: [{ id: 'M1', change: 'removed', text: 'M1 Define the buy box would no longer be passed. It was confirmed by you on 2026-09-28.' }],
      shares_scope: false,
    }]);
    expect(pendingIds()).toEqual([cloudId]);

    const taken = await resolveConflict({ ...conn(), project: 'a', choice: 'take-theirs', expected_revision: r1 });
    expect(getProjectView(vault, 'a').revision).toBe(taken.revision);
    expect(getProjectView(vault, 'a').content).toBe(cloud);
  });

  it('holds a cloud pass, even an (agent) one, because the connector never adds a pass', async () => {
    const r1 = await sharedProject('a', doc('Underwriting.', [M1_YOU, M2_OPEN]));
    fake.cloudUpdate('project:a', doc('Shortlisted.', [M1_YOU, M2_AGENT]));
    const p = await plan();
    expect(p.replacements).toEqual([]);
    expect(p.conflicts.map((c) => ({ reason: c.reason, local: c.local_revision, changes: c.pass_changes }))).toEqual([{
      reason: 'milestones_changed',
      local: r1,
      changes: [{ id: 'M2', change: 'added', text: 'M2 Shortlist 3 markets would be marked passed, reported passed by an AI app on 2026-10-09.' }],
    }]);
  });

  it('milestones_changed wins over moved, and every other reason still lists pass changes', async () => {
    const r1 = await sharedProject('a', doc('One.', [M1_YOU, M2_OPEN]));
    fake.cloudUpdate('project:a', doc('Cloud.', [M2_OPEN]));
    vault.replaceProjectContent({ project: 'a', expected_revision: r1, content: doc('Two.', [M1_YOU, M2_OPEN]), source: 'test' }, { actor: 'owner' });
    expect((await plan()).conflicts.map((c) => c.reason)).toEqual(['milestones_changed']);

    const legacy = fake.seedLegacy('project:a', doc('Legacy.', [M1_YOU, M2_OPEN]));
    const held = (await plan()).conflicts.find((c) => c.server_id === legacy)!;
    expect(held.reason).toBe('legacy');
    expect(held.pass_changes).toEqual([]);
  });

  it('names a cloud Milestones section it cannot read', () => {
    expect(milestonePassChanges(doc('S.', [M1_YOU]), doc('S.', ['- [x] M1 Define the buy box | test: x | passed 2026-09-28 (You)']))).toEqual([{
      id: null,
      change: 'unreadable',
      text: "The cloud version's Milestones section does not follow the milestone format, so NorthKeep cannot tell which milestones it marks passed. Check it line by line before you take it.",
    }]);
    expect(milestonePassChanges(doc('S.', [M1_YOU]), doc('S.', [M1_YOU.replace('agreed', 'signed')]))).toEqual([{
      id: 'M1',
      change: 'changed',
      text: `Passed milestone M1 would change from "${M1_YOU}" to "${M1_YOU.replace('agreed', 'signed')}".`,
    }]);
  });
});

describe('ADR 0065 down-sync: a cloud create carrying a pass is held, not marked Shared (amends ADR 0050)', () => {
  it('holds the create in a private scope, and take theirs applies it and marks the scope Shared', async () => {
    const forged = doc('Cloud made it.', [M1_YOU, M2_OPEN]);
    const createId = fake.cloudCreate('project:fresh', forged);
    const noteId = fake.cloudRemember('project:fresh', 'a note');

    const p = await plan();
    expect(p.to_mark).toEqual([]);
    expect(p.held_scopes).toEqual(['project:fresh']);
    expect(p.conflicts.map(({ content: _c, ...c }) => c)).toEqual([{
      scope: 'project:fresh',
      project: 'fresh',
      server_id: createId,
      base_revision: 'new',
      local_revision: null,
      reason: 'milestones_changed',
      pass_changes: [{ id: 'M1', change: 'added', text: 'M1 Define the buy box would be marked passed, confirmed by you on 2026-09-28.' }],
      shares_scope: true,
    }]);

    const result = await applyDownSync(conn());
    expect(result.added).toBe(0);
    expect(vault.sharedScopes()).not.toContain('project:fresh');
    expect(vault.list({ scope: 'project:fresh' })).toEqual([]);
    expect(pendingIds().sort()).toEqual([createId, noteId].sort());

    await resolveConflict({ ...conn(), project: 'fresh', choice: 'take-theirs', expected_revision: null });
    expect(vault.sharedScopes()).toContain('project:fresh');
    expect(getProjectView(vault, 'fresh').content).toBe(forged);
  });

  it('still folds a create with open milestones only', async () => {
    fake.cloudCreate('project:fresh', doc('Cloud made it.', [M2_OPEN]));
    const p = await plan();
    expect(p.conflicts).toEqual([]);
    expect(p.to_mark).toEqual(['project:fresh']);
  });
});

describe('K4 review F1: a forget names the passes it would remove', () => {
  it('lists the passed milestones of a project document a connected app forgot, and none for an ordinary memory', async () => {
    const r1 = await sharedProject('a', doc('Underwriting.', [M1_YOU, M2_AGENT, '- [ ] M3 Underwrite | test: pro formas']));
    const note = vault.remember({ content: 'A note in the project', type: 'semantic', scope: 'project:a' });
    vault.save();
    await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });
    fake.cloudForget(r1);
    fake.cloudForget(note.id);
    const p = await plan();
    expect(p.forgets).toEqual([
      { entry_id: r1, scope: 'project:a', first_line: '## What & Why', passed: ['M1 Define the buy box', 'M2 Shortlist 3 markets'] },
      { entry_id: note.id, scope: 'project:a', first_line: 'A note in the project' },
    ]);
  });
});
