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
});
