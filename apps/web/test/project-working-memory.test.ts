import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, ensureDeviceSecret, listProjectOverview } from '@northkeep/core';

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

const passphrase = 'synthetic project working memory passphrase';
let testHome: string;
let session: UiSession;
const previousHome = process.env.NORTHKEEP_HOME;
const previousNoKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;

async function post(route: string, json: unknown) {
  return handleApi(session, 'POST', route, new URLSearchParams(), Buffer.from(JSON.stringify(json)));
}

beforeEach(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-ui-test-project-working-'));
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

describe('POST /api/memories into a project scope', () => {
  it('refuses a working memory and leaves the project titled', async () => {
    let revision = '';
    let noteId = '';
    let detailId = '';
    await session.withVault((vault) => {
      const created = vault.updateProject({
        project: 'lantern',
        expected_revision: null,
        title: 'Lantern Gazette',
        status: 'Printing.',
        next_actions: '- [ ] Fold',
      }, { actor: 'owner' });
      revision = created.revision;
      noteId = vault.remember({
        content: 'This week I am on the pear festival.',
        type: 'working',
        scope: 'personal',
      }).id;
      detailId = vault.remember({
        content: 'The notice ran on page two.',
        type: 'episodic',
        scope: 'project:lantern',
      }).id;
      vault.save();
    });

    const refused = await post('/api/memories', {
      content: 'Another working note in the project.',
      type: 'working',
      scope: 'project:lantern',
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toContain('conflict with no title');

    const kept = await post('/api/memories', {
      content: 'The press closes at dusk.',
      type: 'semantic',
      scope: 'project:lantern',
    });
    expect(kept.status).toBe(200);

    const moved = await post('/api/memories/rescope', { id: noteId, scope: 'project:lantern' });
    expect(moved.status).toBe(400);
    expect((moved.body as { error: string }).error).toContain('conflict with no title');

    const retyped = await post('/api/memories/edit', { id: detailId, type: 'working' });
    expect(retyped.status).toBe(400);

    const edited = await post('/api/memories/edit', {
      id: revision,
      content: '# Lantern Gazette\n\n## Current Status\n\nStill printing.',
    });
    expect(edited.status).toBe(200);

    await session.withVault((vault) => {
      expect(listProjectOverview(vault)).toEqual([
        expect.objectContaining({ project: 'lantern', title: 'Lantern Gazette', conflict: false }),
      ]);
    });
  });
});
