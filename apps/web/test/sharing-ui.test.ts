import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  if (functionStart < 0) throw new Error(`Missing function ${name}`);
  const start = script.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

type Node = { value: string; textContent: string; hidden: boolean; disabled: boolean };

async function syncButtonAfterLoad(status: Record<string, unknown>): Promise<boolean> {
  const nodes = new Map<string, Node>();
  const $ = (id: string): Node => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false, disabled: false });
    return nodes.get(id)!;
  };
  const context = vm.createContext({ $, status });
  vm.runInContext(`
    const DEFAULT_CONNECTOR_SERVER = 'https://connector.example';
    const api = async () => status;
    const el = () => ({});
    const renderShareScopes = () => {};
    ${functionSource('loadSharing')}
    this.load = loadSharing;
  `, context);
  await context.load();
  return $('shareSyncBtn').disabled;
}

describe('Sharing: Sync now button (ADR 0050 Decision 5)', () => {
  const base = { configured: true, server: 'https://connector.example', unlocked: true, vault_scopes: [], counts: {} };

  it('stays disabled with nothing shared on a device that never paired', async () => {
    expect(await syncButtonAfterLoad({ ...base, shared_scopes: [], paired: false })).toBe(true);
  });

  it('is enabled with nothing shared once the device has paired, so a hosted project can arrive', async () => {
    expect(await syncButtonAfterLoad({ ...base, shared_scopes: [], paired: true })).toBe(false);
  });

  it('is enabled when a scope is shared', async () => {
    expect(await syncButtonAfterLoad({ ...base, shared_scopes: ['work'], paired: false })).toBe(false);
  });

  it('is disabled with no connector server even when paired', async () => {
    expect(await syncButtonAfterLoad({ ...base, configured: false, server: null, shared_scopes: [], paired: true })).toBe(true);
  });

  it('refreshes sharing state after pairing so the button enables without a reload', async () => {
    const binding = script.match(/\$\('sharePairBtn'\)\.addEventListener\('click',[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(binding).not.toBe('');
    const nodes = new Map<string, Record<string, unknown>>();
    const listeners = new Map<string, () => Promise<void>>();
    const $ = (id: string) => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          value: '', textContent: '', hidden: false, disabled: false, style: {},
          addEventListener: (_: string, fn: () => Promise<void>) => { listeners.set(id, fn); },
        });
      }
      return nodes.get(id)!;
    };
    let paired = false;
    const api = async (route: string) => {
      if (route === '/api/share/pair') { paired = true; return { code: 'ABCD-1234', mcp_url: 'https://c.example/mcp', expires_in_seconds: 600 }; }
      return { ...base, shared_scopes: [], paired };
    };
    const context = vm.createContext({ $, api });
    vm.runInContext(`
      const DEFAULT_CONNECTOR_SERVER = 'https://connector.example';
      const el = () => ({});
      const renderShareScopes = () => {};
      const startPairCountdown = () => {};
      ${functionSource('loadSharing')}
      ${binding}
      this.load = loadSharing;
    `, context);
    await context.load();
    expect($('shareSyncBtn').disabled).toBe(true);
    await listeners.get('sharePairBtn')!();
    expect($('shareSyncBtn').disabled).toBe(false);
  });

  it('tells the user when a sync marked a newly arrived project Shared', () => {
    const context = vm.createContext({});
    vm.runInContext(`${functionSource('plural')}\n${functionSource('shareSyncMessages')}`, context);
    const lines = vm.runInContext(`shareSyncMessages({ added: 1, forgotten: 0, deduped: 0, pushed: 1, held_messages: [], newly_shared: ['project:hosted-thing'] })`, context) as string[];
    expect(lines).toEqual([
      'Done. Added 1 new item. Sent 1 memory to Cloud Connect.',
      '"project:hosted-thing" came from a connected app and is now marked Shared. Later edits to it are pushed; unshare it above to stop.',
    ]);
  });
});

describe('Sync now preview (ADR 0063 D3)', () => {
  function syncRun(preview: Record<string, unknown>) {
    const calls: Array<{ route: string; json: unknown }> = [];
    const opened: unknown[] = [];
    const nodes = new Map<string, Record<string, unknown>>();
    const $ = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true, disabled: false, style: {}, replaceChildren() {}, appendChild() {} });
      return nodes.get(id)!;
    };
    const api = async (route: string, opts: { json?: Record<string, unknown> } = {}) => {
      calls.push({ route, json: opts.json });
      if (opts.json && opts.json.dry_run === false) return { added: 0, replaced: 0, forgotten: 0, pushed: 0, conflicts: [] };
      return preview;
    };
    const context = vm.createContext({ $, api, calls, opened, document: { createTextNode: (t: string) => t } });
    vm.runInContext(`
      const loadSharing = async () => {};
      const noteProjectDecisions = () => {};
      const openSyncPreview = (plan) => opened.push(plan);
      const el = () => ({ style: {}, appendChild() {}, addEventListener() {} });
      ${functionSource('plural')}
      ${functionSource('shareSyncMessages')}
      ${functionSource('showShareSyncResult')}
      ${functionSource('applyShareSync')}
      ${functionSource('runShareSync')}
      this.run = runShareSync;
    `, context);
    return { run: (context as { run: () => Promise<void> }).run, calls, opened };
  }

  it('applies a purely additive sync straight away with an empty approval', async () => {
    const { run, calls, opened } = syncRun({ preview: true, needs_confirmation: false, additions: { count: 2, by_scope: { notes: 2 } }, conflicts: [] });
    await run();
    expect(opened).toEqual([]);
    expect(calls).toEqual([
      { route: '/api/share/sync', json: {} },
      { route: '/api/share/sync', json: { dry_run: false, approve: { server_ids: [], forget_ids: [] } } },
    ]);
  });

  it('opens the preview and changes nothing when a sync would update a project or remove a memory', async () => {
    const plan = { preview: true, needs_confirmation: true, additions: { count: 0, by_scope: {} }, replacements: [{ project: 'demo', server_id: 's1' }], conflicts: [] };
    const { run, calls, opened } = syncRun(plan);
    await run();
    expect(calls).toEqual([{ route: '/api/share/sync', json: {} }]);
    expect(opened).toEqual([plan]);
  });

  it('counts every addition plus only the checked updates and removals', () => {
    const context = vm.createContext({});
    vm.runInContext(functionSource('syncApplyCount'), context);
    const count = vm.runInContext(`syncApplyCount({ additions: { count: 3 }, new_projects: ['trail-maps'] }, { server_ids: ['s1'], forget_ids: ['e1', 'e2'] })`, context);
    expect(count).toBe(7);
  });

  it('sends the approval the dialog built, and never the CLI review text', () => {
    expect(functionSource('openSyncPreview')).toContain("server_ids: updates.filter((u) => u.box.checked).map((u) => u.id), forget_ids: removes.filter((r) => r.box.checked).map((r) => r.id)");
    expect(script).not.toContain('r.review_messages');
    expect(functionSource('openSyncPreview')).toContain("cancel.dataset.autofocus = ''");
  });
});
