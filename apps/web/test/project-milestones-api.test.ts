import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../src/projectsApi.js';
import { passesUndoneByRestore, previewMilestoneRepair } from '../src/project-milestones-view.js';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView, readProjectProvenance } from '@northkeep/core';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PLAN = [
  '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)',
  '- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-09 (agent)',
  '- [ ] M3 Underwrite top 5 listings | test: each has a pro forma',
  '- [ ] M4 Financing pre-approval | test: letter in hand',
].join('\n');
const today = () => new Date().toISOString().slice(0, 10);

let root: string; let vault: Vault;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-milestones-')));
  vault = Vault.create({ path: path.join(root, 'v.nkv'), passphrase: 'synthetic milestones', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
});
afterEach(() => { vault.close(); fs.rmSync(root, { recursive: true, force: true }); });

function seed(milestones: string): string {
  const first = vault.updateProject({ project: 'str', expected_revision: null, status: 'Pro formas done for 2 of 5.' });
  return vault.replaceProjectContent({ project: 'str', expected_revision: first.revision, content: `${first.content}\n\n## Milestones\n\n${milestones}`, source: 'test' }).revision;
}
const session = (unlocked = true) => ({ isUnlocked: () => unlocked, sessionId: SESSION_ID, withVault: async (fn: (v: Vault) => unknown) => fn(vault) }) as never;
const post = (route: string, payload: unknown) => handleProjectsApi(session(), 'POST', route, Buffer.from(JSON.stringify(payload)));
const head = () => getProjectView(vault, 'str');
const milestoneBody = (content: string) => content.slice(content.indexOf('## Milestones\n\n') + '## Milestones\n\n'.length);

describe('project page milestone fields (ADR 0065 K2)', () => {
  it('returns the parsed plan and, per saved version, the passes a restore would undo', async () => {
    const before = seed(PLAN.replace(' | passed 2026-10-09 (agent)', '').replace('- [x] M2', '- [ ] M2'));
    const after = vault.replaceProjectContent({ project: 'str', expected_revision: before, content: head().content.replace(milestoneBody(head().content), PLAN), source: 'test' });
    const response = await handleProjectsApi(session(), 'GET', '/api/projects/str', Buffer.alloc(0));
    expect(response?.status).toBe(200);
    const body = response?.body as Record<string, unknown> & { milestones: { kind: string; items: unknown[] }; restore_undoes: Record<string, unknown> };
    expect(body.revision).toBe(after.revision);
    expect(body.milestones.kind).toBe('plan');
    expect(body.milestones.items[1]).toEqual({ id: 'M2', title: 'Shortlist 3 markets', test: '3 markets with comps', state: 'passed', on: '2026-10-09', by: 'agent' });
    expect(body.restore_undoes[before]).toEqual([{ id: 'M2', title: 'Shortlist 3 markets', on: '2026-10-09', by: 'agent' }]);
    expect(body).not.toHaveProperty('milestone_repair_text');
  });

  it('names a confirmation as undone when the older version has the agent stamp, and every pass when it is unreadable', () => {
    const doc = (body: string) => `# T\n\n## Milestones\n\n${body}`;
    const mine = doc(PLAN.replace('2026-10-09 (agent)', '2026-10-12 (you)'));
    expect(passesUndoneByRestore(mine, doc(PLAN))).toEqual([{ id: 'M2', title: 'Shortlist 3 markets', on: '2026-10-12', by: 'you' }]);
    expect(passesUndoneByRestore(mine, doc('- [x] broken'))).toHaveLength(2);
    expect(passesUndoneByRestore(doc(PLAN), '# T\n\n## Current Status\n\nNo plan then.')).toHaveLength(2);
    expect(passesUndoneByRestore(doc(PLAN), doc(PLAN))).toEqual([]);
  });
});

