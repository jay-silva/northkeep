import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { startUiServer, type RunningUiServer } from '../apps/web/dist/server.js';

const passphrase = 'synthetic project filter http passphrase';
const previousHome = process.env.NORTHKEEP_HOME;
const previousNoKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;
let testHome: string;
let server: RunningUiServer;
let origin: string;
let token: string;

async function request(route: string, body?: unknown) {
  const response = await fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'X-NorthKeep-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as { memories?: Array<{ scope: string }> } };
}

beforeAll(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ui-test-project-filter-http-'));
  process.env.NORTHKEEP_HOME = testHome;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  const vaultPath = path.join(testHome, 'vault.nkv');
  const { secret } = ensureDeviceSecret();
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE });
  vault.remember({ content: 'ordinary dog memory', type: 'semantic', scope: 'personal' });
  vault.remember({ content: 'project dog record', type: 'working', scope: 'project:alpha' });
  vault.save();
  vault.close();
  secret.fill(0);
  server = await startUiServer({ vaultPath });
  const url = new URL(server.url);
  origin = url.origin;
  token = url.searchParams.get('token')!;
  expect((await request('/api/unlock', { passphrase })).status).toBe(200);
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(testHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = previousHome;
  if (previousNoKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN;
  else process.env.NORTHKEEP_NO_KEYCHAIN = previousNoKeychain;
});

describe('Memories project filtering through the authenticated HTTP server', () => {
  it('omits project documents only when explicitly requested', async () => {
    const filtered = await request('/api/memories?exclude_projects=1');
    expect(filtered.status).toBe(200);
    expect(filtered.data.memories?.map((memory) => memory.scope)).toEqual(['personal']);

    const explicitProject = await request('/api/memories?exclude_projects=1&scope=project%3Aalpha');
    expect(explicitProject.status).toBe(200);
    expect(explicitProject.data.memories).toEqual([]);

    const unfiltered = await request('/api/memories');
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.data.memories?.map((memory) => memory.scope).sort()).toEqual(['personal', 'project:alpha']);
  });
});
