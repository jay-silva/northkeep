import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  const start = script.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  if (start < 0) throw new Error(`Missing function ${name}`);
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let index = brace; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}' && --depth === 0) return script.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

const actionBinding = script.slice(
  script.indexOf("$('localSearchAction').addEventListener('click'"),
  script.indexOf("$('memList').addEventListener('click'"),
);
const queryBinding = script.slice(
  script.indexOf("$('q').addEventListener('input'"),
  script.indexOf('async function loadMemories()', script.indexOf("$('q').addEventListener('input'")),
);

type HarnessOptions = {
  api: (route: string, options?: { method?: string }) => Promise<unknown>;
  loadMemories?: () => Promise<void>;
  now?: () => number;
};

function harness(options: HarnessOptions) {
  const nodes = new Map<string, Record<string, any>>([
    ['memorySearchStatus', { hidden: true }],
    ['memorySearchTitle', { textContent: '' }],
    ['memorySearchDetail', { textContent: '' }],
    ['localSearchInstall', { hidden: true }],
    ['view-memories', { hidden: false }],
  ]);
  let click: (() => Promise<void>) | undefined;
  let input: (() => void) | undefined;
  nodes.set('localSearchAction', {
    hidden: true,
    disabled: false,
    dataset: { action: '' },
    textContent: '',
    addEventListener: (_event: string, listener: () => Promise<void>) => { click = listener; },
  });
  nodes.set('q', { value: 'dog', addEventListener: (_event: string, listener: () => void) => { input = listener; } });
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const clearTimeout = vi.fn((id: number | null) => { if (id !== null) timers.delete(id); });
  const setTimeout = vi.fn((callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; });
  const loadMemories = vi.fn(options.loadMemories ?? (async () => undefined));
  const context = vm.createContext({
    api: options.api,
    encodeURIComponent,
    Date: { now: options.now ?? (() => 1_000) },
    clearTimeout,
    setTimeout,
    nodes,
    loadMemories,
  });
  vm.runInContext(`
    const $=(id)=>nodes.get(id);
    let status={unlocked:true};
    let searchTimer=null, memoryLoadSequence=0;
    let localSearchEpoch=0, localSearchBusy=false, localSearchPoll=null;
    let localSearchJob=null, localSearchDeadline=0;
    ${functionSource('stopLocalSearchView')}
    ${functionSource('localSearchViewActive')}
    ${functionSource('showLocalSearchState')}
    ${functionSource('renderMemorySearchStatus')}
    ${functionSource('pollSearchModel')}
    ${queryBinding}
    ${actionBinding}
    this.render=renderMemorySearchStatus;
    this.poll=pollSearchModel;
    this.stop=stopLocalSearchView;
    this.lock=()=>{status.unlocked=false;stopLocalSearchView();};
    this.setAction=(action)=>{$('localSearchAction').dataset.action=action;};
    this.setJob=(job,deadline)=>{localSearchJob=job;localSearchDeadline=deadline;localSearchBusy=true;};
    this.state=()=>({epoch:localSearchEpoch,busy:localSearchBusy,job:localSearchJob});
  `, context);
  (context as Record<string, unknown>).click = () => click!();
  (context as Record<string, unknown>).input = () => input!();
  return { context, nodes, timers, clearTimeout, setTimeout, loadMemories };
}

