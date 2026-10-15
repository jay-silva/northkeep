import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, MILESTONE_INSTRUCTION, NO_MILESTONES_NOTE } from '../src/mcp.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { decryptedEntries, seedEncryptedEntry, testAccountDek } from './helpers.js';

/**
 * ADR 0065 K4: the hosted connector records open milestones only, keeps every
 * passed line byte for byte, refuses project-document forgets, and sends the
 * same standing instruction and no-plan note as the local server.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const account = 'acct-adr0065';
const connToken = 'conn-token-adr0065';

/** Canonical form, as serializeProjectDoc writes it. */
const PASSED_DOC = [
  '## What & Why',
  '',
  'Find a rental market.',
  '',
  '## Current Status',
  '',
  'Underwriting.',
  '',
  '## Milestones',
  '',
  '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)',
  '- [ ] M2 Shortlist 3 markets | test: 3 markets with comps',
  '',
  '## Next Actions',
  '',
  '## Decisions',
  '',
  '## Log',
].join('\n');

let storage: InMemoryConnectorStorage;

async function client(): Promise<Client> {
  const dek = await testAccountDek(storage, account, connToken);
  const server = createMcpServer(storage, account, dek);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'adr0065-test', version: '0.0.0' });
  await c.connect(b);
  return c;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = (await (await client()).callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: res.content[0]?.text ?? '', isError: res.isError === true };
}

async function seedHead(scope: string, content: string, entryId = 'vault-head-1'): Promise<void> {
  await seedEncryptedEntry(storage, account, connToken, { entryId, scope, type: 'working', content, origin: 'vault', pending: false, writeSeq: 1 });
}

async function plainRows(scope: string) {
  return (await decryptedEntries(storage, account, connToken)).filter((e) => e.scope === scope);
}

/** The document the last hosted write stored: the one pending working row. */
function newestDoc(rows: Awaited<ReturnType<typeof plainRows>>): string {
  const pending = rows.filter((e) => e.type === 'working' && e.pending === true);
  expect(pending).toHaveLength(1);
  return pending[0]!.content;
}

beforeEach(() => {
  storage = new InMemoryConnectorStorage();
});

