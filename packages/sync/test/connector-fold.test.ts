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
import { downSyncConnector, holdMessage, pushSharedScopes } from '../src/connector-client.js';

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
    // ADR 0050 holds hosted rows for an UNSHARED project scope, so the M14
    // supersede path is only reachable in a scope the user shared.
    vault.setScopeShared('project:northkeep', true);
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

  it('bounds project history: twenty folds leave five superseded revisions with content', async () => {
    const vault = makeVault();
    vault.remember({ content: projectMarkdown('Fold 0.'), type: 'working', scope: 'project:northkeep' });
    vault.setScopeShared('project:northkeep', true);
    for (let i = 1; i <= 20; i += 1) {
      stubPending([
        { server_id: `conn_bound${i}`, scope: 'project:northkeep', type: 'working', content: projectMarkdown(`Fold ${i}.`) },
      ]);
      await downSyncConnector({ server: 'http://127.0.0.1:9', deviceSecret, vault });
    }
    const history = vault.list({ scope: 'project:northkeep', type: 'working', includeSuperseded: true });
    expect(history.filter((e) => e.superseded_at !== null && e.content.length > 0)).toHaveLength(5);
    expect(vault.lastAutoCompaction()).toEqual({ project: 'northkeep', blanked: 1, bytes_freed: expect.any(Number) });
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('dedupes identical content without a second write', async () => {
    const vault = makeVault();
    const same = projectMarkdown('Already here.');
    vault.remember({ content: same, type: 'working', scope: 'project:northkeep' });
    vault.setScopeShared('project:northkeep', true);
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

/**
 * ADR 0050 Decision 4 fold. Every test here distinguishes three outcomes:
 * applied (a live vault entry), marked (the scope in sharedScopes()), and
 * acked (the server_id in the ack body). A held row is none of the three.
 */

interface PendingRow {
  server_id: string;
  scope: string;
  type: string;
  content: string;
}

interface FoldStub {
  /** Bodies of every POST /client/ack, in order. */
  acks: Array<{ acked: Array<{ server_id: string; local_entry_id: string }>; forgets: string[] }>;
  /** Bodies of every PUT /client/entries, raw. */
  pushes: string[];
}

function stubServer(opts: {
  entries: PendingRow[];
  forgets?: Array<{ entry_id: string }>;
  /** Fail the first ack with a 500, so the caller sees a post-save fault. */
  failFirstAck?: boolean;
}): FoldStub {
  const stub: FoldStub = { acks: [], pushes: [] };
  let ackCalls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/client/pending')) {
      return new Response(JSON.stringify({ entries: opts.entries, forgets: opts.forgets ?? [] }), { status: 200 });
    }
    if (url.endsWith('/client/ack')) {
      ackCalls++;
      if (opts.failFirstAck && ackCalls === 1) return new Response('{}', { status: 500 });
      const body = JSON.parse(String(init?.body ?? '{}')) as FoldStub['acks'][number];
      stub.acks.push({ acked: body.acked ?? [], forgets: body.forgets ?? [] });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith('/client/entries')) {
      stub.pushes.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return stub;
}

function fold(vault: Vault) {
  return downSyncConnector({ server: 'http://127.0.0.1:9', deviceSecret, vault });
}

function ackedIds(stub: FoldStub): string[] {
  return stub.acks.flatMap((a) => a.acked.map((row) => row.server_id));
}

describe('downSyncConnector hosted create fold (ADR 0050 Decision 4)', () => {
  it('marks and applies an empty project scope that receives one working row', async () => {
    const vault = makeVault();
    const doc = projectMarkdown('Created in the app.');
    const stub = stubServer({
      entries: [{ server_id: 'conn_c1', scope: 'project:hosted', type: 'working', content: doc }],
    });

    const result = await fold(vault);

    expect(result.added).toBe(1);
    expect(result.held).toBe(0);
    expect(result.held_scopes).toEqual([]);
    expect(vault.sharedScopes()).toEqual(['project:hosted']);
    const live = vault.list({ scope: 'project:hosted', type: 'working' });
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toContain('Created in the app.');
    expect(ackedIds(stub)).toEqual(['conn_c1']);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('applies the document and its episodic archives together, then marks once', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [
        { server_id: 'conn_doc', scope: 'project:rolled', type: 'working', content: projectMarkdown('Rolled.') },
        { server_id: 'conn_arc', scope: 'project:rolled', type: 'episodic', content: 'Archived log entries.' },
      ],
    });

    const result = await fold(vault);

    expect(result.added).toBe(2);
    expect(result.held).toBe(0);
    expect(vault.sharedScopes()).toEqual(['project:rolled']);
    expect(vault.list({ scope: 'project:rolled' })).toHaveLength(2);
    expect(ackedIds(stub).sort()).toEqual(['conn_arc', 'conn_doc']);
    vault.close();
  });

  it.each([
    ['an ordinary local memory', undefined],
    ['a memory whose source forges the connector prefix', 'connector:forged'],
  ])('holds when the scope already holds %s, and the next push carries no canary', async (_label, source) => {
    const vault = makeVault();
    const canary = 'CANARY-private-note-do-not-leave-this-device';
    vault.remember({ content: canary, type: 'episodic', scope: 'project:northkeep', source });
    const stub = stubServer({
      entries: [{ server_id: 'conn_hold', scope: 'project:northkeep', type: 'working', content: projectMarkdown('App doc.') }],
    });

    const result = await fold(vault);

    expect(result.held).toBe(1);
    expect(result.held_scopes).toEqual(['project:northkeep']);
    expect(result.added).toBe(0);
    expect(result.deduped).toBe(0);
    // Not applied: the scope still holds only the local memory.
    expect(vault.list({ scope: 'project:northkeep' })).toHaveLength(1);
    expect(vault.list({ scope: 'project:northkeep', type: 'working' })).toHaveLength(0);
    // Not marked, and not acked, so the server keeps offering the row.
    expect(vault.sharedScopes()).toEqual([]);
    expect(ackedIds(stub)).toEqual([]);

    await pushSharedScopes({
      server: 'http://127.0.0.1:9',
      deviceSecret,
      scopes: vault.sharedScopes(),
      vault,
    });
    expect(stub.pushes).toHaveLength(1);
    expect(stub.pushes[0]).not.toContain(canary);
    vault.close();
  });

  it('holds every row when an empty scope receives two working rows', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [
        { server_id: 'conn_a', scope: 'project:race', type: 'working', content: projectMarkdown('First.') },
        { server_id: 'conn_b', scope: 'project:race', type: 'working', content: projectMarkdown('Second.') },
      ],
    });

    const result = await fold(vault);

    expect(result.held).toBe(2);
    expect(result.held_scopes).toEqual(['project:race']);
    expect(result.added).toBe(0);
    expect(vault.list({ scope: 'project:race' })).toHaveLength(0);
    expect(vault.sharedScopes()).toEqual([]);
    expect(ackedIds(stub)).toEqual([]);
    vault.close();
  });

  it('holds a lone episodic row into an empty project scope', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [{ server_id: 'conn_lone', scope: 'project:lone', type: 'episodic', content: 'An archive with no document.' }],
    });

    const result = await fold(vault);

    expect(result.held).toBe(1);
    expect(result.held_scopes).toEqual(['project:lone']);
    expect(result.added).toBe(0);
    expect(vault.list({ scope: 'project:lone' })).toHaveLength(0);
    expect(vault.sharedScopes()).toEqual([]);
    expect(ackedIds(stub)).toEqual([]);
    vault.close();
  });

  it('holds a scope the user emptied by unsharing while it still holds entries', async () => {
    const vault = makeVault();
    vault.remember({ content: projectMarkdown('Local doc.'), type: 'working', scope: 'project:unshared' });
    vault.setScopeShared('project:unshared', true);
    vault.setScopeShared('project:unshared', false);
    const stub = stubServer({
      entries: [{ server_id: 'conn_back', scope: 'project:unshared', type: 'working', content: projectMarkdown('App doc.') }],
    });

    const result = await fold(vault);

    expect(result.held).toBe(1);
    expect(result.held_scopes).toEqual(['project:unshared']);
    expect(vault.sharedScopes()).toEqual([]);
    const live = vault.list({ scope: 'project:unshared', type: 'working' });
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toContain('Local doc.');
    expect(ackedIds(stub)).toEqual([]);
    vault.close();
  });

  it('never marks for a non-project scope', async () => {
    const vault = makeVault();
    const stub = stubServer({ entries: [{ server_id: 'conn_np', scope: 'work', type: 'working', content: 'A work doc.' }] });

    const result = await fold(vault);

    expect(result.added).toBe(1);
    expect(result.held).toBe(0);
    expect(result.held_scopes).toEqual([]);
    expect(vault.sharedScopes()).toEqual([]);
    expect(ackedIds(stub)).toEqual(['conn_np']);
    vault.close();
  });

  it('never marks for a semantic row in an unshared project scope, and holds it', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [{ server_id: 'conn_sem', scope: 'project:notes', type: 'semantic', content: 'Not a document.' }],
    });

    const result = await fold(vault);

    expect(result.held).toBe(1);
    expect(result.held_scopes).toEqual(['project:notes']);
    expect(result.added).toBe(0);
    expect(vault.sharedScopes()).toEqual([]);
    expect(vault.list({ scope: 'project:notes' })).toHaveLength(0);
    expect(ackedIds(stub)).toEqual([]);
    vault.close();
  });

  it('leaves an already-shared scope on the M14 path with its shared_at intact', async () => {
    const vault = makeVault();
    vault.remember({ content: projectMarkdown('Local status.'), type: 'working', scope: 'project:shared' });
    vault.setScopeShared('project:shared', true);
    const before = vault.sharedScopeRows().find((r) => r.scope === 'project:shared')!.shared_at;
    const stub = stubServer({
      entries: [{ server_id: 'conn_m14', scope: 'project:shared', type: 'working', content: projectMarkdown('Cloud status.') }],
    });

    const result = await fold(vault);

    expect(result.held).toBe(0);
    expect(result.held_scopes).toEqual([]);
    expect(result.added).toBe(1);
    const live = vault.list({ scope: 'project:shared', type: 'working' });
    expect(live).toHaveLength(1);
    expect(live[0]!.content).toContain('Cloud status.');
    expect(vault.sharedScopeRows().find((r) => r.scope === 'project:shared')!.shared_at).toBe(before);
    expect(ackedIds(stub)).toEqual(['conn_m14']);
    vault.close();
  });

  it('keeps the mark when the ack fails after the save, and the retry dedupes', async () => {
    const vaultPath = path.join(home, 'vault.nkv');
    const vault = makeVault();
    const doc = projectMarkdown('Survives the fault.');
    stubServer({
      entries: [{ server_id: 'conn_fault', scope: 'project:fault', type: 'working', content: doc }],
      failFirstAck: true,
    });

    await expect(fold(vault)).rejects.toThrow(/HTTP 500/);
    vault.close();

    // Reopened from disk: the mark and the document were in the save that ran
    // before the ack, so the fault cannot have lost them.
    const reopened = Vault.open({
      path: vaultPath,
      passphrase: 'test passphrase',
      deviceSecret,
      kdf: KDF_INTERACTIVE,
    });
    expect(reopened.sharedScopes()).toEqual(['project:fault']);
    expect(reopened.list({ scope: 'project:fault', type: 'working' })).toHaveLength(1);

    const retry = stubServer({
      entries: [{ server_id: 'conn_fault', scope: 'project:fault', type: 'working', content: doc }],
    });
    const result = await fold(reopened);
    expect(result.deduped).toBe(1);
    expect(result.added).toBe(0);
    expect(result.held).toBe(0);
    expect(reopened.list({ scope: 'project:fault', type: 'working' })).toHaveLength(1);
    expect(ackedIds(retry)).toEqual(['conn_fault']);
    reopened.close();
  });

  it('acks other scopes and forgets while a held scope stays pending', async () => {
    const vault = makeVault();
    vault.remember({ content: 'Local project note.', type: 'episodic', scope: 'project:held' });
    const doomed = vault.remember({ content: 'Forget me.', type: 'semantic', scope: 'work' });
    const stub = stubServer({
      entries: [
        { server_id: 'conn_held', scope: 'project:held', type: 'working', content: projectMarkdown('Held doc.') },
        { server_id: 'conn_ok', scope: 'work', type: 'semantic', content: 'An accepted note.' },
      ],
      forgets: [{ entry_id: doomed.id }],
    });

    const result = await fold(vault);

    expect(result.held).toBe(1);
    expect(result.held_scopes).toEqual(['project:held']);
    expect(result.added).toBe(1);
    expect(result.forgotten).toBe(1);
    expect(ackedIds(stub)).toEqual(['conn_ok']);
    expect(stub.acks[0]!.forgets).toEqual([doomed.id]);
    vault.close();
  });
});

