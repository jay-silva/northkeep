import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallLogEntry } from '@northkeep/mcp-server';
import {
  addServer,
  createSession,
  getMcpCatalogEntry,
  getServer,
  isBundledVaultLaunch,
  runTask,
  setServerTrusted,
  type ChatMessage,
  type ChatOptions,
  type ChatTurnResult,
  type ConverseVault,
  type ModelProvider,
  type ToolDefinition,
} from '../src/index.js';

/**
 * ADR 0060 Decision 4 (D6): the catalog's vault server is added `trusted`, so
 * what the user asks it to remember is stored exactly; a custom server stays
 * `strict`, and the "This is my NorthKeep vault" offer needs the exact bundled
 * launch with no env and no cwd (F8).
 */

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-catalog-trust-'));
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(home, { recursive: true, force: true });
});

const fakeVault: ConverseVault = { retrieve: () => [], list: () => [], commit: () => [] };

function provider(args: string): ModelProvider {
  const script: ChatTurnResult[] = [
    { text: '', toolCalls: [{ id: 'c1', name: 'vault__memory_remember', arguments: args }], stopReason: 'tool_use' },
    { text: 'saved', toolCalls: [], stopReason: 'end' },
  ];
  const p: ModelProvider = {
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434',
    chat: (m: ChatMessage[], o: ChatOptions) => p.chatTurn(m, o).then((r) => r.text),
    chatTurn: () => Promise.resolve(script.shift()!),
    listModels: () => Promise.resolve([]),
  };
  return p;
}

/** Stands in for the server's memory_remember and records what it received. */
function rememberTool(received: unknown[]): ToolDefinition {
  return {
    name: 'vault__memory_remember', serverId: 'vault', description: 'remember', inputSchema: { type: 'object' },
    risk: 'consequential', egress: () => null,
    execute: async (args) => {
      received.push(args);
      return { content: '{"stored":true}', meta: { bytes: 15, truncated: false, ok: true } };
    },
  };
}

async function remember(content: string): Promise<unknown[]> {
  const received: unknown[] = [];
  await runTask({
    session: createSession(), provider: provider(JSON.stringify({ content, type: 'semantic' })), model: 'm',
    vault: fakeVault, distill: false, auditFn: (() => {}) as (e: CallLogEntry) => void,
    message: 'remember this', redactTier: 0, tools: [rememberTool(received)],
    // The call is consequential and the email raises a warning, so the user approves once.
    hooks: { onEvent: () => {}, requestApproval: () => Promise.resolve('allow') },
  });
  return received;
}

function addFromCatalog(): void {
  const entry = getMcpCatalogEntry('vault')!;
  expect(entry.available).toBe(true);
  addServer({ id: 'vault', command: entry.command!, args: entry.args!, safeRead: entry.safeRead, trust: entry.trust });
}

describe('ADR 0060 D6: the vault server stores what you say', () => {
  it('C14: the catalog vault server is trusted and receives memory_remember content unmasked', async () => {
    expect(getMcpCatalogEntry('vault')!.trust).toBe('trusted');
    addFromCatalog();
    expect(getServer('vault')!.trust).toBe('trusted');
    const received = await remember('my email is bob@example.com');
    expect(received).toEqual([{ content: 'my email is bob@example.com', type: 'semantic' }]);
  });

  it('a strict server still gets the Tier-1 floor (the old behaviour for the vault)', async () => {
    const entry = getMcpCatalogEntry('vault')!;
    addServer({ id: 'vault', command: entry.command!, args: entry.args! });
    const received = await remember('my email is bob@example.com');
    expect(received).toEqual([{ content: 'my email is [EMAIL_1]', type: 'semantic' }]);
  });

  it('C15: a custom-added server with the exact command and args stays strict until confirmed', () => {
    const entry = getMcpCatalogEntry('vault')!;
    addServer({ id: 'mine', command: entry.command!, args: entry.args! });
    const server = getServer('mine')!;
    expect(server.trust).toBe('strict');
    expect(isBundledVaultLaunch(server)).toBe(true);
    setServerTrusted('mine');
    expect(getServer('mine')!.trust).toBe('trusted');
  });

  it('C32: an entry with any env or cwd override is never offered the vault-trust button', () => {
    const entry = getMcpCatalogEntry('vault')!;
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-other-home-'));
    addServer({ id: 'elsewhere', command: entry.command!, args: entry.args!, env: { NORTHKEEP_HOME: other } });
    addServer({ id: 'cwd', command: entry.command!, args: entry.args!, cwd: os.tmpdir() });
    addServer({ id: 'extra-arg', command: entry.command!, args: [...entry.args!, '--vault', path.join(other, 'v.nkv')] });
    for (const id of ['elsewhere', 'cwd', 'extra-arg']) expect(isBundledVaultLaunch(getServer(id)!), id).toBe(false);
    fs.rmSync(other, { recursive: true, force: true });
  });
});