describe('local semantic search controls', () => {
  it('checks status without POSTing merely because keyword fallback rendered', async () => {
    const calls: Array<{ route: string; method?: string }> = [];
    const view = harness({ api: async (route, options) => {
      calls.push({ route, method: options?.method });
      return { runtime: 'stopped', embedding_model: 'missing', can_start: true };
    } });
    await view.context.render({ search_mode: 'keyword', semantic_reason: 'embedder unavailable' }, 'dog');
    expect(calls).toEqual([{ route: '/api/local/search/status', method: undefined }]);
    expect(view.nodes.get('localSearchAction')?.dataset.action).toBe('start');
  });

  it('starts explicitly, reruns the current search, and never pulls automatically', async () => {
    const calls: Array<{ route: string; method?: string }> = [];
    const view = harness({ api: async (route, options) => { calls.push({ route, method: options?.method }); return {}; } });
    view.context.setAction('start');
    await view.context.click();
    expect(calls).toEqual([{ route: '/api/local/search/start', method: 'POST' }]);
    expect(view.loadMemories).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.route.includes('/pull'))).toBe(false);
  });

  it('polls an explicitly requested download to success and then reloads memories', async () => {
    const calls: Array<{ route: string; method?: string }> = [];
    const view = harness({ api: async (route, options) => {
      calls.push({ route, method: options?.method });
      if (route === '/api/local/search/pull') return { job_id: 'job/one' };
      return { done: true };
    } });
    view.context.setAction('pull');
    await view.context.click();
    expect(calls).toEqual([
      { route: '/api/local/search/pull', method: 'POST' },
      { route: '/api/local/search/pull/job%2Fone', method: undefined },
    ]);
    expect(view.loadMemories).toHaveBeenCalledOnce();
    expect(view.context.state().job).toBeNull();
  });

  it('invalidates a late status response when the query changes and cancels polling on lock', async () => {
    let resolveStatus!: (value: unknown) => void;
    const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
    const view = harness({ api: async (route) => route.endsWith('/status') ? pendingStatus : { done: false, completed: 1, total: 2 } });
    const rendering = view.context.render({ search_mode: 'keyword' }, 'dog');
    view.context.input();
    resolveStatus({ runtime: 'stopped', embedding_model: 'missing', can_start: true });
    await rendering;
    expect(view.nodes.get('memorySearchStatus')?.hidden).toBe(true);
    expect(view.nodes.get('localSearchAction')?.dataset.action).toBe('');

    const epoch = view.context.state().epoch;
    view.context.setJob('job', 10_000);
    const timersBeforePoll = view.timers.size;
    await view.context.poll('job', epoch);
    expect(view.timers.size).toBe(timersBeforePoll + 1);
    view.context.lock();
    expect(view.timers.size).toBe(timersBeforePoll);
    expect(view.clearTimeout).toHaveBeenCalled();
  });

  it('ignores a late status response after navigation leaves Memories', async () => {
    let resolveStatus!: (value: unknown) => void;
    const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
    const view = harness({ api: async () => pendingStatus });
    const rendering = view.context.render({ search_mode: 'keyword' }, 'dog');
    view.nodes.get('view-memories')!.hidden = true;
    view.context.stop();
    resolveStatus({ runtime: 'stopped', embedding_model: 'missing', can_start: true });
    await rendering;
    expect(view.nodes.get('localSearchAction')?.dataset.action).toBe('');
  });

  it('coalesces duplicate clicks while an explicit POST is pending', async () => {
    let resolveStart!: (value: unknown) => void;
    const pending = new Promise((resolve) => { resolveStart = resolve; });
    const api = vi.fn(async () => pending);
    const view = harness({ api });
    view.context.setAction('start');
    const first = view.context.click();
    const second = view.context.click();
    expect(api).toHaveBeenCalledOnce();
    resolveStart({});
    await Promise.all([first, second]);
  });

  it('turns status failures into a safe retry without exposing raw errors', async () => {
    const view = harness({ api: async () => { throw new Error('<img src=x onerror=alert(1)>'); } });
    await expect(view.context.render({ search_mode: 'keyword' }, 'dog')).resolves.toBeUndefined();
    expect(view.nodes.get('memorySearchTitle')?.textContent).toBe('Using keyword search');
    expect(view.nodes.get('memorySearchDetail')?.textContent).toBe('Could not check local search. Try again.');
    expect(view.nodes.get('memorySearchDetail')?.textContent).not.toContain('onerror');
    expect(view.nodes.get('localSearchAction')?.dataset.action).toBe('retry');
  });
});
