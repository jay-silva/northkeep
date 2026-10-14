import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret } from '@northkeep/core';
import { createServer } from '../src/server.js';

const PASSPHRASE = 'adr 0065 milestones tools passphrase';
const PLAN = 'M1 Define the buy box | test: buy box written and agreed\nM2 Shortlist 3 markets | test: 3 markets with comps';
let home: string;
let vaultPath: string;
const saved: Record<string, string | undefined> = {};
const clients: Client[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0065-'));
  vaultPath = path.join(home, 'vault.nkv');
  for (const key of ['NORTHKEEP_HOME', 'NORTHKEEP_MASTER_KEY', 'NORTHKEEP_SCOPES', 'NORTHKEEP_NO_KEYCHAIN', 'NORTHKEEP_REDACT_TIER', 'NORTHKEEP_OLLAMA_URL']) saved[key] = process.env[key];
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  delete process.env.NORTHKEEP_SCOPES;
  delete process.env.NORTHKEEP_REDACT_TIER;
  const secret = generateDeviceSecret();
  Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(vaultPath);
  process.env.NORTHKEEP_MASTER_KEY = deriveMasterKey(PASSPHRASE, secret, header.salt, header.kdf).toString('hex');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const server = createServer(vaultPath);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'milestones-test', version: '1.0' });
  await Promise.all([mcp.connect(a), server.connect(b)]);
  clients.push(mcp);
  return mcp;
}

type Result = { isError: boolean; text: string; json: any };
async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* plain text refusal */ }
  return { isError: result.isError === true, text, json };
}

