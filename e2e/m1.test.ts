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
 * M1 acceptance: a real MCP client (what Claude Desktop is) drives the real
 * server binary over stdio. Store → retrieve → list → forget round-trip, a
 * content-free call log, cross-surface visibility from the CLI, and the
 * locked-vault failure mode.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'm1 e2e passphrase';
const SECRET_CONTENT = 'The Henderson settlement number is 425000 dollars';

let home: string;
let masterKeyHex: string;
let client: Client;

function serverEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    NORTHKEEP_HOME: home,
    NORTHKEEP_NO_KEYCHAIN: '1',
    ...extra,
  };
}

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'serve'],
    env,
    stderr: 'ignore',
  });
  const mcpClient = new Client({ name: 'northkeep-e2e', version: '0.0.0' });
  await mcpClient.connect(transport);
  return mcpClient;
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m1-'));
  process.env.NORTHKEEP_HOME = home;

  execFileSync(process.execPath, [cliPath, 'init'], {
    env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE },
    stdio: 'ignore',
  });
  // Derive the master key the way `northkeep unlock` does, and hand it to the
  // server via env (the keychain path is macOS-interactive, not for CI).
  const vaultPath = path.join(home, 'vault.nkv');
  const header = Vault.readHeader(vaultPath);
  const key = deriveMasterKey(PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf);
  masterKeyHex = key.toString('hex');

  client = await connect(serverEnv({ NORTHKEEP_MASTER_KEY: masterKeyHex }));
}, 120_000);

afterAll(async () => {
  await client?.close();
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('M1 acceptance — MCP server', () => {
  let storedId = '';

  it('exposes the four memory tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['memory_forget', 'memory_list', 'memory_remember', 'memory_retrieve']);
  });

  it('memory_remember stores an entry', async () => {
    const result = await client.callTool({
      name: 'memory_remember',
      arguments: { content: SECRET_CONTENT, type: 'semantic', scope: 'work' },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(toolText(result)) as { stored: { id: string; source: string } };
    expect(payload.stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.stored.source).toBe('mcp');
    storedId = payload.stored.id;
  });

  it('memory_retrieve finds it by keywords', async () => {
    const result = await client.callTool({
      name: 'memory_retrieve',
      arguments: { query: 'What is the Henderson settlement amount?' },
    });
    const payload = JSON.parse(toolText(result)) as { results: Array<{ id: string; content: string }> };
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0]!.id).toBe(storedId);
    expect(payload.results[0]!.content).toBe(SECRET_CONTENT);
  });

  it('memory_list shows the entry; the CLI sees it too (cross-surface)', async () => {
    const result = await client.callTool({ name: 'memory_list', arguments: {} });
    const payload = JSON.parse(toolText(result)) as { memories: Array<{ id: string }> };
    expect(payload.memories.some((m) => m.id === storedId)).toBe(true);

    const cliOut = execFileSync(process.execPath, [cliPath, 'list'], {
      env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_MASTER_KEY: masterKeyHex, NORTHKEEP_NO_KEYCHAIN: '1' },
      encoding: 'utf8',
    });
    expect(cliOut).toContain(SECRET_CONTENT);
    expect(cliOut).toContain('Provenance chain verified');
  });

  it('memory_forget tombstones the entry', async () => {
    const result = await client.callTool({ name: 'memory_forget', arguments: { id: storedId } });
    expect(result.isError).toBeFalsy();
    const retrieve = await client.callTool({
      name: 'memory_retrieve',
      arguments: { query: 'Henderson settlement' },
    });
    const payload = JSON.parse(toolText(retrieve)) as { results: unknown[] };
    expect(payload.results).toHaveLength(0);
  });

  it('logs every call — without content', async () => {
    const logPath = path.join(home, 'mcp-calls.log');
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as { tool: string; ok: boolean });
    const tools = lines.map((l) => l.tool);
    for (const expected of ['memory_remember', 'memory_retrieve', 'memory_list', 'memory_forget']) {
      expect(tools).toContain(expected);
    }
    // The invariant: memory content never reaches the log.
    expect(raw).not.toContain('Henderson');
    expect(raw).not.toContain('425000');
  });

  it('rejects wildcard ids and content-shaped params at the schema boundary', async () => {
    // LIKE metacharacters in id (would wildcard-match) — rejected pre-vault.
    const wildcard = await client.callTool({
      name: 'memory_forget',
      arguments: { id: '%%%%%%%%' },
    }).catch((e: Error) => e);
    if (wildcard instanceof Error) {
      expect(wildcard.message).toMatch(/memory id|invalid/i);
    } else {
      expect(wildcard.isError).toBe(true);
    }
    // Content-shaped scope (log-injection vector) — rejected pre-vault, so
    // it can never reach the plaintext call log.
    const injected = await client.callTool({
      name: 'memory_list',
      arguments: { scope: 'the Henderson settlement is 425000' },
    }).catch((e: Error) => e);
    if (injected instanceof Error) {
      expect(injected.message).toMatch(/scope|invalid/i);
    } else {
      expect(injected.isError).toBe(true);
    }
    const logRaw = fs.readFileSync(path.join(home, 'mcp-calls.log'), 'utf8');
    expect(logRaw).not.toContain('settlement is 425000');
  });

  it('a locked vault fails helpfully, not silently', async () => {
    const lockedClient = await connect(serverEnv()); // no key, no keychain, no passphrase
    try {
      const result = await lockedClient.callTool({
        name: 'memory_retrieve',
        arguments: { query: 'anything' },
      });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain('northkeep unlock');
    } finally {
      await lockedClient.close();
    }
  });
});
