import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { applyDownSync, fetchPending, planDownSync, pushSharedScopes, resolveConflict } from '../src/connector-client.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

const deviceSecret = generateDeviceSecret();
let home = '';
let fake: FakeConnector;
let vault: Vault;
const priorHome = process.env.NORTHKEEP_HOME;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-down-'));
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
const cloudText = (status: string) => `## What & Why\nDemo.\n\n## Current Status\n${status}\n`;

async function sharedProject(slug: string, status: string): Promise<string> {
  const r = vault.updateProject({ project: slug, expected_revision: null, what_why: 'Demo.', status }).revision;
  vault.setScopeShared(`project:${slug}`, true);
  vault.save();
  await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });
  return r;
}
const pendingIds = () => fake.rows().filter((r) => r.pending).map((r) => r.entry_id);

describe('ADR 0063 incident replay (D1)', () => {
  it('holds a cloud update written against R1 when the Mac is at R2, then take theirs applies it over R2', async () => {
    const r1 = await sharedProject('a', 'R1 local.');
    const cloudId = fake.cloudUpdate('project:a', cloudText('Cloud edit on R1.'));
    const r2 = vault.updateProject({ project: 'a', expected_revision: r1, status: 'R2 local, newer.' }).revision;

    const result = await applyDownSync(conn());
    expect(getProjectView(vault, 'a').revision).toBe(r2);
    expect(getProjectView(vault, 'a').status).toBe('R2 local, newer.');
    expect(result.conflicts.map(({ content: _c, ...c }) => c)).toEqual([
      { scope: 'project:a', project: 'a', server_id: cloudId, base_revision: r1, local_revision: r2, reason: 'moved' },
    ]);
    expect(result.replaced).toBe(0);
    expect(pendingIds()).toEqual([cloudId]);

    const taken = await resolveConflict({ ...conn(), project: 'a', choice: 'take-theirs', expected_revision: r2 });
    const view = getProjectView(vault, 'a', undefined, { history: true });
    expect(view.status).toBe('Cloud edit on R1.');
    expect(view.revision).toBe(taken.revision);
    expect(view.history.map((h) => h.id)).toContain(r2);
    expect(pendingIds()).toEqual([]);
  });

  it('keep mine saves the cloud text as one episodic memory, keeps R2, and deletes the pending row; a retry after a crash writes no second memory', async () => {
    const r1 = await sharedProject('a', 'R1 local.');
    fake.cloudUpdate('project:a', cloudText('Cloud edit on R1.'));
    const r2 = vault.updateProject({ project: 'a', expected_revision: r1, status: 'R2 local, newer.' }).revision;

    fake.failNext('/client/discard', 500);
    await expect(resolveConflict({ ...conn(), project: 'a', choice: 'keep-mine', now: new Date('2026-09-30T12:00:00Z') })).rejects.toThrow('HTTP 500');
    const retry = await resolveConflict({ ...conn(), project: 'a', choice: 'keep-mine', now: new Date('2026-09-30T12:00:00Z') });

    expect(getProjectView(vault, 'a').revision).toBe(r2);
    const kept = vault.list({ scope: 'project:a', type: 'episodic' });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.content).toBe(`# Cloud version not kept, 2026-09-30\n\n${cloudText('Cloud edit on R1.')}`);
    expect(retry.memory_ids).toEqual([kept[0]!.id]);
    expect(pendingIds()).toEqual([]);
  });

  it('take theirs refuses when the head moved after the user looked', async () => {
    const r1 = await sharedProject('a', 'R1 local.');
    fake.cloudUpdate('project:a', cloudText('Cloud.'));
    const r2 = vault.updateProject({ project: 'a', expected_revision: r1, status: 'R2.' }).revision;
    vault.updateProject({ project: 'a', expected_revision: r2, status: 'R3.' });
    await expect(resolveConflict({ ...conn(), project: 'a', choice: 'take-theirs', expected_revision: r2 })).rejects.toThrow('Project changed after it was read.');
    expect(getProjectView(vault, 'a').status).toBe('R3.');
  });
});

describe('ADR 0063 fast-forward and D3 approval', () => {
  it('previews a fast-forward as a replacement, applies nothing unapproved, then applies and acks when approved', async () => {
    await sharedProject('a', 'R1 local.');
    const cloudId = fake.cloudUpdate('project:a', cloudText('Cloud forward.'));
    const before = fs.readFileSync(path.join(home, 'vault.nkv'));

    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    expect(plan.replacements.map((r) => [r.server_id, r.project])).toEqual([[cloudId, 'a']]);
    expect(fs.readFileSync(path.join(home, 'vault.nkv')).equals(before)).toBe(true);

    const unapproved = await applyDownSync(conn());
    expect(unapproved.replaced).toBe(0);
    expect(unapproved.needs_review.replacements.map((r) => r.server_id)).toEqual([cloudId]);
    expect(getProjectView(vault, 'a').status).toBe('R1 local.');

    const approved = await applyDownSync({ ...conn(), approve: { server_ids: [cloudId] } });
    expect(approved.replaced).toBe(1);
    const head = getProjectView(vault, 'a');
    expect(head.status).toBe('Cloud forward.');
    expect(fake.rows().find((r) => r.entry_id === head.revision)?.pending).toBe(false);
    expect(pendingIds()).toEqual([]);
  });

  it('a replacement that arrives between the preview and the apply stays pending', async () => {
    await sharedProject('a', 'R1 local.');
    const plan = planDownSync({ vault, pending: await fetchPending(conn()) });
    const late = fake.cloudUpdate('project:a', cloudText('Arrived late.'));
    const result = await applyDownSync({ ...conn(), approve: { server_ids: plan.replacements.map((r) => r.server_id) } });
    expect(result.replaced).toBe(0);
    expect(pendingIds()).toEqual([late]);
  });

  it('forgets need approval; approved ones are applied and acked', async () => {
    vault.setScopeShared('work', true);
    const mem = vault.remember({ content: 'Shared note to forget', type: 'semantic', scope: 'work' });
    vault.save();
    await pushSharedScopes({ ...conn(), scopes: ['work'] });
    fake.cloudForget(mem.id);

    const first = await applyDownSync(conn());
    expect(first.forgotten).toBe(0);
    expect(first.needs_review.forgets).toEqual([{ entry_id: mem.id, scope: 'work', first_line: 'Shared note to forget' }]);
    expect(vault.list({ scope: 'work' })).toHaveLength(1);

    const second = await applyDownSync({ ...conn(), approve: { forget_ids: [mem.id] } });
    expect(second.forgotten).toBe(1);
    expect(vault.list({ scope: 'work' })).toHaveLength(0);
    expect((await fetchPending(conn())).forgets).toEqual([]);
  });

  it('asks for rows with ?v=2', async () => {
    await applyDownSync(conn());
    expect(fake.requests()).toContain('GET /client/pending?v=2');
  });
});

