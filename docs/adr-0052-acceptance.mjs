/**
 * Drives the ADR 0052 acceptance steps that need MCP project tools, which the
 * CLI does not expose. Two in-process MCP clients with different handshake
 * names stand in for two hosts, exactly as packages/mcp-server/test does.
 *
 * Usage: node docs/adr-0052-acceptance.mjs <step>
 *   hosts    step 1, a wrap from one host then a resume and wrap from another
 *   tamper   step 2, edits a writer block in a copy of the vault
 *   open     step 3, a read that never wrote back, seen from the other host
 *   payload  step 4, the default resume payload size and a one-revision read
 *   compacted step 2 again, what a compacted revision keeps and what breaks it
 *   draft    step 5, draft on create, cleared by a wrap, second create refused
 *
 * Reads NORTHKEEP_HOME like every other NorthKeep process. Writes nothing
 * outside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Vault, deriveMasterKey, loadDeviceSecret, setPlatform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';

setPlatform(nodePlatform());
// The repository root does not link the server package; the build output does.
const { createServer } = await import(new URL('../packages/mcp-server/dist/index.js', import.meta.url).href);

const home = process.env.NORTHKEEP_HOME;
if (!home) throw new Error('Set NORTHKEEP_HOME first.');
const vaultPath = path.join(home, 'vault.nkv');

/** One server process per client, so each handshake gets its own session id. */
async function connectAs(name, version = '1.0') {
  const server = createServer(vaultPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => part.text ?? '').join('');
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return { text, json: JSON.parse(text) };
}

const uuid = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

async function hosts() {
  const code = await connectAs('claude-code', '0.24.0');
  const created = (await call(code, 'project_create', {
    project: 'acceptance', what_why: 'Proving ADR 0052 on a disposable project.', status: 'Started.',
  })).json;
  const wrapped = (await call(code, 'project_wrap', {
    vault_id: created.vault_id, project: 'acceptance', operation_id: uuid('a'),
    expected_revision: created.revision, status: 'Wrapped by Claude Code.',
    completed: 'Wrote the first revision.', next_actions: '',
  })).json;
  console.log('step 1 after the Claude Code wrap: last_writer.host =', wrapped.current.last_writer.host,
    'session_id =', wrapped.current.last_writer.session_id);
  await code.close();

  const codex = await connectAs('codex-mcp-client', '2.0');
  const resumed = (await call(codex, 'project_resume', { project: 'acceptance' })).json;
  console.log('step 1 Codex resume sees: last_writer.host =', resumed.last_writer.host);
  const second = (await call(codex, 'project_wrap', {
    vault_id: created.vault_id, project: 'acceptance', operation_id: uuid('b'),
    expected_revision: resumed.revision, status: 'Wrapped by Codex.',
    completed: 'Read it and closed it.', next_actions: '',
  })).json;
  console.log('step 1 after the Codex wrap: last_writer.host =', second.current.last_writer.host,
    'session_id =', second.current.last_writer.session_id);
  await codex.close();
}

