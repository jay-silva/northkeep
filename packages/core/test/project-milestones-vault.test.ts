import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { getProjectView, listProjectOverview, listProjectViews } from '../src/project-handoff.js';
import { confirmPassInDocument } from '../src/project-milestones-owner.js';
import { Vault } from '../src/vault.js';
import { plantWorkingRow } from './support/plant-working-row.js';

let directory: string;
let vaultPath: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0065-vault-'));
  vaultPath = path.join(directory, 'vault.nkv');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const open = (): Vault => Vault.create({ path: vaultPath, passphrase: 'synthetic adr 0065 passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
const AGENT = { actor: 'agent' } as const;
const OWNER = { actor: 'owner' } as const;
const PASSED = '- [x] M1 Buy box | test: agreed | passed 2026-10-01 (you)';
const OPEN2 = '- [ ] M2 Markets | test: three with comps';

function seed(v: Vault): string {
  const created = v.updateProject({ project: 'rental', expected_revision: null, what_why: 'Why.', status: 'Starting.', next_actions: '- [ ] Begin', milestones: { kind: 'plan', items: [{ title: 'Buy box', test: 'agreed' }, { title: 'Markets', test: 'three with comps' }] } }, AGENT);
  const content = created.content.replace('- [ ] M1 Buy box | test: agreed', PASSED);
  return v.replaceProjectContent({ project: 'rental', expected_revision: created.revision, content, source: 'test-owner' }, OWNER).revision;
}

describe('the actor option (ADR 0065 Decision 2)', () => {
  it('is required on every project write, with no default', () => {
    const v = open();
    const message = "A vault write must say whether it is for an AI app ('agent') or the user ('owner').";
    const note = v.remember({ content: 'A fact.', type: 'semantic', scope: 'personal' });
    const loose = v as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(() => loose.editMemory!.call(v, note.id, { content: 'Changed.' })).toThrow(message);
    expect(() => loose.forget!.call(v, note.id)).toThrow(message);
    expect(() => loose.updateProject!.call(v, { project: 'rental', expected_revision: null, status: 'S.' })).toThrow(message);
    expect(() => loose.replaceProjectContent!.call(v, { project: 'rental', expected_revision: null, content: '## Current Status\n\nS.', source: 'x' }, { actor: 'someone' })).toThrow(message);
    expect(() => loose.checkpointProject!.call(v, { project: 'rental' }, {})).toThrow(message);
    expect(v.list()).toHaveLength(1);
    v.close();
  });
});

describe('vault.remember (ADR 0065 Decision 3, review wound W2)', () => {
  it('refuses a new working row in a project scope, so converse cannot create or break a project', () => {
    const v = open();
    expect(() => v.remember({ content: '## Current Status\n\nInvented.', type: 'working', scope: 'project:rental' })).toThrow('A working memory in a project collection is the project document.');
    expect(v.remember({ content: 'A detail.', type: 'episodic', scope: 'project:rental' }).scope).toBe('project:rental');
    expect(listProjectViews(v)).toEqual([]);
    v.close();
  });
});

describe('the agent write rule inside the vault', () => {
  it('replaceProjectContent: an agent create carrying a pass is refused and nothing is written', () => {
    const v = open();
    const doc = `## Current Status\n\nCloud.\n\n## Milestones\n\n${PASSED}`;
    expect(() => v.replaceProjectContent({ project: 'held', expected_revision: null, content: doc, source: 'connector:test' }, AGENT)).toThrowError(expect.objectContaining({ code: 'invalid_request', message: 'An AI app cannot mark M1 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.' }));
    expect(v.list({ scope: 'project:held' })).toEqual([]);
    expect(v.replaceProjectContent({ project: 'held', expected_revision: null, content: doc, source: 'take-theirs' }, OWNER).milestones.kind).toBe('plan');
    v.close();
  });

  it('replaceProjectContent: an agent replacement that drops a pass is refused; the owner may (restore can undo a pass)', () => {
    const v = open();
    const head = seed(v);
    const dropped = getProjectView(v, 'rental').content.replace(`${PASSED}\n`, '');
    expect(() => v.replaceProjectContent({ project: 'rental', expected_revision: head, content: dropped, source: 'connector:test' }, AGENT)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(getProjectView(v, 'rental').revision).toBe(head);
    const restoreTo = getProjectView(v, 'rental', undefined, { history: true }).history[0]!.id;
    const restored = v.restoreProjectRevision({ project: 'rental', revision: restoreTo, expected_revision: head });
    expect(restored.milestones).toMatchObject({ kind: 'plan', items: [{ id: 'M1', state: 'open' }, { id: 'M2', state: 'open' }] });
    v.close();
  });

  it('editMemory: the owner may edit passes; an agent may not; both are refused a duplicate owned section', () => {
    const v = open();
    const head = seed(v);
    const content = getProjectView(v, 'rental').content;
    expect(() => v.editMemory(head, { content: content.replace(PASSED, PASSED.replace('2026-10-01', '2026-10-02')) }, AGENT)).toThrow('M1 has passed, so its line cannot be changed, moved out of Milestones or removed.');
    const duplicate = `${content}\n\n## Milestones\n\n${OPEN2}`;
    expect(() => v.editMemory(head, { content: duplicate }, OWNER)).toThrow('Project document has duplicate Milestones sections. Nothing was saved.');
    expect(() => v.editMemory(head, { content: `${content}\n\n### Files\n\nx\n\n## Files\n\ny` }, OWNER)).toThrow('Project document has duplicate Files sections. Nothing was saved.');
    const owner = v.editMemory(head, { content: content.replace(OPEN2, OPEN2.replace('- [ ]', '- [x]') + ' | passed 2026-10-03 (you)') }, OWNER);
    expect(getProjectView(v, 'rental').revision).toBe(owner.id);
    v.close();
  });

  it('forget: an agent cannot forget the live document; the owner can, and an agent can forget other rows', () => {
    const v = open();
    const head = seed(v);
    const detail = v.remember({ content: 'Lender notes.', type: 'semantic', scope: 'project:rental' });
    expect(() => v.forget(head, AGENT)).toThrow('This memory is a project document. An AI app cannot forget it; the user can delete the project in the NorthKeep app or with northkeep projects delete.');
    expect(v.forget(detail.id, AGENT).forgotten_at).not.toBeNull();
    const prior = v.list({ scope: 'project:rental', type: 'working', includeSuperseded: true }).find((e) => e.superseded_at !== null)!;
    expect(v.forget(prior.id, AGENT).forgotten_at).not.toBeNull();
    expect(v.forget(head, OWNER).forgotten_at).not.toBeNull();
    v.close();
  });

  it('checkpoint: the pass date is the UTC date of the saved row, and the replay rebuilds it', () => {
    const v = open();
    seed(v);
    const view = getProjectView(v, 'rental');
    const request = { vault_id: v.getVaultId(), project: 'rental', mode: 'checkpoint' as const, operation_id: '00650000-0000-4000-8000-000000000001', expected_revision: view.revision, status: 'Markets done.', completed: 'Shortlisted.', next_actions: '', milestone_passed: 'M2' };
    const first = v.checkpointProject(request, AGENT);
    const day = first.receipt.saved_at.slice(0, 10);
    expect(first.current.content).toContain(`- [x] M2 Markets | test: three with comps | passed ${day} (agent)`);
    expect(v.checkpointProject(request, AGENT).replayed).toBe(true);
    expect(() => v.checkpointProject({ ...request, milestone_passed: 'M3' }, AGENT)).toThrowError(expect.objectContaining({ code: 'operation_conflict' }));
    v.close();
  });
});

describe('owned sections and the title (ADR 0065 Decision 2 defects)', () => {
  it('refuses a title named like any owned section, Files and Milestones included', () => {
    const v = open();
    for (const title of ['Files', 'Milestones', 'Open Questions', 'Log']) {
      expect(() => v.updateProject({ project: 'rental', expected_revision: null, title, status: 'S.' }, OWNER)).toThrowError(expect.objectContaining({ code: 'invalid_request', message: 'Project title cannot be the name of a document section.' }));
    }
    v.close();
  });

  it('never reads or writes the level-1 title as a section', () => {
    const v = open();
    const created = v.replaceProjectContent({ project: 'titled', expected_revision: null, content: '# Files\n\n## Current Status\n\nS.\n\n## Files', source: 'hand' }, OWNER);
    expect(created.title).toBe('Files');
    expect(created.files_text).toBe('');
    const updated = v.updateProject({ project: 'titled', expected_revision: created.revision, files: [{ type: 'url', label: 'Spec', locator: 'https://example.com', access: 'unverified' }] }, OWNER);
    expect(updated.content.startsWith('# Files\n\n## Current Status')).toBe(true);
    expect(updated.files).toEqual([{ type: 'url', label: 'Spec', locator: 'https://example.com', access: 'unverified' }]);
    v.close();
  });

  it('W4: only a level-2 Milestones heading is the section, for the handoff code as for the module', () => {
    const v = open();
    const content = `## Current Status\n\nS.\n\n## Milestones\n\n${OPEN2}\n\n## Log\n\n### Milestones\n\nNotes about planning.`;
    const created = v.replaceProjectContent({ project: 'levels', expected_revision: null, content, source: 'hand' }, OWNER);
    expect(created.milestones).toMatchObject({ kind: 'plan', items: [{ id: 'M2' }] });
    const updated = v.updateProject({ project: 'levels', expected_revision: created.revision, milestones: { kind: 'plan', items: [{ title: 'Offers', test: 'two sent' }] } }, AGENT);
    expect(updated.content).toBe('## Current Status\n\nS.\n\n## Milestones\n\n- [ ] M1 Offers | test: two sent\n\n## Log\n\n### Milestones\n\nNotes about planning.');
    const lower = v.replaceProjectContent({ project: 'lower', expected_revision: null, content: '## Current Status\n\nS.\n\n## Log\n\n### Milestones\n\nNotes.', source: 'hand' }, OWNER);
    expect(lower.milestones).toEqual({ kind: 'absent' });
    const planned = v.updateProject({ project: 'lower', expected_revision: lower.revision, milestones: { kind: 'none', reason: 'an errand' } }, AGENT);
    expect(planned.content).toBe('## Current Status\n\nS.\n\n## Milestones\n\nnone: an errand\n\n## Log\n\n### Milestones\n\nNotes.');
    v.close();
  });

  it('a document already holding a duplicate Milestones section is unreadable, and lists as needing repair', () => {
    const v = open();
    plantWorkingRow(v, { content: `## Current Status\n\nS.\n\n## Milestones\n\n${OPEN2}\n\n## Milestones\n\n${OPEN2}`, scope: 'project:twice' });
    expect(() => getProjectView(v, 'twice')).toThrow('Project document has duplicate Milestones sections.');
    v.close();
  });

  it('ProjectOverview carries a progress summary; ProjectSummary does not', () => {
    const v = open();
    seed(v);
    expect(listProjectOverview(v)[0]!.milestones).toEqual({ passed: 1, total: 2, current: { id: 'M2', title: 'Markets' } });
    expect(listProjectViews(v)[0]).not.toHaveProperty('milestones');
    v.close();
  });

  it('the owner confirm helper writes a (you) pass the vault accepts from the owner and refuses from an agent', () => {
    const v = open();
    const head = seed(v);
    const { content } = confirmPassInDocument(getProjectView(v, 'rental').content, 'M2', '2026-10-14T08:00:00.000Z');
    expect(() => v.replaceProjectContent({ project: 'rental', expected_revision: head, content, source: 'x' }, AGENT)).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    const confirmed = v.replaceProjectContent({ project: 'rental', expected_revision: head, content, source: 'northkeep:milestone-confirm' }, OWNER);
    expect(confirmed.milestones).toMatchObject({ kind: 'plan', items: [{ id: 'M1', by: 'you' }, { id: 'M2', by: 'you', on: '2026-10-14' }] });
    v.close();
  });
});