describe('ADR 0063 legacy and stale rows (first review A2 replay)', () => {
  it('holds a legacy row as a conflict with the device at P and with no local document', async () => {
    const p0 = await sharedProject('a', 'P0.');
    const p = vault.updateProject({ project: 'a', expected_revision: p0, status: 'P.' }).revision;
    vault.save();
    const legacy = fake.seedLegacy('project:a', cloudText('Legacy cloud text.'));
    const atP = await applyDownSync(conn());
    expect(atP.conflicts.map((c) => [c.server_id, c.reason, c.local_revision])).toEqual([[legacy, 'legacy', p]]);
    expect(getProjectView(vault, 'a').status).toBe('P.');

    vault.setScopeShared('project:empty', true);
    vault.save();
    const orphan = fake.seedLegacy('project:empty', cloudText('No local doc.'));
    const none = await applyDownSync(conn());
    expect(none.conflicts.find((c) => c.server_id === orphan)?.reason).toBe('legacy');
    expect(vault.list({ scope: 'project:empty' })).toHaveLength(0);
  });

  it('holds a legacy row in an unshared empty project scope under the ADR 0050 hold, never folding it', async () => {
    fake.seedLegacy('project:cloudonly', cloudText('From an app, pre-ADR.'));
    const result = await applyDownSync(conn());
    expect(result.held_scopes).toEqual(['project:cloudonly']);
    expect(vault.sharedScopes()).toEqual([]);
    expect(vault.list({ scope: 'project:cloudonly' })).toHaveLength(0);
  });

  it('folds a base-new document into an unshared empty scope and marks it Shared', async () => {
    const created = fake.cloudCreate('project:fresh', cloudText('Made in the app.'));
    const result = await applyDownSync(conn());
    expect(result.added).toBe(1);
    expect(vault.sharedScopes()).toEqual(['project:fresh']);
    expect(getProjectView(vault, 'fresh').status).toBe('Made in the app.');
    expect(pendingIds()).not.toContain(created);
  });

  it('discards (never acks) a stale row whose text equals the local head, leaving the pushed head alone', async () => {
    const r1 = await sharedProject('a', 'Same text.');
    const text = getProjectView(vault, 'a').content;
    const stale = fake.seedLegacy('project:a', text);
    const result = await applyDownSync(conn());
    expect(result.discarded).toBe(1);
    expect(result.deduped).toBe(0);
    expect(pendingIds()).not.toContain(stale);
    expect(fake.head('project:a')?.entry_id).toBe(r1);
  });

  it('acks a current row whose text equals the local head as a dedupe, without a vault write', async () => {
    const r1 = await sharedProject('a', 'Start.');
    const r2 = vault.updateProject({ project: 'a', expected_revision: r1, status: 'Both wrote this.' }).revision;
    vault.save();
    fake.cloudUpdate('project:a', getProjectView(vault, 'a').content);
    const before = fs.readFileSync(path.join(home, 'vault.nkv'));
    const result = await applyDownSync(conn());
    expect(result.deduped).toBe(1);
    expect(fs.readFileSync(path.join(home, 'vault.nkv')).equals(before)).toBe(true);
    expect(fake.rows().find((r) => r.entry_id === r2)?.pending).toBe(false);
  });
});

describe('ADR 0063 phone: additions only', () => {
  it('applies a new memory and a new project, defers the fast-forward, and neither applies nor acks a forget', async () => {
    await sharedProject('a', 'R1.');
    vault.setScopeShared('work', true);
    const mem = vault.remember({ content: 'Pushed memory', type: 'semantic', scope: 'work' });
    vault.save();
    await pushSharedScopes({ ...conn(), scopes: vault.sharedScopes() });
    fake.cloudRemember('work', 'From the app');
    fake.cloudCreate('project:phonenew', cloudText('New from the app.'));
    const forward = fake.cloudUpdate('project:a', cloudText('Forward.'));
    fake.cloudForget(mem.id);

    const result = await applyDownSync({ ...conn(), additiveOnly: true, approve: { server_ids: [forward], forget_ids: [mem.id] } });
    expect(result.added).toBe(2);
    expect(result.replaced).toBe(0);
    expect(result.forgotten).toBe(0);
    expect(result.deferred).toBe(2);
    expect(getProjectView(vault, 'a').status).toBe('R1.');
    expect(vault.list({ scope: 'work' }).map((e) => e.content).sort()).toEqual(['From the app', 'Pushed memory']);
    expect(pendingIds()).toEqual([forward]);
    expect((await fetchPending(conn())).forgets).toEqual([mem.id]);
  });
});
