import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret } from '@northkeep/core';
import { ConnectorOversizeError, pushSharedScopes } from '../src/connector-client.js';
import { startFakeConnector, type FakeConnector } from './fake-connector.js';

// The connector refuses a whole push over one oversize row and never says
// which. The client must name the memory before anything is sent.

const deviceSecret = generateDeviceSecret();
let home = '';
let fake: FakeConnector;
let vault: Vault;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-oversize-'));
  fake = await startFakeConnector();
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: 'synthetic', deviceSecret, kdf: KDF_INTERACTIVE });
});
afterEach(async () => {
  vault.close();
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const push = () => pushSharedScopes({ server: fake.url(), deviceSecret, scopes: vault.sharedScopes(), vault });

describe('oversize shared memories', () => {
  it('names the scope, date and size of a memory over 8 KB outside a project, and sends nothing', async () => {
    vault.remember({ content: 'secret-ish words '.repeat(530), type: 'episodic', scope: 'conversations' });
    vault.setScopeShared('conversations', true);
    vault.save();
    const err = await push().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorOversizeError);
    const message = (err as Error).message;
    const today = new Date().toISOString().slice(0, 10);
    expect(message).toBe(
      `A shared memory in "conversations", saved ${today}, is 8.8 KB. Shared memories outside a project can be at most 8 KB, ` +
        'so Cloud Connect was sent nothing. Shorten or forget that memory, then try again.',
    );
    expect(message).not.toContain('secret-ish');
    expect(fake.pushes()).toHaveLength(0);
  });

  it('pushes a 15 KB memory inside a project, such as a kept cloud version', async () => {
    vault.updateProject({ project: 'demo', expected_revision: null, what_why: 'Demo.', status: 'Local.' }, { actor: 'owner' });
    vault.remember({ content: '# Cloud version not kept\n\n' + 'x'.repeat(15 * 1024), type: 'episodic', scope: 'project:demo' });
    vault.setScopeShared('project:demo', true);
    vault.save();
    await expect(push()).resolves.toMatchObject({ pushed: 2 });
  });

  it('counts every oversize memory and names the first', async () => {
    vault.remember({ content: 'a'.repeat(9000), type: 'semantic', scope: 'notes' });
    vault.remember({ content: 'b'.repeat(70 * 1024), type: 'episodic', scope: 'project:big' });
    vault.setScopeShared('notes', true);
    vault.setScopeShared('project:big', true);
    vault.save();
    const err = (await push().catch((e: unknown) => e)) as ConnectorOversizeError;
    expect(err.entries.map((e) => e.scope).sort()).toEqual(['notes', 'project:big']);
    expect(err.message).toMatch(/^2 shared memories are too large\. The first in "/);
  });
});