function openVault(): Vault {
  return Vault.openWithKey(vaultPath, Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex'));
}

/** The document after an owner pass, written the way the desktop or CLI would. */
function ownerPassesM1(): { id: string; content: string } {
  const v = openVault();
  try {
    const head = v.list({ scope: 'project:rental', type: 'working' })[0]!;
    const content = head.content.replace('- [ ] M1 Define the buy box | test: buy box written and agreed', '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-10-01 (you)');
    const view = v.replaceProjectContent({ project: 'rental', expected_revision: head.id, content, source: 'test-owner' }, { actor: 'owner' });
    v.save();
    return { id: view.revision, content: view.content };
  } finally { v.close(); }
}

async function create(mcp: Client): Promise<{ revision: string; vault_id: string; content: string }> {
  const created = await call(mcp, 'project_create', { project: 'rental', what_why: 'A first rental.', status: 'Starting.', next_actions: '- [x] Merge the PR\n- [ ] Call the lender', milestones: PLAN });
  expect(created.isError, created.text).toBe(false);
  return created.json;
}

const PASSED_M1 = '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-10-01 (you)';

describe('server instructions (ADR 0065 Decision 4)', () => {
  it('sends the pinned instruction text in the handshake', async () => {
    const mcp = await connect();
    expect(mcp.getInstructions()).toBe('When the user asks to create a project, propose its milestones and create it only after the user agrees to them. Report a milestone passed only when the user says its acceptance test passed. Never mark a milestone passed on your own judgment.');
  });
});

describe('project_create and project_update', () => {
  it('requires milestones unless draft, refuses them with draft, and writes the plan after Current Status', async () => {
    const mcp = await connect();
    const missing = await call(mcp, 'project_create', { project: 'rental', what_why: 'W.', status: 'S.' });
    expect(missing.isError).toBe(true);
    expect(missing.json.error).toEqual({ code: 'invalid_request', message: 'milestones is required. Propose the milestones to the user and create the project after they agree; if there is no plan yet, send "M1 Agree the milestones | test: the user approves the plan".' });
    const draftWith = await call(mcp, 'project_create', { project: 'rental', what_why: 'W.', status: 'S.', draft: true, milestones: PLAN });
    expect(draftWith.json.error.message).toBe('A draft project takes no milestones. Create it without milestones, then agree the plan with the user and add it with project_update.');
    const draft = await call(mcp, 'project_create', { project: 'drafty', what_why: 'W.', status: 'S.', draft: true });
    expect(draft.isError, draft.text).toBe(false);
    expect(draft.json.milestones).toEqual({ kind: 'absent' });

    const created = await create(mcp);
    expect(created.content).toContain('## Current Status\n\nStarting.\n\n## Milestones\n\n- [ ] M1 Define the buy box | test: buy box written and agreed\n- [ ] M2 Shortlist 3 markets | test: 3 markets with comps\n\n## Next Actions');
    const got = await call(mcp, 'project_get', { project: 'rental' });
    expect(got.json.milestones.items.map((m: { id: string; state: string }) => `${m.id} ${m.state}`)).toEqual(['M1 open', 'M2 open']);
  });

  it('refuses a passed line or stamp sent as milestones, on create and on update', async () => {
    const mcp = await connect();
    const forged = await call(mcp, 'project_create', { project: 'rental', what_why: 'W.', status: 'S.', milestones: PASSED_M1 });
    expect(forged.json.error.code).toBe('invalid_request');
    expect(forged.json.error.message).toBe('Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.');
    const created = await create(mcp);
    const update = await call(mcp, 'project_update', { project: 'rental', expected_revision: created.revision, milestones: `${PASSED_M1}\nM2 Shortlist 3 markets | test: 3 markets with comps` });
    expect(update.json.error.message).toBe('Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.');
  });

  it('project_update replaces the open part and keeps a pass byte for byte', async () => {
    const mcp = await connect();
    await create(mcp);
    const passed = ownerPassesM1();
    const renamed = await call(mcp, 'project_update', { project: 'rental', expected_revision: passed.id, milestones: 'M1 Redo the buy box | test: x' });
    expect(renamed.json.error.message).toBe('M1 has already passed. Passed milestones cannot be changed; send only the milestones still to do.');
    const updated = await call(mcp, 'project_update', { project: 'rental', expected_revision: passed.id, milestones: 'Shortlist 4 markets | test: 4 markets with comps\nMake offers | test: two offers sent' });
    expect(updated.isError, updated.text).toBe(false);
    expect(updated.json.content).toContain(`## Milestones\n\n${PASSED_M1}\n- [ ] M2 Shortlist 4 markets | test: 4 markets with comps\n- [ ] M3 Make offers | test: two offers sent\n\n`);
  });
});

describe('project_checkpoint and project_wrap: milestone_passed', () => {
  it('stamps the current milestone (agent) with the save date, replays exactly, and refuses any other id', async () => {
    const mcp = await connect();
    const created = await create(mcp);
    const base = { project: 'rental', vault_id: created.vault_id, status: 'Buy box agreed.', completed: 'Wrote the buy box.', next_actions: '- [x] Merge the PR\n- [ ] Shortlist' };
    const wrong = await call(mcp, 'project_checkpoint', { ...base, expected_revision: created.revision, operation_id: randomUUID(), milestone_passed: 'M2' });
    expect(wrong.json.error.message).toBe('Only the current milestone, M1, can be reported passed. Report a milestone passed only when the user says its acceptance test passed.');
    const op = randomUUID();
    const first = await call(mcp, 'project_checkpoint', { ...base, expected_revision: created.revision, operation_id: op, milestone_passed: 'M1' });
    expect(first.isError, first.text).toBe(false);
    const day = first.json.receipt.saved_at.slice(0, 10);
    expect(first.json.current.milestones.items[0]).toEqual({ id: 'M1', title: 'Define the buy box', test: 'buy box written and agreed', state: 'passed', on: day, by: 'agent' });
    const replay = await call(mcp, 'project_checkpoint', { ...base, expected_revision: created.revision, operation_id: op, milestone_passed: 'M1' });
    expect(replay.json.replayed).toBe(true);
    const changed = await call(mcp, 'project_checkpoint', { ...base, expected_revision: created.revision, operation_id: op });
    expect(changed.json.error.code).toBe('operation_conflict');
    const wrap = await call(mcp, 'project_wrap', { ...base, expected_revision: first.json.receipt.result_revision, operation_id: randomUUID(), milestone_passed: 'M1' });
    expect(wrap.json.error.message).toBe('Only the current milestone, M2, can be reported passed. Report a milestone passed only when the user says its acceptance test passed.');
  });

  it('a checkpoint with checked tasks in Next Actions and no milestone still saves', async () => {
    const mcp = await connect();
    const created = await create(mcp);
    const saved = await call(mcp, 'project_checkpoint', { project: 'rental', vault_id: created.vault_id, expected_revision: created.revision, operation_id: randomUUID(), status: 'Going.', completed: 'Merged.', next_actions: '- [x] Merge the PR\n- [x] Call the lender' });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.json.current.next_actions).toBe('- [x] Merge the PR\n- [x] Call the lender');
  });
});