async function tamper() {
  const copy = path.join(home, 'tampered.nkv');
  fs.copyFileSync(vaultPath, copy);
  const header = Vault.readHeader(copy);
  const key = deriveMasterKey(process.env.NORTHKEEP_PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf);
  const vault = Vault.openWithKey(copy, key);
  console.log('step 2 copy before the edit: chain ok =', vault.verifyChain().ok);
  const head = vault.list({ scope: 'project:acceptance' }).find((entry) => entry.type === 'working');
  const block = { ...head.metadata.northkeep_provenance_v1, host: 'not-the-writer' };
  const db = vault.db;
  db.prepare('UPDATE memories SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ ...head.metadata, northkeep_provenance_v1: block }), head.id);
  const checked = vault.verifyChain();
  console.log('step 2 copy after editing the live head writer block: chain ok =', checked.ok);
  console.log('step 2 reported:', checked.error);
  vault.close();
  fs.rmSync(copy);
}

async function open() {
  const code = await connectAs('claude-code', '0.24.0');
  const read = (await call(code, 'project_resume', { project: 'acceptance' })).json;
  console.log('step 3 Claude Code read revision', read.revision, 'and wrote nothing');
  await code.close();

  const codex = await connectAs('codex-mcp-client', '2.0');
  const resumed = (await call(codex, 'project_resume', { project: 'acceptance' })).json;
  for (const session of resumed.open_sessions) {
    console.log('step 3 open session:', session.host, session.session_id, 'last read', session.last_read_at);
  }
  console.log('step 3 note:', resumed.open_sessions_note);
  await codex.close();
}

async function payload() {
  const code = await connectAs('claude-code', '0.24.0');
  const view = (await call(code, 'project_get', { project: 'acceptance' })).json;
  let revision = view.revision;
  for (let i = 0; i < 25; i += 1) {
    revision = (await call(code, 'project_update', {
      project: 'acceptance', expected_revision: revision,
      log_entry: `Session ${i} did some work worth a sentence in the log.`,
    })).json.revision;
  }
  const brief = await call(code, 'project_resume', { project: 'acceptance' });
  console.log('step 4 default resume payload:', Buffer.byteLength(brief.text, 'utf8'), 'bytes, target under', 24 * 1024);
  console.log('step 4 revisions carried:', brief.json.revisions.length, 'summaries, history entries:', brief.json.history.length);
  const full = await call(code, 'project_resume', { project: 'acceptance', history: true });
  console.log('step 4 with history: true:', Buffer.byteLength(full.text, 'utf8'), 'bytes');
  const older = brief.json.revisions[0].id;
  const one = (await call(code, 'project_get', { project: 'acceptance', revision: older })).json;
  console.log('step 4 one revision read:', one.id, 'is', one.content.length, 'characters of text');
  await code.close();
}

async function draft() {
  const code = await connectAs('claude-code', '0.24.0');
  const created = (await call(code, 'project_create', {
    project: 'bootstrapped', what_why: 'Built from a repository, unverified.',
    status: 'Read the README and the newest commits.', draft: true,
  })).json;
  console.log('step 5 created draft:', created.draft, '| first line:', created.content.split('\n')[0]);
  const listed = (await call(code, 'project_list', {})).json;
  console.log('step 5 list shows draft:', listed.projects.find((p) => p.project === 'bootstrapped').draft);
  const wrapped = (await call(code, 'project_wrap', {
    vault_id: created.vault_id, project: 'bootstrapped', operation_id: uuid('c'),
    expected_revision: created.revision, status: 'Checked every claim.',
    completed: 'Verified the bootstrap.', next_actions: '',
  })).json;
  console.log('step 5 after the wrap, draft:', wrapped.current.draft, '| first line:', wrapped.current.content.split('\n')[0]);
  const again = await code.callTool({
    name: 'project_create', arguments: { project: 'bootstrapped', what_why: 'Second try.', status: 'Second try.' },
  });
  console.log('step 5 second create refused:', again.isError, '|', JSON.parse(again.content[0].text).error.code);
  await code.close();
}

/** ADR 0051 addendum: a compacted revision keeps its writer block and nothing else. */
async function compacted() {
  const copy = path.join(home, 'compacted-check.nkv');
  fs.copyFileSync(vaultPath, copy);
  const header = Vault.readHeader(copy);
  const key = deriveMasterKey(process.env.NORTHKEEP_PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf);
  const vault = Vault.openWithKey(copy, key);
  const blanked = vault.list({ scope: 'project:acceptance', includeSuperseded: true, includeForgotten: true })
    .filter((entry) => entry.forgotten_at !== null);
  const writer = blanked[0].metadata.northkeep_provenance_v1;
  console.log('step 2 blanked revisions:', blanked.length, '| first one keeps host', writer.host,
    'session', writer.session_id, '| text length', blanked[0].content.length);
  console.log('step 2 metadata keys on that row:', Object.keys(blanked[0].metadata).join(', '));
  console.log('step 2 chain with the kept blocks: ok =', vault.verifyChain().ok);
  const db = vault.db;
  db.prepare('UPDATE memories SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ northkeep_provenance_v1: writer, smuggled: 'extra' }), blanked[0].id);
  const checked = vault.verifyChain();
  console.log('step 2 after smuggling a second key onto that blanked row: ok =', checked.ok);
  console.log('step 2 reported:', checked.error);
  vault.close();
  fs.rmSync(copy);
}

const steps = { hosts, tamper, open, payload, draft, compacted };
const step = process.argv[2];
if (!steps[step]) throw new Error(`Unknown step "${step}". One of: ${Object.keys(steps).join(', ')}`);
await steps[step]();
