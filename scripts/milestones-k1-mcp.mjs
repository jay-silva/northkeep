// Disposable MCP client for the ADR 0065 K1 acceptance script. It plays the
// part of an AI app. It refuses to run unless NORTHKEEP_HOME is the acceptance
// script's throwaway home, so it never opens the owner's vault.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const THROWAWAY = '/tmp/nk-k1-acceptance/home';
const ACTIONS = ['create', 'report', 'refusals', 'converse'];
const [action, slug] = process.argv.slice(2);
if (!ACTIONS.includes(action) || !slug) throw new Error(`Use: ${ACTIONS.join(' | ')} <slug>`);
const home = process.env.NORTHKEEP_HOME ?? '';
if (!fs.existsSync(home) || fs.realpathSync(home) !== fs.realpathSync(THROWAWAY)) {
  throw new Error(`NORTHKEEP_HOME must be ${THROWAWAY}; this client never opens any other vault.`);
}
const passphrase = process.env.NORTHKEEP_PASSPHRASE;
if (!passphrase) throw new Error('NORTHKEEP_PASSPHRASE is not set.');
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
delete process.env.NORTHKEEP_SCOPES;
delete process.env.NORTHKEEP_REDACT_TIER;

const { Vault, setPlatform, loadDeviceSecret, deriveMasterKey } = await import('../packages/core/dist/index.js');
const { nodePlatform } = await import('../packages/platform-node/dist/index.js');
setPlatform(nodePlatform());
const vaultPath = path.join(home, 'vault.nkv');
const secret = loadDeviceSecret();
const header = Vault.readHeader(vaultPath);
const key = deriveMasterKey(passphrase, secret, header.salt, header.kdf);
secret.fill(0);

if (action === 'converse') {
  // The same vault call a converse turn uses to save what it learned.
  const vault = Vault.openWithKey(vaultPath, key);
  try {
    vault.remember({ content: '## Current Status\n\nInvented by a chat turn.', type: 'working', scope: `project:${slug}`, source: 'converse' });
    console.log('SAVED (this should have been refused)');
  } catch (err) {
    console.log(`refused: ${err.message}`);
  } finally {
    vault.close();
    key.fill(0);
  }
  process.exit(0);
}

process.env.NORTHKEEP_MASTER_KEY = key.toString('hex');
key.fill(0);
const { createServer } = await import('../packages/mcp-server/dist/server.js');
const server = createServer(vaultPath);
const client = new Client({ name: 'acceptance-app', version: '1.0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct), server.connect(st)]);
const raw = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  let message = text;
  try { message = JSON.parse(text).error?.message ?? text; } catch { /* plain text */ }
  return { isError: result.isError === true, text, message };
};
const call = async (name, args) => {
  const r = await raw(name, args);
  if (r.isError) throw new Error(r.message);
  return JSON.parse(r.text);
};
const expectRefused = async (label, name, args) => {
  const r = await raw(name, args);
  console.log(r.isError ? `refused  ${label}: ${r.message}` : `ACCEPTED ${label} (this should have been refused)`);
};

try {
  if (action === 'create') {
    await expectRefused('create without milestones', 'project_create', { project: slug, what_why: 'Buy a first rental.', status: 'Starting.' });
    const created = await call('project_create', {
      project: slug, what_why: 'Buy a first rental.', status: 'Starting.', next_actions: '- [ ] Call the lender',
      milestones: 'M1 Define the buy box | test: buy box written and agreed\nM2 Shortlist 3 markets | test: 3 markets with comps',
    });
    console.log(`Created project ${slug} with ${created.milestones.items.length} milestones.`);
  } else if (action === 'report') {
    const view = await call('project_resume', { project: slug });
    const saved = await call('project_checkpoint', {
      project: slug, vault_id: view.vault_id, expected_revision: view.revision, operation_id: randomUUID(),
      status: 'Buy box agreed.', completed: 'Wrote the buy box.', next_actions: '- [x] Call the lender\n- [ ] Pick markets', milestone_passed: 'M1',
    });
    const m1 = saved.current.milestones.items[0];
    console.log(`Checkpoint saved. Next Actions: ${JSON.stringify(saved.current.next_actions)}. ${m1.id} passed, stamped (${m1.by}).`);
  } else {
    const doc = await call('project_get', { project: slug });
    const before = doc.id;
    const c = doc.content;
    const passed = c.split('\n').find((line) => line.startsWith('- [x] M1'));
    const open = c.split('\n').find((line) => line.startsWith('- [ ] M2'));
    if (!passed || !open) throw new Error('Run the report step first, so M1 has passed and M2 is open.');
    const edit = (label, content) => expectRefused(label, 'memory_edit', { id: before, content });
    await expectRefused('a passed line through project_update', 'project_update', { project: slug, expected_revision: before, milestones: `${passed}\nM2 Shortlist 3 markets | test: 3 markets with comps` });
    await edit('memory_edit adds a passed line', c.replace(open, `${open.replace('- [ ]', '- [x]')} | passed 2026-10-14 (you)`));
    await edit('memory_edit ticks a line', c.replace(open, open.replace('- [ ]', '- [x]')));
    await edit('memory_edit turns (agent) into (you)', c.replace(passed, passed.replace('(agent)', '(you)')));
    await edit('memory_edit removes a passed line', c.replace(`${passed}\n`, ''));
    await edit('memory_edit moves a passed line into Log', c.replace(`${passed}\n`, '').replace('## Log', `## Log\n\n${passed}`));
    await edit('memory_edit renames the heading', c.replace('## Milestones', '## Milestones done'));
    await edit('memory_edit breaks the section (step one of the two-step route)', c.replace(passed, `${passed} `));
    await edit('memory_edit breaks the section with (You)', c.replace(passed, passed.replace('(agent)', '(You)')));
    await edit('memory_edit adds a lookalike heading holding a pass', c.replace('## Log', `### milestones\n\n- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)\n\n## Log`));
    await expectRefused('memory_edit changes the type', 'memory_edit', { id: before, type: 'semantic' });
    await expectRefused('memory_forget of the project document', 'memory_forget', { id: before });
    const after = await call('project_get', { project: slug });
    console.log(`document unchanged: ${after.id === before ? 'yes' : 'NO'}`);
  }
} finally {
  await client.close();
  await server.close();
  delete process.env.NORTHKEEP_MASTER_KEY;
}
