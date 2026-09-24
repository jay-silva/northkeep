// Disposable MCP client for the ADR 0060 acceptance steps. It refuses to run
// unless NORTHKEEP_HOME is the acceptance home, so it can never open the
// owner's vault or append to the owner's call log. Unlike the ADR 0054 client
// it SETS NORTHKEEP_REDACT_TIER from its first argument. It never calls a
// model provider: the one chat step uses a local stub model.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const THROWAWAY = '/tmp/nk-0060-acceptance/home';
const home = process.env.NORTHKEEP_HOME ?? '';
if (!fs.existsSync(home) || fs.realpathSync(home) !== fs.realpathSync(THROWAWAY)) {
  throw new Error(`NORTHKEEP_HOME must be ${THROWAWAY}; this client never opens any other vault.`);
}
const passphrase = process.env.NORTHKEEP_PASSPHRASE;
if (!passphrase) throw new Error('NORTHKEEP_PASSPHRASE is not set.');
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
delete process.env.NORTHKEEP_SCOPES;

const [first, action, ...rest] = process.argv.slice(2);
const USAGE = 'Use: <tier> list <scope> | <tier> update <slug> | <tier> remember "<text>" | <tier> describe <tool> | catalog-remember "<text>"';

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

async function connect() {
  const server = createServer(vaultPath);
  const client = new Client({ name: 'adr-0060-acceptance', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server };
}

function textOf(result) {
  return result.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
}

try {
  if (first === 'catalog-remember') {
    const content = action;
    if (!content) throw new Error(USAGE);
    delete process.env.NORTHKEEP_REDACT_TIER;
    const converse = await import('../packages/converse/dist/index.js');
    const entry = converse.getMcpCatalogEntry('vault');
    if (!entry?.available) throw new Error('The bundled vault server was not found; run pnpm -r build first.');
    if (!converse.getServer('vault')) {
      converse.addServer({ id: 'vault', command: entry.command, args: entry.args, safeRead: entry.safeRead, trust: entry.trust });
    }
    console.log(`vault server added from the catalog as: ${converse.getServer('vault').trust}`);
    const { client, server } = await connect();
    // The tool the chat would call, wired to the real server in-process.
    const tool = {
      name: 'vault__memory_remember', serverId: 'vault', description: 'remember', inputSchema: { type: 'object' },
      risk: 'consequential', egress: () => null,
      execute: async (args) => {
        const r = await client.callTool({ name: 'memory_remember', arguments: args });
        return { content: textOf(r), meta: { bytes: 0, truncated: false, ok: !r.isError } };
      },
    };
    const script = [
      { text: '', toolCalls: [{ id: 'c1', name: 'vault__memory_remember', arguments: JSON.stringify({ content, type: 'semantic' }) }], stopReason: 'tool_use' },
      { text: 'Saved.', toolCalls: [], stopReason: 'end' },
    ];
    const stubModel = {
      kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
      chat: async () => 'Saved.', chatTurn: async () => script.shift(), listModels: async () => [],
    };
    await converse.runTask({
      session: converse.createSession(), provider: stubModel, model: 'stub', distill: false,
      vault: { retrieve: () => [], list: () => [], commit: () => [] }, auditFn: () => {},
      message: 'remember this', redactTier: 0, tools: [tool],
      // The call is consequential and an email raises a warning; approve this one call.
      hooks: { onEvent: () => {}, requestApproval: async () => 'allow' },
    });
    const list = JSON.parse(textOf(await client.callTool({ name: 'memory_list', arguments: {} })));
    console.log(`stored: ${list.memories.at(-1)?.content ?? '(nothing)'}`);
    await client.close();
    await server.close();
  } else {
    if (!first || !action) throw new Error(USAGE);
    process.env.NORTHKEEP_REDACT_TIER = first;
    const { client, server } = await connect();
    let result;
    if (action === 'list') {
      result = await client.callTool({ name: 'memory_list', arguments: rest[0] ? { scope: rest[0] } : {} });
    } else if (action === 'update') {
      result = await client.callTool({ name: 'project_create', arguments: { project: rest[0], what_why: 'Acceptance project.', status: 'Created by the acceptance client.' } });
    } else if (action === 'remember') {
      result = await client.callTool({ name: 'memory_remember', arguments: { content: rest[0], type: 'semantic' } });
    } else if (action === 'describe') {
      const { tools } = await client.listTools();
      console.log(tools.find((t) => t.name === rest[0])?.description ?? '(no such tool)');
    } else {
      throw new Error(USAGE);
    }
    if (result) {
      const out = textOf(result);
      if (result.isError) {
        console.log(`refused: ${out}`);
      } else {
        const payload = JSON.parse(out);
        if (payload.redaction_note) console.log(`note: ${payload.redaction_note}`);
        for (const m of payload.memories ?? []) console.log(`${m.created_at}  ${m.content}`);
        if (payload.stored) console.log(`stored: ${payload.stored.content}`);
        if (payload.saved) console.log(`saved, with warning: ${payload.log_warning}`);
      }
    }
    await client.close();
    await server.close();
  }
} finally {
  delete process.env.NORTHKEEP_MASTER_KEY;
}
