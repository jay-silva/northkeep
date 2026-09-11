import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';

vi.mock('@northkeep/librarian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@northkeep/librarian')>();
  return {
    ...actual,
    createOllamaEmbedder: () => ({
      model: 'offline-test-embedder',
      embed: async () => [1, 0, 0],
    }),
  };
});

import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

const passphrase = 'synthetic memories filter passphrase';
let testHome: string;
let session: UiSession;
const previousHome = process.env.NORTHKEEP_HOME;
const previousNoKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;

async function getMemories(params: Record<string, string> = {}) {
  const response = await handleApi(
    session,
    'GET',
    '/api/memories',
    new URLSearchParams(params),
    Buffer.alloc(0),
  );
  expect(response.status).toBe(200);
  return response.body as { memories: Array<{ content: string; scope: string }> };
}

beforeEach(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ui-test-memories-filter-'));
  process.env.NORTHKEEP_HOME = testHome;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  const vaultPath = path.join(testHome, 'vault.nkv');
  const { secret } = ensureDeviceSecret();
  Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
  secret.fill(0);
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
});

afterEach(() => {
  session?.lock();
  fs.rmSync(testHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = previousHome;
  if (previousNoKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN;
  else process.env.NORTHKEEP_NO_KEYCHAIN = previousNoKeychain;
});

async function seed(projectCount: number, includePersonal = true) {
  await session.withVault((vault) => {
    if (includePersonal) vault.remember({ content: 'dog belongs in ordinary memory', type: 'semantic', scope: 'personal' });
    for (let index = 0; index < projectCount; index += 1) {
      vault.remember({ content: `dog project record ${index}`, type: 'working', scope: `project:p${index}` });
    }
    vault.save();
  });
}

describe('GET /api/memories project filtering', () => {
  it('filters project scopes before semantic ranking and its limit', async () => {
    await seed(55);
    const result = await getMemories({ q: 'dog', exclude_projects: '1' });
    expect(result.memories.map((memory) => memory.content)).toEqual(['dog belongs in ordinary memory']);
  });

  it('keeps project scopes excluded even when one is explicitly requested', async () => {
    await seed(1);
    const result = await getMemories({ scope: 'project:p0', exclude_projects: '1' });
    expect(result.memories).toEqual([]);
  });

  it('returns an empty Memories view for a vault containing only project records', async () => {
    await seed(3, false);
    const result = await getMemories({ exclude_projects: '1' });
    expect(result.memories).toEqual([]);
  });

  it('preserves project records by default for existing API callers', async () => {
    await seed(2);
    const result = await getMemories();
    expect(result.memories.filter((memory) => memory.scope.startsWith('project:'))).toHaveLength(2);
    expect(result.memories).toHaveLength(3);
  });
});