describe('ADR 0065 copied module', () => {
  it('keeps the connector copy of project-milestones.ts byte-identical to core', () => {
    const copy = path.join(here, '..', 'src', 'project-milestones.ts');
    const core = path.join(here, '..', '..', '..', 'packages', 'core', 'src', 'project-milestones.ts');
    expect(fs.readFileSync(copy, 'utf8')).toBe(fs.readFileSync(core, 'utf8'));
  });

  it('never imports the owner entry point', () => {
    const src = path.join(here, '..', 'src');
    const offenders = fs.readdirSync(src).filter((f) => /from\s+['"][^'"]*project-milestones-owner/.test(fs.readFileSync(path.join(src, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('calls recordAgentPass from no hosted path, so no hosted write records a pass (ADR 0068 review 7)', () => {
    const src = path.join(here, '..', 'src');
    const callers = fs.readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && path.basename(f) !== 'project-milestones.ts')
      .filter((f) => /\brecordAgentPass\b/.test(fs.readFileSync(path.join(src, f), 'utf8')));
    expect(callers).toEqual([]);
  });
});

describe('ADR 0065 hosted tools', () => {
  it('sends the standing milestone instruction', async () => {
    const c = await client();
    expect(c.getInstructions()).toBe(
      'When the user asks to create a project, propose its milestones and create it only after the user agrees to them. Report a milestone passed only when the user says its acceptance test passed. Never mark a milestone passed on your own judgment.',
    );
    expect(MILESTONE_INSTRUCTION).toBe(c.getInstructions());
  });

  it('project_create refuses without milestones and stores nothing', async () => {
    await seedEncryptedEntry(storage, account, connToken, { entryId: 'note', scope: 'project:plan', type: 'episodic', content: 'n', pending: false });
    const res = await call('project_create', { project: 'plan', what_why: 'Why.', status: 'Starting.' });
    expect(res).toEqual({
      isError: true,
      text: 'Nothing was saved: milestones is required. Propose the milestones to the user and create the project after they agree; if there is no plan yet, send "M1 Agree the milestones | test: the user approves the plan".',
    });
    expect((await plainRows('project:plan')).map((e) => e.entryId)).toEqual(['note']);
  });

  it('project_create records the agreed plan right after Current Status', async () => {
    const res = await call('project_create', {
      project: 'plan',
      what_why: 'Why.',
      status: 'Starting.',
      milestones: 'M1 Agree the milestones | test: the user approves the plan\nShip it | test: it runs',
    });
    expect(res.isError).toBe(false);
    expect(newestDoc(await plainRows('project:plan'))).toBe(
      '## What & Why\n\nWhy.\n\n## Current Status\n\nStarting.\n\n## Milestones\n\n- [ ] M1 Agree the milestones | test: the user approves the plan\n- [ ] M2 Ship it | test: it runs\n\n## Next Actions\n\n## Decisions\n\n## Log',
    );
  });

  it('project_create refuses a passed line or a stamp and stores nothing', async () => {
    for (const milestones of [
      '- [x] M1 Done | test: ok | passed 2026-10-01 (you)',
      'M1 Done | test: ok (you)',
      'M1 Done | test: ok | passed 2026-10-01 (agent)',
    ]) {
      const res = await call('project_create', { project: 'forge', what_why: 'Why.', status: 'Now.', milestones });
      expect(res).toEqual({
        isError: true,
        text: 'Nothing was saved: Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.',
      });
    }
    expect(await plainRows('project:forge')).toEqual([]);
  });

  it('project_update replaces the open plan and keeps the passed line byte for byte', async () => {
    await seedHead('project:rent', PASSED_DOC);
    const res = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', milestones: 'M2 Shortlist 4 markets | test: 4 markets with comps\nUnderwrite | test: 5 pro formas' });
    expect(res.isError).toBe(false);
    const doc = newestDoc(await plainRows('project:rent'));
    expect(doc.split('## Milestones\n\n')[1]!.split('\n\n')[0]).toBe(
      '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)\n- [ ] M2 Shortlist 4 markets | test: 4 markets with comps\n- [ ] M3 Underwrite | test: 5 pro formas',
    );
  });

  it('project_update without milestones keeps the plan as it is', async () => {
    await seedHead('project:rent', PASSED_DOC);
    expect((await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', status: 'Shortlisting.' })).isError).toBe(false);
    const doc = newestDoc(await plainRows('project:rent'));
    expect(doc).toBe(PASSED_DOC.replace('Underwriting.', 'Shortlisting.'));
  });

  it('project_update refuses to change a passed milestone and stores nothing new', async () => {
    await seedHead('project:rent', PASSED_DOC);
    const res = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', milestones: 'M1 Define the buy box again | test: redo' });
    expect(res).toEqual({
      isError: true,
      text: 'Nothing was saved: M1 has already passed. Passed milestones cannot be changed; send only the milestones still to do.',
    });
    const none = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', milestones: 'none: no plan' });
    expect(none.text).toBe('Nothing was saved: This project has passed milestones, so its plan cannot be replaced with none:.');
    expect((await plainRows('project:rent')).map((e) => e.entryId)).toEqual(['vault-head-1']);
  });

  it('project_update refuses to replace a malformed plan, and keeps it as it is otherwise', async () => {
    const broken = PASSED_DOC.replace('(you)', '(You)');
    await seedHead('project:rent', broken);
    const res = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', milestones: 'M2 Next | test: t' });
    expect(res.text).toBe(
      'Nothing was saved: The Milestones section does not follow the milestone format, so it cannot be changed here. Ask the user to repair it in the NorthKeep app.',
    );
    expect((await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', status: 'Still here.' })).isError).toBe(false);
    expect(newestDoc(await plainRows('project:rent'))).toBe(broken.replace('Underwriting.', 'Still here.'));
  });

  it('project_get adds the no-plan note only while the plan is absent and the project is not done', async () => {
    const plain = '## What & Why\n\nWhy.\n\n## Current Status\n\nWorking.\n\n## Next Actions\n\n## Decisions\n\n## Log';
    await seedHead('project:a', plain, 'ha');
    await seedHead('project:b', plain.replace('Working.', 'Done. Shipped.'), 'hb');
    await seedHead('project:c', plain.replace('## Next Actions', '## Milestones\n\nnone: a one-off errand\n\n## Next Actions'), 'hc');
    await seedHead('project:d', PASSED_DOC, 'hd');
    expect(NO_MILESTONES_NOTE).toBe('This project has no milestones. Ask the user whether they want to set them; do not invent them.');
    expect((await call('project_get', { project: 'a' })).text).toBe(
      `${plain}\n\nThis project has no milestones. Ask the user whether they want to set them; do not invent them.\n\nRevision: ha (pass it as expected_revision to project_update)`,
    );
    for (const project of ['b', 'c', 'd']) {
      expect((await call('project_get', { project })).text).not.toContain('This project has no milestones.');
    }
  });

  it('refuses lookalike stamps and stamped lines outside the section, as K1 does (review W1, W2, W3, finding A)', async () => {
    await seedHead('project:rent', PASSED_DOC);
    for (const milestones of ['M3 Underwrite | test: ok (уou)', 'M3 Underwrite ［x］ | test: ok']) {
      const res = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', milestones });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('checkbox or a pass stamp');
    }
    for (const status of ['- [x] M9 Ship | test: ok | passed 2026-10-01 (you)', 'Shipped | passed 2026-10-01 (you)']) {
      const res = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', status });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/^Nothing was saved: /);
    }
    expect((await plainRows('project:rent')).map((e) => e.entryId)).toEqual(['vault-head-1']);
  });

  it('refuses a setext Milestones heading outside the section, as K1 does (K4 review F1)', async () => {
    await seedHead('project:rent', PASSED_DOC);
    const example = 'Beds done.\n\nMilestones\n----------\n- [x] M2 Order seeds | test: seed order confirmed | passed 14 Oct 2026 (confirmed by you)';
    const res = await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', status: example });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Nothing was saved: /);
    for (const status of ['Beds done.\n\nMilestones\n----------\nnotes', 'Beds done.\n\nMilestones\n==\nnotes']) {
      expect(await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', status })).toEqual({
        isError: true,
        text: 'Nothing was saved: A heading named like Milestones can only be "## Milestones". Use that exact heading for the plan.',
      });
    }
    expect((await plainRows('project:rent')).map((e) => e.entryId)).toEqual(['vault-head-1']);
  });

  it('refuses a checkbox line with a milestone id outside the section, as K1 does (K4 review F1)', async () => {
    await seedHead('project:rent', PASSED_DOC);
    for (const [field, text] of [
      ['status', 'Beds done.\n\n- [x] M2 Order seeds'],
      ['status', 'Beds done.\n\n- [x] M2'],
      ['what_why', '✅ M2 Order seeds passed, confirmed by you'],
    ] as const) {
      expect(await call('project_update', { project: 'rent', expected_revision: 'vault-head-1', [field]: text })).toEqual({
        isError: true,
        text: 'Nothing was saved: Only the Milestones section can hold a milestone line with a checkbox. An AI app cannot add one anywhere else.',
      });
    }
    expect((await plainRows('project:rent')).map((e) => e.entryId)).toEqual(['vault-head-1']);
  });

  it('writes the plan only into a level-2 Milestones section, as core does (review W4)', async () => {
    const lookalike = PASSED_DOC.replace('## Milestones\n\n- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)\n- [ ] M2 Shortlist 3 markets | test: 3 markets with comps\n\n', '')
      .replace('## Next Actions', '### Milestones\n\nold notes\n\n## Next Actions');
    expect(lookalike).not.toContain('## Milestones\n\n- [');
    await seedHead('project:look', lookalike);
    const res = await call('project_update', { project: 'look', expected_revision: 'vault-head-1', milestones: 'M1 Start | test: ok' });
    expect(res.isError).toBe(false);
    const doc = newestDoc(await plainRows('project:look'));
    expect(doc).toContain('## Current Status\n\nUnderwriting.\n\n## Milestones\n\n- [ ] M1 Start | test: ok');
    expect(doc).toContain('### Milestones\n\nold notes');
  });

  it('memory_forget refuses a project document and forgets other rows in a project scope', async () => {
    await seedHead('project:rent', PASSED_DOC);
    await seedEncryptedEntry(storage, account, connToken, { entryId: 'note-1', scope: 'project:rent', type: 'episodic', content: 'a note', pending: false });
    const refused = await call('memory_forget', { id: 'vault-head-1' });
    expect(refused).toEqual({
      isError: true,
      text: 'Nothing was forgotten: this is the project document of "project:rent". An AI app cannot forget a project. The user can remove it in the NorthKeep app.',
    });
    const pendingCreate = await call('project_create', { project: 'fresh', what_why: 'W.', status: 'S.', milestones: 'M1 A | test: b' });
    const createdId = /\(id: (conn_[0-9a-f]+)\)/.exec(pendingCreate.text)![1]!;
    expect((await call('memory_forget', { id: createdId })).isError).toBe(true);
    expect((await call('memory_forget', { id: 'note-1' })).text).toBe(
      'Forgotten. It is hidden now and will be removed from the vault on the next sync. It will not come back.',
    );
    expect(await storage.listPendingForgets(account)).toEqual(['note-1']);
  });
});
