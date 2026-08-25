import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret } from '@northkeep/core';
import {
  emptyProjectDoc,
  mergeProjectDoc,
  serializeProjectDoc,
} from '@northkeep/core/project-doc';
import { downSyncConnector } from '../src/connector-client.js';

let home = '';
const priorHome = process.env.NORTHKEEP_HOME;
const deviceSecret = generateDeviceSecret();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-connfold-'));
  process.env.NORTHKEEP_HOME = home;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function makeVault(): Vault {
  return Vault.create({
    path: path.join(home, 'vault.nkv'),
    passphrase: 'test passphrase',
    deviceSecret,
    kdf: KDF_INTERACTIVE,
  });
}

function projectMarkdown(status: string): string {
  return serializeProjectDoc(
    mergeProjectDoc(emptyProjectDoc(), {
      whatWhy: 'Fold test.',
      status,
      logEntry: 'Seeded.',
    }),
  );
}

function stubPending(entries: Array<{ server_id: string; scope: string; type: string; content: string }>): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/client/pending')) {
        return new Response(JSON.stringify({ entries, forgets: [] }), { status: 200 });
      }
      if (url.endsWith('/client/ack')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          acked?: Array<{ server_id: string; local_entry_id: string }>;
        };
        return new Response(JSON.stringify({ ok: true, acked: body.acked?.length ?? 0 }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );
}

describe('downSyncConnector project fold (M14)', () => {
  it('supersedes the newest live working doc in a slug-valid project scope', async () => {
    const vault = makeVault();
    const local = projectMarkdown('Local status.');
    vault.remember({ content: local, type: 'working', scope: 'project:northkeep' });
    const incoming = projectMarkdown('Cloud status.');
    stubPending([
      { server_id: 'conn_fold1', scope: 'project:northkeep', type: 'working', content: incoming },
    ]);

    const result = await downSyncConnector({
      server: 'http://127.0.0.1:9',
      deviceSecret,
      vault,
    });
    expect(result.added).toBe(1);
    expect(result.deduped).toBe(0);

    const live = vault.list({ scope: 'project:northkeep', type: 'working' });
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toContain('Cloud status.');
    const history = vault.list({ scope: 'project:northkeep', type: 'working', includeSuperseded: true });
    expect(history).toHaveLength(2);
    expect(history.some((e) => e.content.includes('Local status.') && e.superseded_at !== null)).toBe(true);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('dedupes identical content without a second write', async () => {
    const vault = makeVault();
    const same = projectMarkdown('Already here.');
    vault.remember({ content: same, type: 'working', scope: 'project:northkeep' });
    stubPending([
      { server_id: 'conn_dup', scope: 'project:northkeep', type: 'working', content: same },
    ]);

    const result = await downSyncConnector({
      server: 'http://127.0.0.1:9',
      deviceSecret,
      vault,
    });
    expect(result.deduped).toBe(1);
    expect(result.added).toBe(0);
    expect(vault.list({ scope: 'project:northkeep', type: 'working' })).toHaveLength(1);
    vault.close();
  });

  it('remembers when the project scope has no live working doc', async () => {
    const vault = makeVault();
    const incoming = projectMarkdown('First landing.');
    stubPending([
      { server_id: 'conn_new', scope: 'project:fresh', type: 'working', content: incoming },
    ]);

    const result = await downSyncConnector({
      server: 'http://127.0.0.1:9',
      deviceSecret,
      vault,
    });
    expect(result.added).toBe(1);
    const live = vault.list({ scope: 'project:fresh', type: 'working' });
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toContain('First landing.');
    vault.close();
  });

  it('does not treat a prefix-only project: scope as a project fold', async () => {
    const vault = makeVault();
    vault.remember({
      content: projectMarkdown('Local underscore scope.'),
      type: 'working',
      scope: 'project:foo_bar',
    });
    const incoming = projectMarkdown('Should remember, not supersede.');
    stubPending([
      { server_id: 'conn_prefix', scope: 'project:foo_bar', type: 'working', content: incoming },
    ]);

    await downSyncConnector({ server: 'http://127.0.0.1:9', deviceSecret, vault });
    const live = vault.list({ scope: 'project:foo_bar', type: 'working' });
    expect(live).toHaveLength(2);
    expect(live.some((e) => e.content.includes('Local underscore scope.') && e.superseded_at === null)).toBe(true);
    expect(live.some((e) => e.content.includes('Should remember, not supersede.'))).toBe(true);
    vault.close();
  });

  it('leaves ordinary non-project pending entries on the remember path', async () => {
    const vault = makeVault();
    vault.remember({ content: 'Existing work note.', type: 'semantic', scope: 'work' });
    stubPending([{ server_id: 'conn_work', scope: 'work', type: 'semantic', content: 'New work note.' }]);

    const result = await downSyncConnector({
      server: 'http://127.0.0.1:9',
      deviceSecret,
      vault,
    });
    expect(result.added).toBe(1);
    expect(vault.list({ scope: 'work' })).toHaveLength(2);
    expect(vault.list({ scope: 'work' }).every((e) => e.superseded_at === null)).toBe(true);
    vault.close();
  });
});
