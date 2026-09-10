import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault, type MemoryEntry } from '@northkeep/core';
import { startUiServer, type RunningUiServer } from '../apps/web/dist/server.js';

const passphrase = 'synthetic-consolidation-http-only';
let dir: string, vaultPath: string, secret: Buffer, server: RunningUiServer, origin: string, token: string;
let sources: MemoryEntry[], vaultId: string;
const previousHome = process.env.NORTHKEEP_HOME;
const previousKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;

async function request(route: string, body?: unknown, authenticated = true) {
  const response = await fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { 'X-NorthKeep-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-consolidation-http-'));
  process.env.NORTHKEEP_HOME = dir;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  secret = ensureDeviceSecret().secret;
  vaultPath = path.join(dir, 'sample.nkv');
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE });
  sources = [
    vault.remember({ content: 'Keep summaries concise.', type: 'semantic', scope: 'writing' }),
    vault.remember({ content: 'Use bullets for action items.', type: 'semantic', scope: 'writing' }),
    vault.remember({ content: 'For technical reviews, include reasoning and examples.', type: 'semantic', scope: 'writing' }),
  ];
  vault.remember({ content: 'Shared synthetic fact.', type: 'semantic', scope: 'shared' });
  vault.setScopeShared('shared', true);
  vault.remember({ content: 'Synthetic project document.', type: 'working', scope: 'project:sample' });
  vaultId = vault.getVaultId();
  vault.save(); vault.close();
  server = await startUiServer({ vaultPath });
  const url = new URL(server.url); origin = url.origin; token = url.searchParams.get('token')!;
});

afterAll(async () => {
  await server?.close();
  if (previousHome === undefined) delete process.env.NORTHKEEP_HOME; else process.env.NORTHKEEP_HOME = previousHome;
  if (previousKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN; else process.env.NORTHKEEP_NO_KEYCHAIN = previousKeychain;
  secret?.fill(0);
});

describe('consolidation over the real HTTP session boundary', () => {
  it('gates history and collections, and excludes shared/project collections', async () => {
    expect((await request('/api/curation/history', undefined, false)).status).toBe(401);
    expect((await request('/api/curation/history')).status).toBe(423);
    expect((await request('/api/unlock', { passphrase })).status).toBe(200);
    const collection = await request('/api/curation/collections');
    expect(collection.status).toBe(200);
    expect(collection.data.collections).toEqual([{ scope: 'writing', count: 3 }]);
  });

  it('rejects malformed and wrong-vault operations without changing disk', async () => {
    const bytes = fs.readFileSync(vaultPath);
    expect((await request('/api/curation/apply', { vault_id: vaultId, operation_id: randomUUID(), sources: [sources[0]], content: 'One source only.' })).status).toBe(400);
    const wrong = await request('/api/curation/apply', { vault_id: randomUUID(), operation_id: randomUUID(), sources, content: 'Wrong vault.' });
    expect([400, 409]).toContain(wrong.status);
    expect(fs.readFileSync(vaultPath)).toEqual(bytes);
  });

  it('applies exact wording once, survives reopen, then restores all originals once', async () => {
    const content = 'Keep summaries concise and use bullets for action items. For technical reviews, include reasoning and examples.';
    const payload = { vault_id: vaultId, operation_id: randomUUID(), sources, content };
    const saved = await request('/api/curation/apply', payload);
    expect(saved.status).toBe(200);
    expect(saved.data.result.content).toBe(content);
    expect((await request('/api/curation/apply', payload)).data.result.id).toBe(saved.data.result.id);
    expect((await request('/api/curation/apply', { ...payload, content: 'Different wording.' })).status).toBe(409);
    await request('/api/lock', {});
    await request('/api/unlock', { passphrase });
    expect((await request('/api/curation/apply', payload)).data.result.id).toBe(saved.data.result.id);
    const history = await request('/api/curation/history');
    expect(history.data.items).toHaveLength(1);
    expect(history.data.items[0].sources.map((source: MemoryEntry) => source.content)).toEqual(sources.map(source => source.content));
    const restorePayload = { vault_id: vaultId, operation_id: randomUUID(), result_id: saved.data.result.id, expected_result: saved.data.result };
    const restored = await request('/api/curation/restore', restorePayload);
    expect(restored.status).toBe(200);
    expect(restored.data.restored_entries.map((entry: MemoryEntry) => entry.content)).toEqual(sources.map(source => source.content));
    expect((await request('/api/curation/restore', restorePayload)).data.restored_entries.map((entry: MemoryEntry) => entry.id))
      .toEqual(restored.data.restored_entries.map((entry: MemoryEntry) => entry.id));
    expect((await request('/api/curation/restore', { ...restorePayload, operation_id: randomUUID() })).status).toBe(409);
    const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret: secret });
    try {
      expect(vault.list().filter(entry => entry.scope === 'writing').map(entry => entry.content)).toEqual(sources.map(source => source.content));
      expect(vault.verifyChain().ok).toBe(true);
    } finally { vault.close(); }
  });
});
