import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * M4 acceptance — the professional demo:
 *  - a connection granted only "personal" cannot see or write client scopes
 *  - denials and disclosures are recorded
 *  - the audit log exports as CSV/JSON with provider, grant, scope, entry ids
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'm4 e2e passphrase';

let home: string;

function cli(args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    env: { PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE, NORTHKEEP_NO_KEYCHAIN: '1', ...extraEnv },
    encoding: 'utf8',
  });
}

async function connect(scopes?: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'serve'],
    env: {
      PATH: process.env.PATH ?? '',
      NORTHKEEP_HOME: home,
      NORTHKEEP_PASSPHRASE: PASSPHRASE,
      NORTHKEEP_NO_KEYCHAIN: '1',
      ...(scopes ? { NORTHKEEP_SCOPES: scopes } : {}),
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'scoped-e2e-client', version: '1.0' });
  await client.connect(transport);
  return client;
}

function text(r: Awaited<ReturnType<Client['callTool']>>): string {
  return (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
}

beforeAll(() => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m4-'));
  cli(['init']);
  cli(['remember', 'My coffee is black', '--type', 'semantic', '--scope', 'personal']);
  cli(['remember', 'The Henderson settlement is confidential', '--type', 'episodic', '--scope', 'client:henderson']);
  cli(['remember', 'The Acme merger closes in Q3', '--type', 'episodic', '--scope', 'client:acme']);
}, 120_000);

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M4 acceptance — scopes + audit', () => {
  it('a connection granted only "personal" cannot retrieve or list client scopes', async () => {
    const client = await connect('personal');
    try {
      const list = JSON.parse(text(await client.callTool({ name: 'memory_list', arguments: {} }))) as { memories: Array<{ scope: string }> };
      expect(list.memories.every((m) => m.scope === 'personal')).toBe(true);
      expect(list.memories).toHaveLength(1);

      const retrieve = JSON.parse(text(await client.callTool({
        name: 'memory_retrieve', arguments: { query: 'Henderson settlement confidential' },
      }))) as { results: unknown[] };
      expect(retrieve.results).toHaveLength(0); // cannot cross the grant

      // Even naming the forbidden scope explicitly returns nothing.
      const scoped = JSON.parse(text(await client.callTool({
        name: 'memory_retrieve', arguments: { query: 'Acme merger', scope: 'client:acme' },
      }))) as { results: unknown[] };
      expect(scoped.results).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('a connection scoped to one client sees ONLY that client', async () => {
    const client = await connect('client:henderson');
    try {
      const list = JSON.parse(text(await client.callTool({ name: 'memory_list', arguments: {} }))) as { memories: Array<{ scope: string; content: string }> };
      expect(list.memories).toHaveLength(1);
      expect(list.memories[0]!.content).toContain('Henderson');
    } finally {
      await client.close();
    }
  });

  it('writing outside the grant is denied and recorded', async () => {
    const client = await connect('personal');
    try {
      const r = await client.callTool({
        name: 'memory_remember',
        arguments: { content: 'sneaky client note', type: 'semantic', scope: 'client:acme' },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not granted the "client:acme" scope/);
    } finally {
      await client.close();
    }
    // The denial is in the audit trail.
    const audit = cli(['audit', '--format', 'json']);
    const rows = JSON.parse(audit) as Array<{ tool: string; denied?: boolean; granted_scopes?: string[] }>;
    const denial = rows.find((x) => x.tool === 'memory_remember' && x.denied);
    expect(denial).toBeDefined();
    expect(denial!.granted_scopes).toEqual(['personal']);
  });

  it('full-access (owner) connection sees everything', async () => {
    const client = await connect(); // no grant → full
    try {
      const list = JSON.parse(text(await client.callTool({ name: 'memory_list', arguments: {} }))) as { memories: unknown[] };
      expect(list.memories).toHaveLength(3);
    } finally {
      await client.close();
    }
  });

  it('audit CSV has the professional columns and records provider + disclosed scopes', () => {
    const csv = cli(['audit', '--format', 'csv']);
    const header = csv.split('\n')[0]!;
    for (const col of ['timestamp', 'provider', 'tool', 'denied', 'granted_scopes', 'disclosed_scopes', 'disclosed_ids']) {
      expect(header).toContain(col);
    }
    expect(csv).toContain('scoped-e2e-client'); // the MCP client name was captured
    // No memory CONTENT ever appears in the audit — ids and scope labels only.
    expect(csv).not.toContain('settlement is confidential');
    expect(csv).not.toContain('coffee is black');
  });

  it('optional Tier-1 masking scrubs secrets in returned content (NORTHKEEP_REDACT_TIER=1)', async () => {
    cli(['remember', 'Client card 4111 1111 1111 1111 on file', '--type', 'semantic', '--scope', 'personal']);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'serve'],
      env: { PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_REDACT_TIER: '1' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'redacting-client', version: '1.0' });
    await client.connect(transport);
    try {
      const r = JSON.parse(text(await client.callTool({ name: 'memory_retrieve', arguments: { query: 'client card file' } }))) as { results: Array<{ content: string }> };
      const hit = r.results.find((x) => x.content.includes('Client card'));
      expect(hit).toBeDefined();
      expect(hit!.content).not.toContain('4111 1111 1111 1111'); // masked before it left
      expect(hit!.content).toContain('[CREDIT_CARD_1]');
    } finally {
      await client.close();
    }
  });
});
