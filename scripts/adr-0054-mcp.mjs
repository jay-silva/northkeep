// Disposable MCP client for the ADR 0054 acceptance script. It refuses to run
// unless NORTHKEEP_HOME is the acceptance script's throwaway home, so it can
// never open the owner's vault or append to the owner's call log. Each run is
// a new server process, so a new session id, like a new AI app session.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const THROWAWAY = '/tmp/nk-0054-acceptance/home';
const [action, slug] = process.argv.slice(2);
if (!['read', 'board', 'draft', 'wrap'].includes(action) || (action !== 'board' && !slug)) {
  throw new Error('Use: read <slug> | board | draft <slug> | wrap <slug>');
}
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
process.env.NORTHKEEP_MASTER_KEY = key.toString('hex');
key.fill(0);
secret.fill(0);

const { createServer } = await import('../packages/mcp-server/dist/server.js');
const server = createServer(vaultPath);
const client = new Client({ name: 'acceptance-app', version: '1.0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct), server.connect(st)]);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};
try {
  if (action === 'read') {
    const view = await call('project_get', { project: slug });
    console.log(`Read project ${view.project} (revision ${view.revision.slice(0, 8)}) and quit without writing.`);
  } else if (action === 'board') {
    const board = await call('project_board', {});
    const open = 'unavailable' in board.open_sessions ? 'unavailable' : String(board.open_sessions.total);
    console.log(`Board read over MCP: ${board.stale.total} stale, ${board.dated.total} dated, ${open} open sessions.`);
  } else if (action === 'draft') {
    await call('project_create', { project: slug, what_why: 'A draft made by the acceptance client.', status: 'Bootstrapped, not yet checked.', draft: true });
    console.log(`Created draft project ${slug}.`);
  } else {
    const view = await call('project_resume', { project: slug });
    await call('project_wrap', {
      project: slug, vault_id: view.vault_id, expected_revision: view.revision, operation_id: randomUUID(),
      status: 'Checked by the owner.', completed: 'Reviewed the draft.', next_actions: '',
    });
    console.log(`Wrapped project ${slug}.`);
  }
} finally {
  await client.close();
  await server.close();
  delete process.env.NORTHKEEP_MASTER_KEY;
}