describe('memory_edit and memory_forget on a project document', () => {
  const doc = async (mcp: Client) => (await call(mcp, 'project_get', { project: 'rental' })).json as { id: string; content: string };

  it.each([
    ['adds a passed line', (c: string) => c.replace('- [ ] M2 Shortlist 3 markets | test: 3 markets with comps', '- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-02 (you)'), 'An AI app cannot mark M2 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.'],
    ['removes a passed line', (c: string) => c.replace(`${PASSED_M1}\n`, ''), 'M1 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['moves a passed line into Log', (c: string) => c.replace(`${PASSED_M1}\n`, '').replace('## Log', `## Log\n\n${PASSED_M1}`), 'M1 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['renames the heading', (c: string) => c.replace('## Milestones', '## Milestones done'), 'This project has passed milestones, so its Milestones section must stay, with every passed line unchanged.'],
    ['breaks the section (step one of the two-step route)', (c: string) => c.replace(PASSED_M1, `${PASSED_M1} `), 'This change would leave the Milestones section unreadable, so nothing was saved: Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
  ])('refuses an edit that %s', async (_label, change, message) => {
    const mcp = await connect();
    await create(mcp);
    ownerPassesM1();
    const before = await doc(mcp);
    const edit = await call(mcp, 'memory_edit', { id: before.id, content: change(before.content) });
    expect(edit.isError).toBe(true);
    expect(edit.text).toBe(message);
    expect((await doc(mcp)).id).toBe(before.id);
  });

  it('ticks an open line only through milestone_passed, never through memory_edit', async () => {
    const mcp = await connect();
    await create(mcp);
    const before = await doc(mcp);
    const ticked = before.content.replace('- [ ] M1 Define the buy box | test: buy box written and agreed', '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-10-02 (agent)');
    const edit = await call(mcp, 'memory_edit', { id: before.id, content: ticked });
    expect(edit.text).toBe('An AI app cannot mark M1 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.');
  });

  it('K1 review A: refuses a pass line without a Latin id through memory_edit, project_update and a draft create', async () => {
    const stamps = [
      '- [x] Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- [x] \u041c2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- [x] \u039c2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- [x] M02 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
    ];
    const message = 'Only the Milestones section can hold a passed milestone line. An AI app cannot add one anywhere else.';
    const mcp = await connect();
    const created = await create(mcp);
    for (const [i, stamp] of stamps.entries()) {
      const before = await doc(mcp);
      const edit = await call(mcp, 'memory_edit', { id: before.id, content: before.content.replace('- [ ] Call the lender', `- [ ] Call the lender\n${stamp}`) });
      expect(edit.text, stamp).toBe(message);
      const update = await call(mcp, 'project_update', { project: 'rental', expected_revision: created.revision, status: stamp });
      expect(update.json?.error?.message ?? update.text, stamp).toBe(message);
      const draft = await call(mcp, 'project_create', { project: `drafty-${i}`, what_why: stamp, status: 'S.', draft: true });
      expect(draft.json?.error?.message ?? draft.text, stamp).toBe(message);
    }
  });

  it('K4 review F1: refuses a setext Milestones heading in status and a checkbox milestone line in what_why', async () => {
    const mcp = await connect();
    const created = await create(mcp);
    const status = 'Beds done.\n\nMilestones\n----------\n- [x] M2 Order seeds | test: seed order confirmed | passed 14 Oct 2026 (confirmed by you)';
    const update = await call(mcp, 'project_update', { project: 'rental', expected_revision: created.revision, status });
    expect(update.json?.error?.message ?? update.text).toBe('A heading named like Milestones can only be "## Milestones". Use that exact heading for the plan.');
    const what = await call(mcp, 'project_update', { project: 'rental', expected_revision: created.revision, what_why: '✅ M2 Order seeds passed, confirmed by you' });
    expect(what.json?.error?.message ?? what.text).toBe('Only the Milestones section can hold a milestone line with a checkbox. An AI app cannot add one anywhere else.');
  });

  it('accepts an edit that keeps every pass, and refuses a type change of the document', async () => {
    const mcp = await connect();
    await create(mcp);
    ownerPassesM1();
    const before = await doc(mcp);
    const fine = await call(mcp, 'memory_edit', { id: before.id, content: before.content.replace('Starting.', 'Shortlisting.') });
    expect(fine.isError, fine.text).toBe(false);
    const retype = await call(mcp, 'memory_edit', { id: fine.json.edited.id, type: 'semantic' });
    expect(retype.text).toBe('This memory is a project document, so an AI app cannot change its type or move it. Change the project with project_update.');
  });

  it('refuses the malformed two-step route: a section the owner left broken stays byte-identical', async () => {
    const mcp = await connect();
    await create(mcp);
    const v = openVault();
    const head = v.list({ scope: 'project:rental', type: 'working' })[0]!;
    const broken = head.content.replace('- [ ] M1 Define the buy box | test: buy box written and agreed', '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-10-01 (You)');
    v.editMemory(head.id, { content: broken }, { actor: 'owner' });
    v.save();
    v.close();
    const before = await doc(mcp);
    const repaired = await call(mcp, 'memory_edit', { id: before.id, content: before.content.replace('(You)', '(you)') });
    expect(repaired.text).toBe('The Milestones section does not follow the milestone format, so it cannot be changed here. Ask the user to repair it in the NorthKeep app. Leave that section exactly as it is.');
    const elsewhere = await call(mcp, 'memory_edit', { id: before.id, content: before.content.replace('Starting.', 'Still starting.') });
    expect(elsewhere.isError, elsewhere.text).toBe(false);
  });

  it('refuses memory_forget of the live document, and still forgets other memories in the project scope', async () => {
    const mcp = await connect();
    await create(mcp);
    const before = await doc(mcp);
    const forget = await call(mcp, 'memory_forget', { id: before.id });
    expect(forget.isError).toBe(true);
    expect(forget.text).toBe('This memory is a project document. An AI app cannot forget it; the user can delete the project in the NorthKeep app or with northkeep projects delete.');
    const note = await call(mcp, 'memory_remember', { content: 'The lender prefers email.', type: 'semantic', scope: 'project:rental' });
    const gone = await call(mcp, 'memory_forget', { id: note.json.stored.id });
    expect(gone.isError, gone.text).toBe(false);
    expect((await doc(mcp)).id).toBe(before.id);
  });
});

describe('project_resume: the no-plan note', () => {
  const NOTE = 'This project has no milestones. Ask the user whether they want to set them; do not invent them.';

  it('shows once per project per session, and a new session shows it again', async () => {
    const mcp = await connect();
    await call(mcp, 'project_create', { project: 'bare', what_why: 'W.', status: 'S.', draft: true });
    await call(mcp, 'project_create', { project: 'other', what_why: 'W.', status: 'S.', draft: true });
    expect((await call(mcp, 'project_resume', { project: 'bare' })).json.milestones_note).toBe(NOTE);
    expect((await call(mcp, 'project_resume', { project: 'bare' })).json.milestones_note).toBeUndefined();
    expect((await call(mcp, 'project_resume', { project: 'other' })).json.milestones_note).toBe(NOTE);
    const next = await connect();
    expect((await call(next, 'project_resume', { project: 'bare' })).json.milestones_note).toBe(NOTE);
  });

  it('is silenced by none: and by a Done status, and absent when there is a plan', async () => {
    const mcp = await connect();
    await call(mcp, 'project_create', { project: 'errand', what_why: 'W.', status: 'S.', milestones: 'none: a one-off errand' });
    await call(mcp, 'project_create', { project: 'finished', what_why: 'W.', status: 'Done. Shipped.', draft: true });
    await create(mcp);
    for (const project of ['errand', 'finished', 'rental']) {
      const resumed = await call(mcp, 'project_resume', { project });
      expect(resumed.isError, resumed.text).toBe(false);
      expect(resumed.json.milestones_note).toBeUndefined();
    }
    expect((await call(mcp, 'project_resume', { project: 'errand' })).json.milestones).toEqual({ kind: 'none', reason: 'a one-off errand' });
  });
});

describe('source rules', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|js|mjs)$/.test(e.name))
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'));

  it('every vault write in server.ts says it is for an agent', () => {
    const source = fs.readFileSync(path.join(here, '../src/server.ts'), 'utf8');
    const calls = [...source.matchAll(/vault\.(editMemory|forget|updateProject|checkpointProject|replaceProjectContent)\(([^;]*?)\);/gs)];
    expect(calls.map((m) => m[1]).sort()).toEqual(['checkpointProject', 'editMemory', 'forget', 'updateProject', 'updateProject']);
    for (const m of calls) expect(m[2]).toContain("{ actor: 'agent' }");
    expect(source).not.toContain("actor: 'owner'");
  });

  it('neither the MCP server nor the connector imports the owner milestone entry point', () => {
    const roots = [path.join(here, '../src'), path.join(here, '../../../apps/connector-server/src')];
    for (const root of roots) {
      for (const text of read(root)) expect(text).not.toMatch(/project-milestones-owner|confirmPass/);
    }
  });
});
