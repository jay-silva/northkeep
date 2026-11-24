import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault, deriveMasterKey, loadDeviceSecret } from '@northkeep/core';

/**
 * ADR 0085 acceptance (milestone 3 of relaunch step 1): two real MCP clients
 * drive two real server processes over one throwaway vault. Each step prints
 * what the server answered, so a run is its own evidence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'saved right e2e passphrase';

let home: string;
let env: Record<string, string>;
let a: Client;
let b: Client;

async function connect(name: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliPath, 'serve'], env, stderr: 'ignore' });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, step: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  console.log(`${step}\n  ${name} ${JSON.stringify(args)}\n  -> ${text.replace(/\s+/g, ' ')}`);
  expect(result.isError, text).toBeFalsy();
  return JSON.parse(text) as Record<string, any>;
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-saved-right-'));
  process.env.NORTHKEEP_HOME = home;
  execFileSync(process.execPath, [cliPath, 'init'], {
    env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE },
    stdio: 'ignore',
  });
  const header = Vault.readHeader(path.join(home, 'vault.nkv'));
  const key = deriveMasterKey(PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf);
  env = { PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_MASTER_KEY: key.toString('hex'), NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' };
  a = await connect('client-a');
  b = await connect('client-b');
}, 120_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0085 acceptance: saved right', () => {
  it('one fact told to one app is known to the other, held once, with the old version marked replaced', async () => {
    const first = await call(a, 'Step 1. Client A saves the fact.', 'memory_remember', { content: 'The harbor office is at Pier 4.', type: 'semantic' });
    expect(first.stored.source).toBe('mcp:client-a');

    const again = await call(a, 'Step 2. Client A saves it again.', 'memory_remember', { content: 'The harbor office is at Pier 4.', type: 'semantic' });
    expect(again.already_saved).toBe(true);
    expect(again.stored.id).toBe(first.stored.id);

    const held = await call(b, 'Step 3. Client B saves the update.', 'memory_remember', { content: 'The harbor office is now at Pier 9.', type: 'semantic' });
    expect(held.held).toBe(true);
    expect(held.saved).toBe(false);
    expect(held.possible_updates.map((m: { id: string }) => m.id)).toEqual([first.stored.id]);

    const replaced = await call(b, 'Step 4. Client B saves again with replaces.', 'memory_remember', { content: 'The harbor office is now at Pier 9.', type: 'semantic', replaces: first.stored.id });
    expect(replaced.stored.source).toBe('mcp:client-b');

    const separate = await call(b, 'Step 5. Client B saves a separate fact with distinct.', 'memory_remember', { content: 'The harbor office closes at five.', type: 'semantic', distinct: true });
    expect(separate.stored.content).toBe('The harbor office closes at five.');

    const found = await call(a, 'Step 6. Client A searches.', 'memory_retrieve', { query: 'which pier is the harbor office at' });
    const hits = found.results.map((m: { content: string }) => m.content);
    expect(hits[0]).toBe('The harbor office is now at Pier 9.');
    expect(hits).not.toContain('The harbor office is at Pier 4.');

    // The vault's own export, as the user would read it.
    const exported = JSON.parse(execFileSync(process.execPath, [cliPath, 'export'], {
      env: { ...env, NORTHKEEP_PASSPHRASE: PASSPHRASE }, encoding: 'utf8',
    })) as { memories: Array<{ id: string; content: string; provenance: { source: string }; validity: { superseded_by: string | null } }> };
    const rows = exported.memories.map((e) => ({ content: e.content, source: e.provenance.source, replaced_by: e.validity.superseded_by === null ? null : exported.memories.find((n) => n.id === e.validity.superseded_by)?.content }));
    console.log(`Export.\n${rows.map((r) => `  ${JSON.stringify(r)}`).join('\n')}`);
    expect(rows).toEqual([
      { content: 'The harbor office is at Pier 4.', source: 'mcp:client-a', replaced_by: 'The harbor office is now at Pier 9.' },
      { content: 'The harbor office is now at Pier 9.', source: 'mcp:client-b', replaced_by: null },
      { content: 'The harbor office closes at five.', source: 'mcp:client-b', replaced_by: null },
    ]);
  }, 60_000);
});
