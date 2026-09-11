import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { startUiServer, type RunningUiServer } from '../apps/web/dist/server.js';

const passphrase = 'synthetic local search controls passphrase';
let testHome: string;
let ollama: http.Server;
let server: RunningUiServer;
let origin: string;
let token: string;
const previousHome = process.env.NORTHKEEP_HOME;
const previousNoKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;
const previousOllamaUrl = process.env.NORTHKEEP_OLLAMA_URL;

async function getStatus(authToken?: string) {
  const response = await fetch(`${origin}/api/local/search/status`, {
    headers: authToken === undefined ? {} : { 'X-NorthKeep-Token': authToken },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ui-local-search-'));
  process.env.NORTHKEEP_HOME = testHome;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';

  ollama = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      models: [
        { name: 'qwen2.5:14b', model: 'qwen2.5:14b' },
        {
          name: 'nomic-embed-text:latest',
          model: 'nomic-embed-text:latest',
          size: 274302450,
          capabilities: ['embedding'],
        },
        { name: 'llama3.2:3b', model: 'llama3.2:3b' },
      ],
    }));
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  const port = (ollama.address() as { port: number }).port;
  process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;

  const vaultPath = path.join(testHome, 'vault.nkv');
  const { secret } = ensureDeviceSecret();
  Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
  secret.fill(0);
  server = await startUiServer({ vaultPath });
  const url = new URL(server.url);
  origin = url.origin;
  token = url.searchParams.get('token')!;
});

afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve) => ollama?.close(() => resolve()));
  fs.rmSync(testHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = previousHome;
  if (previousNoKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN;
  else process.env.NORTHKEEP_NO_KEYCHAIN = previousNoKeychain;
  if (previousOllamaUrl === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
  else process.env.NORTHKEEP_OLLAMA_URL = previousOllamaUrl;
});

describe('local search controls through authenticated HTTP', () => {
  it('requires the session token and an unlocked vault', async () => {
    expect((await getStatus()).status).toBe(401);
    expect(await getStatus(token)).toEqual({ status: 423, body: { error: 'Vault is locked.' } });
  });

  it('reports exact embedding readiness after unlock', async () => {
    const unlock = await fetch(`${origin}/api/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-NorthKeep-Token': token },
      body: JSON.stringify({ passphrase }),
    });
    expect(unlock.status).toBe(200);
    const result = await getStatus(token);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      runtime: 'running',
      embedding_model: 'installed',
      model: 'nomic-embed-text',
    });
  });
});
