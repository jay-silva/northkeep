import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret } from '@northkeep/core';
import { planDownSync, type PendingRow } from '../src/connector-client.js';

/**
 * Planning looks waiting rows up in one listing per collection, and plans
 * exactly as the search per row did. Temp home and fictional data only.
 */

const deviceSecret = generateDeviceSecret();
let home = '';
let vault: Vault;
const priorHome = process.env.NORTHKEEP_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-plan-lookup-'));
  process.env.NORTHKEEP_HOME = home;
  vault = Vault.create({ path: path.join(home, 'vault.nkv'), passphrase: 'synthetic passphrase', deviceSecret, kdf: KDF_INTERACTIVE });
});
afterEach(() => {
  vi.restoreAllMocks();
  vault.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const row = (server_id: string, scope: string, content: string): PendingRow => ({ server_id, scope, type: 'semantic', content, base_revision: null, stale: false });

describe('planDownSync text lookup gives the same answers as a search per row', () => {
  it('dedupes to the earliest live copy in the same scope only, and never to a replaced memory', () => {
    const first = vault.remember({ content: 'Same text', type: 'semantic', scope: 'work' });
    vault.remember({ content: 'Same text', type: 'semantic', scope: 'work' });
    const atHome = vault.remember({ content: 'Home text', type: 'semantic', scope: 'home' });
    const old = vault.remember({ content: 'Old wording', type: 'semantic', scope: 'work' });
    const newer = vault.remember({ content: 'New wording', type: 'semantic', scope: 'work' });
    vault.markReplaced(old.id, newer.id);

    const plan = planDownSync({
      vault,
      pending: {
        entries: [row('c1', 'work', 'Same text'), row('c2', 'work', 'Home text'), row('c3', 'work', 'Old wording'), row('c4', 'work', 'Same text'), row('c5', 'home', 'Home text')],
        forgets: [],
        replaces: [],
      },
    });

    expect(plan.dedupes).toEqual([
      { server_id: 'c1', local_entry_id: first.id },
      { server_id: 'c4', local_entry_id: first.id },
      { server_id: 'c5', local_entry_id: atHome.id },
    ]);
    expect(plan.additions.map((a) => [a.server_id, a.scope, a.content])).toEqual([
      ['c2', 'work', 'Home text'],
      ['c3', 'work', 'Old wording'],
    ]);
  });

  it('two waiting rows with the same new text are both additions, as before', () => {
    const plan = planDownSync({ vault, pending: { entries: [row('c1', 'work', 'Twice'), row('c2', 'work', 'Twice')], forgets: [], replaces: [] } });
    expect(plan.additions.map((a) => a.server_id)).toEqual(['c1', 'c2']);
    expect(plan.dedupes).toEqual([]);
  });

  it('lists each collection once for its text lookup, however many rows are waiting', () => {
    vault.remember({ content: 'Row 7', type: 'semantic', scope: 'work' });
    const entries = Array.from({ length: 400 }, (_, i) => row(`c${i}`, i % 2 === 0 ? 'work' : 'home', `Row ${i}`));
    const listed: string[] = [];
    const list = vault.list.bind(vault);
    vi.spyOn(vault, 'list').mockImplementation((filter) => {
      if (filter?.scope !== undefined) listed.push(filter.scope);
      return list(filter);
    });

    const plan = planDownSync({ vault, pending: { entries, forgets: [], replaces: [] } });

    expect(listed.filter((s) => s === 'work').length).toBeLessThanOrEqual(2);
    expect(listed.filter((s) => s === 'home').length).toBeLessThanOrEqual(2);
    expect([plan.additions.length, plan.dedupes.length]).toEqual([400, 0]);
  });
});