describe('Mark passed and Confirm (ADR 0065 Decision 3)', () => {
  it('stamps the current milestone (you) with today, bound to the read, written by this app', async () => {
    const revision = seed(PLAN);
    const response = await post('/api/projects/str/milestones/confirm', { id: 'M3', expected_revision: revision });
    expect(response?.status).toBe(200);
    expect((response?.body as { passed: unknown }).passed).toEqual({ id: 'M3', title: 'Underwrite top 5 listings', on: today(), by: 'you' });
    const now = head();
    expect(milestoneBody(now.content).split('\n')[2]).toBe(`- [x] M3 Underwrite top 5 listings | test: each has a pro forma | passed ${today()} (you)`);
    expect(now.status).toBe('Pro formas done for 2 of 5.');
    const row = vault.list({ scope: 'project:str', type: 'working' })[0]!;
    expect(row.source).toBe('northkeep:milestone-confirm');
    expect(readProjectProvenance(row)).toMatchObject({ host: 'northkeep-app', session_id: SESSION_ID });
  });

  it('turns an (agent) pass into a (you) pass and leaves the other lines byte for byte', async () => {
    const revision = seed(PLAN);
    expect((await post('/api/projects/str/milestones/confirm', { id: 'M2', expected_revision: revision }))?.status).toBe(200);
    expect(milestoneBody(head().content)).toBe(PLAN.replace('passed 2026-10-09 (agent)', `passed ${today()} (you)`));
  });

  it('refuses a stale page with stale_project and the current version, and writes nothing', async () => {
    const old = seed(PLAN);
    const moved = vault.updateProject({ project: 'str', expected_revision: old, status: 'An agent saved.' });
    const response = await post('/api/projects/str/milestones/confirm', { id: 'M3', expected_revision: old });
    expect(response?.status).toBe(409);
    expect(response?.body).toMatchObject({ code: 'stale_project', error: 'Project changed after it was read.', current: { revision: moved.revision } });
    expect(head().revision).toBe(moved.revision);
  });

  it('refuses milestones that are not the current one, or already confirmed', async () => {
    const revision = seed(PLAN);
    const later = await post('/api/projects/str/milestones/confirm', { id: 'M4', expected_revision: revision });
    expect(later?.status).toBe(409);
    expect(later?.body).toEqual({ code: 'milestone_refused', error: 'Only the current milestone, M3, can be confirmed now. Milestones pass in order.' });
    const done = await post('/api/projects/str/milestones/confirm', { id: 'M1', expected_revision: revision });
    expect(done?.body).toEqual({ code: 'milestone_refused', error: 'M1 is already confirmed.' });
    expect(head().revision).toBe(revision);
  });

  it('refuses a locked vault, a GET, unknown fields and missing values without a write', async () => {
    const revision = seed(PLAN);
    expect((await handleProjectsApi(session(false), 'POST', '/api/projects/str/milestones/confirm', Buffer.from('{}')))?.status).toBe(423);
    expect((await handleProjectsApi(session(), 'GET', '/api/projects/str/milestones/confirm', Buffer.alloc(0)))?.status).toBe(405);
    for (const payload of [{ id: 'M3' }, { expected_revision: revision }, { id: 'M3', expected_revision: revision, by: 'you' }, { id: 3, expected_revision: revision }]) {
      expect((await post('/api/projects/str/milestones/confirm', payload))?.status).toBe(400);
    }
    expect((await handleProjectsApi(session(), 'POST', '/api/projects/str/milestones/stamp', Buffer.from('{}')))?.status).toBe(404);
    expect(head().revision).toBe(revision);
  });
});

describe('repair of a malformed Milestones section (ADR 0065 K2)', () => {
  const BROKEN = '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (You)\n- [ ] M2 Shortlist | test: comps';

  it('offers the section text, previews the passes it would record, and saves only once those passes were reviewed', async () => {
    const revision = seed(BROKEN);
    const page = (await handleProjectsApi(session(), 'GET', '/api/projects/str', Buffer.alloc(0)))?.body as Record<string, unknown>;
    expect(page.milestones).toEqual({ kind: 'malformed', reason: 'Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".' });
    expect(page.milestone_repair_text).toBe(BROKEN);
    const fixed = BROKEN.replace('(You)', '(you)');
    const check = await post('/api/projects/str/milestones/repair', { expected_revision: revision, body: fixed });
    expect(check?.status).toBe(200);
    expect(check?.body).toMatchObject({ check: true, passes: [{ id: 'M1', title: 'Define the buy box', on: '2026-09-28', by: 'you' }] });
    expect(head().revision).toBe(revision);
    const unseen = await post('/api/projects/str/milestones/repair', { expected_revision: revision, body: fixed, check: false, accept_passes: [] });
    expect(unseen?.body).toEqual({ code: 'milestone_refused', error: 'Check the milestones again before saving: the lines that count as passed are not the ones you reviewed.' });
    const saved = await post('/api/projects/str/milestones/repair', { expected_revision: revision, body: fixed, check: false, accept_passes: ['M1'] });
    expect(saved?.status).toBe(200);
    expect(milestoneBody(head().content)).toBe(fixed);
    expect(vault.list({ scope: 'project:str', type: 'working' })[0]!.source).toBe('northkeep:milestone-repair');
  });

  it('refuses text that is still malformed, a section that is readable, and a heading inside the text', async () => {
    const revision = seed(BROKEN);
    const still = await post('/api/projects/str/milestones/repair', { expected_revision: revision, body: BROKEN });
    expect(still?.body).toEqual({ code: 'milestone_refused', error: 'Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".' });
    expect(previewMilestoneRepair(head().content, '- [ ] M1 A | test: b\n## Log\n\nforged')).toEqual({ ok: false, reason: 'Line 2 does not follow the format "- [ ] M1 Title | test: how the user checks it".' });
    const good = vault.replaceProjectContent({ project: 'str', expected_revision: revision, content: head().content.replace(BROKEN, PLAN), source: 'test' }).revision;
    const readable = await post('/api/projects/str/milestones/repair', { expected_revision: good, body: 'none: not needed' });
    expect(readable?.body).toEqual({ code: 'milestone_refused', error: 'The Milestones section can be read, so there is nothing to repair. Reload the project.' });
  });

  it('merges a duplicated section into one at the place of the first', () => {
    const doc = '# T\n\n## Milestones\n\n- [ ] M1 A | test: a\n\n## Log\n\nx\n\n## Milestones\n\n- [ ] M2 B | test: b';
    const preview = previewMilestoneRepair(doc, '- [ ] M1 A | test: a\n- [ ] M2 B | test: b');
    expect(preview).toMatchObject({ ok: true, passes: [], content: '# T\n\n## Milestones\n\n- [ ] M1 A | test: a\n- [ ] M2 B | test: b\n\n## Log\n\nx' });
  });
});
