import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret } from '@northkeep/core';
import { createServer } from '../src/server.js';

/**
 * Shared set-up for the ADR 0060 server tests: a throwaway NORTHKEEP_HOME and
 * vault, an in-process client, and a fetch stub that answers the loopback
 * name and embedding model. Nothing here reaches a real service.
 */

export interface Harness {
  home: string;
  vaultPath: string;
  connect(): Promise<Client>;
  openVault(): Vault;
  nerCalls(): number;
  close(): Promise<void>;
}

export type NerMode = 'ok' | 'offline' | ((text: string, call: number) => 'ok' | 'fail');

const ENV_KEYS = ['NORTHKEEP_HOME', 'NORTHKEEP_MASTER_KEY', 'NORTHKEEP_SCOPES', 'NORTHKEEP_NO_KEYCHAIN', 'NORTHKEEP_REDACT_TIER', 'NORTHKEEP_OLLAMA_URL'];

export function names(): string[] {
  // 'invalid_request': a real 3B model once tagged our own error code as an org.
  return ['Zyler Okonkwo', 'Quennell Abernathy-Vos', 'invalid_request'];
}

export function createHarness(opts: { ner?: NerMode } = {}): Harness {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0060-'));
  const vaultPath = path.join(home, 'vault.nkv');
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  delete process.env.NORTHKEEP_SCOPES;
  delete process.env.NORTHKEEP_REDACT_TIER;
  const passphrase = 'adr 0060 harness passphrase';
  const secret = generateDeviceSecret();
  Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(vaultPath);
  process.env.NORTHKEEP_MASTER_KEY = deriveMasterKey(passphrase, secret, header.salt, header.kdf).toString('hex');

  let calls = 0;
  const mode = opts.ner ?? 'ok';
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (!url.startsWith('http://127.0.0.1:9/')) throw new Error(`unexpected request in test: ${url}`);
    if (url.endsWith('/api/tags')) {
      return json({ models: mode === 'offline' ? [] : [{ name: 'llama3.2:3b' }] });
    }
    if (url.endsWith('/api/embed')) throw new Error('no embedder in this test');
    if (url.endsWith('/api/generate')) {
      calls += 1;
      const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      const text = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
      if (typeof mode === 'function' && mode(text, calls) === 'fail') throw new Error('name model timed out');
      const found = names().filter((n) => text.includes(n));
      return json({ response: JSON.stringify({ entities: found.map((t) => ({ text: t, kind: 'person' })) }) });
    }
    throw new Error(`unexpected Ollama path: ${url}`);
  });

  let client: Client | undefined;
  return {
    home,
    vaultPath,
    async connect() {
      if (client) await client.close().catch(() => undefined);
      const server = createServer(vaultPath);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: 'adr-0060-test', version: '1.0' });
      await Promise.all([mcp.connect(ct), server.connect(st)]);
      client = mcp;
      return mcp;
    },
    openVault() {
      return Vault.openWithKey(vaultPath, Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex'));
    },
    nerCalls: () => calls,
    async close() {
      if (client) await client.close().catch(() => undefined);
      vi.unstubAllGlobals();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
}

export function logRows(home: string): Array<Record<string, unknown>> {
  const file = path.join(home, 'mcp-calls.log');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