describe('holdMessage', () => {
  it('is the exact sentence every sync surface shows', () => {
    expect(holdMessage('northkeep')).toBe(
      'A connected app wrote to project northkeep, which is private on this device. ' +
        'Share project:northkeep in NorthKeep to accept it. ' +
        "Sharing it lets the app's document replace the one on this device; the current one stays in history.",
    );
  });
});

/**
 * ADR 0050 fix round, item 2. The fold is the enforcement point: a hostile or
 * buggy server may pad a scope or invent a type, and neither may reach past
 * the hold or abort the fold.
 */
describe('downSyncConnector scope and type normalisation (ADR 0050 fix round)', () => {
  it.each([[' project:plan'], ['project:plan '], ['project:plan\n'], ['\tproject:plan']])(
    'holds a padded scope %j instead of landing a second document in a private project',
    async (paddedScope) => {
      const vault = makeVault();
      vault.remember({ content: projectMarkdown('Local doc.'), type: 'working', scope: 'project:plan' });
      const stub = stubServer({
        entries: [{ server_id: 'conn_pad', scope: paddedScope, type: 'working', content: projectMarkdown('App doc.') }],
      });

      const result = await fold(vault);

      expect(result.held).toBe(1);
      expect(result.held_scopes).toEqual(['project:plan']);
      expect(result.added).toBe(0);
      expect(result.deduped).toBe(0);
      expect(result.skipped).toBe(0);
      expect(vault.sharedScopes()).toEqual([]);
      expect(ackedIds(stub)).toEqual([]);
      const live = vault.list({ scope: 'project:plan', type: 'working' });
      expect(live).toHaveLength(1);
      expect(live[0]!.content).toContain('Local doc.');
      expect(vault.list({ scope: 'project:plan' })).toHaveLength(1);
      vault.close();
    },
  );

  it('applies and marks a padded scope under its trimmed name when the project is empty', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [{ server_id: 'conn_padnew', scope: ' project:new', type: 'working', content: projectMarkdown('Created in the app.') }],
    });

    const result = await fold(vault);

    expect(result.added).toBe(1);
    expect(result.held).toBe(0);
    expect(result.skipped).toBe(0);
    expect(vault.sharedScopes()).toEqual(['project:new']);
    const live = vault.list({ scope: 'project:new', type: 'working' });
    expect(live).toHaveLength(1);
    expect(live[0]!.scope).toBe('project:new');
    expect(ackedIds(stub)).toEqual(['conn_padnew']);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('holds a group whose second row has an invalid type, without throwing', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [
        { server_id: 'conn_good', scope: 'project:mixed', type: 'working', content: projectMarkdown('App doc.') },
        { server_id: 'conn_bad', scope: 'project:mixed', type: ' working', content: 'Padded type.' },
      ],
    });

    const result = await fold(vault);

    expect(result.held).toBe(2);
    expect(result.held_scopes).toEqual(['project:mixed']);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(vault.list({ scope: 'project:mixed' })).toHaveLength(0);
    expect(vault.sharedScopes()).toEqual([]);
    expect(ackedIds(stub)).toEqual([]);
    vault.close();
  });

  it('drops a blank-scope row without acking it, and applies the row beside it', async () => {
    const vault = makeVault();
    const stub = stubServer({
      entries: [
        { server_id: 'conn_blank', scope: '   ', type: 'semantic', content: 'No scope at all.' },
        { server_id: 'conn_scoped', scope: 'work', type: 'semantic', content: 'A real note.' },
      ],
    });

    const result = await fold(vault);

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.held).toBe(0);
    expect(ackedIds(stub)).toEqual(['conn_scoped']);
    expect(vault.list().some((e) => e.content === 'No scope at all.')).toBe(false);
    vault.close();
  });

  it('skips an invalid-type row in a shared non-project scope and applies the rest', async () => {
    const vault = makeVault();
    vault.remember({ content: 'Existing work note.', type: 'semantic', scope: 'work' });
    vault.setScopeShared('work', true);
    const stub = stubServer({
      entries: [
        { server_id: 'conn_badtype', scope: 'work', type: ' working', content: 'Padded type.' },
        { server_id: 'conn_okrow', scope: 'work', type: 'semantic', content: 'An accepted note.' },
      ],
    });

    const result = await fold(vault);

    expect(result.skipped).toBe(1);
    expect(result.added).toBe(1);
    expect(result.held).toBe(0);
    expect(ackedIds(stub)).toEqual(['conn_okrow']);
    const live = vault.list({ scope: 'work' });
    expect(live).toHaveLength(2);
    expect(live.some((e) => e.content === 'Padded type.')).toBe(false);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });
});
