// Disposable MCP acceptance client. It never opens the owner's configured vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const [action, fixture, payloadFile] = process.argv.slice(2);
if (!['seed','resume','wrap'].includes(action)) throw new Error('Use seed, resume <fixture>, or wrap <fixture> <JSON payload file>.');
const home = action === 'seed' ? fs.mkdtempSync(path.join(os.tmpdir(), 'nk-handoff-test-')) : fs.realpathSync(fixture);
if (action !== 'seed' && (!home.startsWith('/private/tmp/nk-handoff-test-') || fs.readFileSync(path.join(home, 'synthetic-only'), 'utf8') !== 'northkeep-handoff-acceptance')) throw new Error('Only a session-created handoff fixture is allowed.');
process.env.NORTHKEEP_HOME = home;
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
process.env.NORTHKEEP_SCOPES = 'project:handoff-sample';
delete process.env.NORTHKEEP_PASSPHRASE;
delete process.env.NORTHKEEP_MASTER_KEY;
delete process.env.NORTHKEEP_REDACT_TIER;
const { Vault, setPlatform, ensureDeviceSecret, deriveMasterKey, KDF_INTERACTIVE } = await import('../packages/core/dist/index.js');
const { nodePlatform } = await import('../packages/platform-node/dist/index.js');
setPlatform(nodePlatform());
const secret = ensureDeviceSecret().secret;
const vaultPath = path.join(home, 'sample.nkv');
const passphrase = 'synthetic-handoff-only';
if (action === 'seed') {
  fs.writeFileSync(path.join(home, 'synthetic-only'), 'northkeep-handoff-acceptance');
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE });
  vault.close();
}
const header = Vault.readHeader(vaultPath);
const key = deriveMasterKey(passphrase, secret, header.salt, header.kdf);
process.env.NORTHKEEP_MASTER_KEY = key.toString('hex'); key.fill(0); secret.fill(0);
const { createServer } = await import('../packages/mcp-server/dist/server.js');
const server = createServer(vaultPath);
const client = new Client({ name: action === 'seed' ? 'Codex-acceptance' : 'Claude-Desktop-acceptance', version: '1.0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct), server.connect(st)]);
const call = async (name,args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};
try {
  if (action === 'seed') {
    const created = await call('project_update', { project: 'handoff-sample', expected_revision: null, status: 'Synthetic trail journal draft is complete.', next_actions: 'Check the missing audio index before reporting a final theme count.', what_why: 'Verify project continuity using disposable data only.' });
    await call('project_checkpoint', { project: 'handoff-sample', vault_id: created.vault_id, expected_revision: created.revision, operation_id: randomUUID(), status: 'Codex completed the synthetic draft. The final theme count is still unverified.', completed: 'Drafted three synthetic themes; the audio index could not be accessed.', next_actions: 'State that the theme count cannot be confirmed until the audio index is available.', open_questions: 'Can the audio index be recovered?', files: [{ type: 'local_path', label: 'Audio index.csv', locator: 'missing/Audio index.csv', access: 'unavailable' }] });
    console.log(JSON.stringify({ synthetic_fixture: home, project: 'handoff-sample' }));
  } else if (action === 'resume') console.log(JSON.stringify(await call('project_resume', { project: 'handoff-sample' }), null, 2));
  else {
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    if (payload.project !== 'handoff-sample') throw new Error('Only the disposable handoff sample may be updated.');
    console.log(JSON.stringify(await call('project_wrap', payload), null, 2));
  }
} finally {
  await client.close(); await server.close(); delete process.env.NORTHKEEP_MASTER_KEY;
}
