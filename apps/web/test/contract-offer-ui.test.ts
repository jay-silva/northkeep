import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  if (functionStart < 0) throw new Error(`Missing function ${name}`);
  const start = script.slice(functionStart - 6, functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function declaration(pattern: RegExp) {
  const found = script.match(pattern)?.[0];
  if (!found) throw new Error(`Missing declaration ${pattern}`);
  return found;
}

type Target = { id: string; label: string; status: string; detected?: boolean; connected?: boolean };
type FakeNode = {
  tag: string; className: string; id: string; type: string; hidden: boolean; disabled: boolean;
  textContent: string; innerHTML: string; children: FakeNode[]; attrs: Record<string, string>;
  listeners: Record<string, () => unknown>; focused: boolean; style: Record<string, string>;
  append(...nodes: FakeNode[]): void; appendChild(node: FakeNode): FakeNode; replaceChildren(...nodes: FakeNode[]): void;
  insertBefore(node: FakeNode, ref: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void; addEventListener(event: string, fn: () => unknown): void; focus(): void;
};

function fakeNode(tag: string): FakeNode {
  const node: FakeNode = {
    tag, className: '', id: '', type: '', hidden: false, disabled: false, innerHTML: '', children: [], attrs: {},
    listeners: {}, focused: false, style: {},
    get textContent() { return this.children.length ? this.children.map((c: FakeNode) => c.textContent).join('') : this._text; },
    set textContent(value: string) { this.children = []; this._text = String(value); },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, ref) { this.children.splice(this.children.indexOf(ref), 0, child); return child; },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(event, fn) { this.listeners[event] = fn; },
    focus() { this.focused = true; },
  } as FakeNode & { _text: string };
  (node as FakeNode & { _text: string })._text = '';
  return node;
}

function all(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(all)];
}
const buttons = (node: FakeNode) => all(node).filter((n) => n.tag === 'button');
const button = (node: FakeNode, text: string) => {
  const found = buttons(node).find((b) => b.textContent === text);
  if (!found) throw new Error(`No button "${text}" in [${buttons(node).map((b) => b.textContent).join(', ')}]`);
  return found;
};
const byClass = (node: FakeNode, cls: string) => all(node).filter((n) => n.className.split(' ').includes(cls));

type InstallReply = Record<string, unknown> | Error;

function optionalFunction(name: string) {
  return script.includes(`function ${name}(`) ? functionSource(name) : '';
}

type Api = (route: string, init?: { method?: string }) => Promise<unknown>;

function harness(targets: Target[], opts: { stored?: Record<string, string>; storageThrows?: boolean; replies?: Record<string, InstallReply[]>; only?: 'connect'; api?: Api } = {}) {
  const nodes = new Map<string, FakeNode>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, fakeNode('section')); return nodes.get(id)!; };
  const stored: Record<string, string> = { ...(opts.stored ?? {}) };
  const posts: string[] = [];
  const replies = opts.replies ?? {};
  const localStorage = {
    getItem(key: string) { if (opts.storageThrows) throw new Error('denied'); return key in stored ? stored[key] : null; },
    setItem(key: string, value: string) { if (opts.storageThrows) throw new Error('denied'); stored[key] = value; },
  };
  const shown: string[] = [];
  const showTop = (view: string) => { shown.push(view); };
  const fakeApi = async (route: string, init?: { method?: string }) => {
    if (route === '/api/contract') return { contract_text: 'CONTRACT', targets };
    if (route === '/api/connect') {
      const byId = (id: string) => targets.find((t) => t.id === id)?.connected;
      return { targets: [{ id: 'claude-code', connected: byId('claude') }, { id: 'chatgpt', connected: byId('codex') }] };
    }
    if (init?.method === 'POST') {
      posts.push(route);
      const id = route.split('/').pop()!;
      const reply = replies[id]?.shift() ?? { target: id, path: '/p/' + id };
      if (reply instanceof Error) throw reply;
      if (route.includes('/install/')) {
        const target = targets.find((t) => t.id === id);
        if (target) target.status = 'installed';
      }
      return reply;
    }
    throw new Error('unexpected route ' + route);
  };
  const document = { createElement: fakeNode, createTextNode: (text: string) => Object.assign(fakeNode('#text'), { textContent: text }) };
  const api = opts.api ?? fakeApi;
  const context = vm.createContext({ $, api, showTop, localStorage, document, copyToClipboard: () => {} });
  const offer = opts.only === 'connect' ? '' : `
    ${declaration(/const CONTRACT_OFFER_KEYS = \{[^}]*\};/)}
    ${declaration(/let contractOfferBusy = false;/)}
    ${functionSource('contractOfferPlan')}
    ${functionSource('contractOfferDismissed')}
    ${functionSource('contractOfferItem')}
    ${optionalFunction('contractErrorText')}
    ${optionalFunction('contractConnectLine')}
    ${optionalFunction('openConnectDesktop')}
    ${functionSource('renderContractOffer')}
    this.renderContractOffer = renderContractOffer;
    this.contractOfferPlan = contractOfferPlan;
  `;
  vm.runInContext(`
    ${functionSource('el')}
    ${optionalFunction('contractBackupLine')}
    ${functionSource('loadContract')}
    this.loadContract = loadContract;
    ${offer}
  `, context);
  return {
    box: $('contractOffer'), card: $('contractCard'), heading: $('projectsHeading'), node: $, posts, stored, shown,
    render: () => context.renderContractOffer() as Promise<void>,
    loadContract: () => context.loadContract() as Promise<void>,
    plan: (list: Target[], dismissed: Record<string, boolean>) => context.contractOfferPlan(list, dismissed),
  };
}

const claude = (status: string): Target => ({ id: 'claude', label: 'Claude Code', status });
const codex = (status: string): Target => ({ id: 'codex', label: 'Codex', status });
const click = async (node: FakeNode) => { await node.listeners.click(); };

describe('contract offer on Projects', () => {
  it('offers to install for both targets when neither has the contract', async () => {
    const h = harness([claude('absent'), codex('absent')]);
    await h.render();
    expect(h.box.hidden).toBe(false);
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Let Claude Code and Codex keep your projects current');
    expect(buttons(h.box).map((b) => b.textContent)).toEqual(['Install for Claude Code and Codex', 'Not now']);
  });

  it('shows no card when both targets are current', async () => {
    const h = harness([claude('installed'), codex('installed')]);
    await h.render();
    expect(h.box.hidden).toBe(true);
    expect(buttons(h.box)).toEqual([]);
  });

  it('offers only the missing target when the other is installed', async () => {
    const h = harness([claude('installed'), codex('absent')]);
    await h.render();
    expect(buttons(h.box).map((b) => b.textContent)).toEqual(['Install for Codex', 'Not now']);
  });

  it('names only Codex in the headline and lead when only Codex is offered', async () => {
    const h = harness([claude('installed'), codex('absent')]);
    await h.render();
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Let Codex keep your projects current');
    expect(byClass(h.box, 'lead')[0].textContent).toBe('The session contract tells Codex to resume the project at the start of a session, save a checkpoint partway, and wrap up at the end.');
  });

  it('names only Claude Code in the headline and lead when only Claude Code is offered', async () => {
    const h = harness([claude('absent'), codex('installed')]);
    await h.render();
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Let Claude Code keep your projects current');
    expect(byClass(h.box, 'lead')[0].textContent).toBe('The session contract tells Claude Code to resume the project at the start of a session, save a checkpoint partway, and wrap up at the end.');
  });

  it('shows no card for a contract the user edited', async () => {
    const h = harness([claude('edited'), codex('installed')]);
    await h.render();
    expect(h.box.hidden).toBe(true);
    expect(buttons(h.box)).toEqual([]);
  });

  it('offers the update for an earlier release beside an edited target without touching the edited one', async () => {
    const h = harness([claude('edited'), codex('stale')]);
    await h.render();
    expect(byClass(h.box, 'pill').map((p) => p.textContent)).toEqual(['Claude Code: edited by you', 'Codex: out of date']);
    expect(byClass(h.box, 'lead')[0].textContent).toBe('NorthKeep has a newer contract than the one installed. The session contract tells Codex to resume the project at the start of a session, save a checkpoint partway, and wrap up at the end.');
    await click(button(h.box, 'Update for Codex'));
    expect(h.posts).toEqual(['/api/contract/install/codex']);
  });

  it('offers an update naming only the stale target', async () => {
    const h = harness([claude('stale'), codex('installed')]);
    await h.render();
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Your project session contract needs an update');
    expect(byClass(h.box, 'pill').map((p) => p.textContent)).toEqual(['Claude Code: out of date', 'Codex: current']);
    expect(buttons(h.box).map((b) => b.textContent)).toEqual(['Update for Claude Code', 'Not now']);
  });

  it('never offers a blocked target', async () => {
    const blockedOnly = harness([claude('installed'), codex('blocked')]);
    await blockedOnly.render();
    expect(blockedOnly.box.hidden).toBe(true);
    const mixed = harness([claude('absent'), codex('blocked')]);
    await mixed.render();
    expect(buttons(mixed.box).map((b) => b.textContent)).toEqual(['Install for Claude Code', 'Not now']);
  });

  it('updates the stale target alone when the other is still absent', () => {
    const h = harness([]);
    expect(h.plan([claude('stale'), codex('absent')], {})).toEqual({ kind: 'update', needs: [claude('stale')] });
    expect(h.plan([claude('stale'), codex('absent')], { update: true })).toEqual({ kind: 'install', needs: [codex('absent')] });
    expect(h.plan([claude('stale'), codex('absent')], { update: true, install: true })).toBeNull();
  });

  it('installs each target with one POST and shows the confirmation with Done', async () => {
    const h = harness([claude('absent'), codex('absent')]);
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    expect(h.posts).toEqual(['/api/contract/install/claude', '/api/contract/install/codex']);
    expect(h.box.className).toBe('contract-offer done');
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Installed for Claude Code and Codex');
    const done = button(h.box, 'Done');
    expect(done.focused).toBe(true);
    await click(done);
    expect(h.box.hidden).toBe(true);
  });

  it('names the failed target, offers Try again, and retries only that target', async () => {
    const h = harness([claude('absent'), codex('absent')], {
      replies: { codex: [new Error('AGENTS.md has unmatched NorthKeep markers.')] },
    });
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    expect(byClass(h.box, 'err')[0].textContent).toBe('Could not install for Codex. AGENTS.md has unmatched NorthKeep markers.');
    const retry = button(h.box, 'Try again');
    expect(retry.disabled).toBe(false);
    await click(retry);
    expect(h.posts).toEqual(['/api/contract/install/claude', '/api/contract/install/codex', '/api/contract/install/codex']);
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Installed for Claude Code and Codex');
  });

  it('hides the card quietly when the vault locks mid-install', async () => {
    const h = harness([claude('absent'), codex('absent')], { replies: { claude: [new Error('locked')] } });
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    expect(h.box.hidden).toBe(true);
    expect(byClass(h.box, 'err').map((n) => n.textContent)).not.toContain('Could not install for Claude Code. locked');
  });

  it('says where the edited copy was kept when an install makes a backup', async () => {
    const h = harness([claude('stale'), codex('installed')], {
      replies: { claude: [{ target: 'claude', path: '/h/.claude/rules/northkeep-projects.md', replaced: 'edited', backupPath: '/h/.claude/rules/northkeep-projects.md.bak' }] },
    });
    await h.render();
    await click(button(h.box, 'Update for Claude Code'));
    const text = all(h.box).filter((n) => n.tag === 'p').map((n) => n.textContent);
    expect(text).toContain('Claude Code: you had edited the file, so the previous copy was kept at /h/.claude/rules/northkeep-projects.md.bak.');
  });

  it('remembers Not now per variant, so a later stale contract offers an update once', async () => {
    const first = harness([claude('absent'), codex('absent')]);
    await first.render();
    await click(button(first.box, 'Not now'));
    expect(first.box.hidden).toBe(true);
    expect(first.posts).toEqual([]);

    const again = harness([claude('absent'), codex('absent')], { stored: first.stored });
    await again.render();
    expect(again.box.hidden).toBe(true);

    const stale = harness([claude('stale'), codex('stale')], { stored: first.stored });
    await stale.render();
    expect(buttons(stale.box).map((b) => b.textContent)).toEqual(['Update for Claude Code and Codex', 'Not now']);
    await click(button(stale.box, 'Not now'));

    const staleAgain = harness([claude('stale'), codex('stale')], { stored: stale.stored });
    await staleAgain.render();
    expect(staleAgain.box.hidden).toBe(true);
  });

  it('still offers and dismisses when localStorage is unavailable', async () => {
    const h = harness([claude('absent'), codex('absent')], { storageThrows: true });
    await h.render();
    expect(h.box.hidden).toBe(false);
    await click(button(h.box, 'Not now'));
    expect(h.box.hidden).toBe(true);
  });
});

describe('contract offer only for detected apps', () => {
  const noCodex = (status: string): Target => ({ ...codex(status), detected: false });

  it('offers Claude Code alone when Codex is not on this Mac', async () => {
    const h = harness([claude('absent'), noCodex('absent')]);
    await h.render();
    expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Let Claude Code keep your projects current');
    expect(buttons(h.box).map((b) => b.textContent)).toEqual(['Install for Claude Code', 'Not now']);
    await click(button(h.box, 'Install for Claude Code'));
    expect(h.posts).toEqual(['/api/contract/install/claude']);
  });

  it('shows no card when the only target needing the contract is not detected', async () => {
    const h = harness([claude('installed'), noCodex('absent')]);
    await h.render();
    expect(h.box.hidden).toBe(true);
  });

  it('leaves an undetected Codex out of the Reaches row', async () => {
    const reach = async (list: Target[]) => {
      const h = harness(list);
      await h.render();
      return byClass(h.box, 'yes').map((n) => n.textContent);
    };
    expect(await reach([claude('absent'), noCodex('absent')])).toEqual(['Claude Code', 'Cursor per project, from Connect, Desktop']);
    expect(await reach([claude('absent'), codex('absent')])).toEqual(['Claude Code', 'Codex', 'Cursor per project, from Connect, Desktop']);
  });

  it('leaves an undetected app out of the update pills', async () => {
    const h = harness([claude('stale'), noCodex('absent')]);
    await h.render();
    expect(byClass(h.box, 'pill').map((p) => p.textContent)).toEqual(['Claude Code: out of date']);
  });

  it('against the real API in a home without Codex, installs Claude Code only and creates no .codex', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-offer-home-'));
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH, NORTHKEEP_NO_KEYCHAIN: process.env.NORTHKEEP_NO_KEYCHAIN };
    process.env.HOME = home;
    delete process.env.CODEX_HOME;
    process.env.PATH = '/usr/bin:/bin';
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
    try {
      const session = new UiSession(path.join(home, 'vault.nkv'));
      const realApi: Api = async (route, init) => {
        const res = await handleApi(session, init?.method ?? 'GET', route, new URLSearchParams(), Buffer.from('{}'));
        if (res.status !== 200) throw new Error((res.body as { error?: string }).error ?? 'HTTP ' + res.status);
        return res.body;
      };
      const h = harness([], { api: realApi });
      await h.render();
      expect(buttons(h.box).map((b) => b.textContent)).toEqual(['Install for Claude Code', 'Not now']);
      await click(button(h.box, 'Install for Claude Code'));
      expect(all(h.box).find((n) => n.tag === 'h3')?.textContent).toBe('Installed for Claude Code');
      expect(fs.existsSync(path.join(home, '.claude', 'rules', 'northkeep-projects.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);

      fs.rmSync(path.join(home, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(home, '.codex'));
      const both = harness([], { api: realApi });
      await both.render();
      expect(buttons(both.box).map((b) => b.textContent)).toEqual(['Install for Claude Code and Codex', 'Not now']);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('contract offer confirmation and focus', () => {
  it('says an unconnected app still needs connecting and opens Connect, Desktop', async () => {
    const h = harness([{ ...claude('absent'), connected: false }, { ...codex('absent'), connected: true }]);
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    const text = all(h.box).filter((n) => n.tag === 'p').map((n) => n.textContent);
    expect(text).toContain('Claude Code is not connected to NorthKeep yet. The contract is installed, but project tools will not be available until you connect it in Connect, Desktop.');
    const note = all(h.box).find((n) => n.textContent.startsWith('Claude Code is not connected'))!;
    expect(note.attrs.role).toBe('status');
    await click(button(h.box, 'Open Connect, Desktop'));
    expect(h.shown).toEqual(['connect']);
    expect(h.node('connectToggle').attrs['aria-expanded']).toBe('true');
    expect(h.node('connectNavChildren').hidden).toBe(false);
    expect(h.node('connectHeading').focused).toBe(true);
  });

  it('names both apps when neither is connected', async () => {
    const h = harness([{ ...claude('absent'), connected: false }, { ...codex('absent'), connected: false }]);
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    const text = all(h.box).filter((n) => n.tag === 'p').map((n) => n.textContent);
    expect(text).toContain('Claude Code and ChatGPT / Codex are not connected to NorthKeep yet. The contract is installed, but project tools will not be available until you connect them in Connect, Desktop.');
  });

  it('adds no connect line when every installed app is connected', async () => {
    const h = harness([{ ...claude('absent'), connected: true }, { ...codex('absent'), connected: true }]);
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    expect(all(h.box).map((n) => n.textContent).join(' ')).not.toContain('not connected');
    expect(buttons(h.box).map((b) => b.textContent)).toEqual(['Done']);
  });

  it('moves focus to the Projects heading after Not now', async () => {
    const h = harness([claude('absent'), codex('absent')]);
    await h.render();
    await click(button(h.box, 'Not now'));
    expect(h.heading.focused).toBe(true);
  });

  it('moves focus to the Projects heading after Done', async () => {
    const h = harness([claude('absent'), codex('absent')]);
    await h.render();
    await click(button(h.box, 'Install for Claude Code and Codex'));
    await click(button(h.box, 'Done'));
    expect(h.heading.focused).toBe(true);
  });

  it('shows the kind of a filesystem failure without the path', async () => {
    const h = harness([claude('absent'), codex('installed')], {
      replies: { claude: [new Error("EACCES: permission denied, open '/Users/you/.claude/rules/northkeep-projects.md.northkeep-tmp'")] },
    });
    await h.render();
    await click(button(h.box, 'Install for Claude Code'));
    expect(byClass(h.box, 'err')[0].textContent).toBe('Could not install for Claude Code. Permission denied.');
  });

  it('keeps a refusal readable with the file name in place of its path', async () => {
    const h = harness([claude('installed'), codex('absent')], {
      replies: { codex: [new Error('Refusing to modify /Users/you/.codex/AGENTS.md: NorthKeep\'s contract markers are duplicated or unpaired. Fix or remove them, then reinstall.')] },
    });
    await h.render();
    await click(button(h.box, 'Install for Codex'));
    expect(byClass(h.box, 'err')[0].textContent).toBe("Could not install for Codex. Refusing to modify AGENTS.md: NorthKeep's contract markers are duplicated or unpaired. Fix or remove them, then reinstall.");
  });
});

describe('Connect, Desktop contract card', () => {
  it('says where the edited copy was kept after a reinstall makes a backup', async () => {
    const h = harness([claude('stale'), codex('installed')], {
      only: 'connect',
      replies: { claude: [{ target: 'claude', path: '/h/.claude/rules/northkeep-projects.md', replaced: 'edited', backupPath: '/h/.claude/rules/northkeep-projects.md.bak' }] },
    });
    await h.loadContract();
    await click(buttons(h.card).find((b) => b.textContent === 'Install')!);
    const text = all(h.card).filter((n) => n.tag === 'p').map((n) => n.textContent);
    expect(text).toContain('Claude Code: you had edited the file, so the previous copy was kept at /h/.claude/rules/northkeep-projects.md.bak.');
  });

  it('labels an edited target Edited by you and keeps Reinstall and Remove', async () => {
    const h = harness([claude('edited'), codex('installed')], { only: 'connect' });
    await h.loadContract();
    expect(byClass(h.card, 'badge').map((b) => b.textContent)).toEqual(['EDITED BY YOU', 'INSTALLED']);
    const claudeRow = all(h.card).find((n) => n.className === 'row' && n.textContent.startsWith('Claude Code'))!;
    expect(buttons(claudeRow).map((b) => b.textContent)).toEqual(['Reinstall', 'Remove']);
  });

  it('adds no backup line when the install replaced an unedited copy', async () => {
    const h = harness([claude('stale'), codex('installed')], {
      only: 'connect',
      replies: { claude: [{ target: 'claude', path: '/h/.claude/rules/northkeep-projects.md', replaced: 'earlier-release' }] },
    });
    await h.loadContract();
    await click(buttons(h.card).find((b) => b.textContent === 'Install')!);
    const text = all(h.card).filter((n) => n.tag === 'p').map((n) => n.textContent).join(' ');
    expect(text).not.toContain('previous copy was kept');
  });
});

describe('Settings, About support row', () => {
  it('opens the support page through an external anchor the desktop handler routes to the browser', () => {
    const about = html.match(/<section id="view-about"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(about).toContain('<strong>Support NorthKeep</strong>');
    expect(about).toContain('Everything on your Mac is free. If NorthKeep helps you, you can leave a tip.');
    expect(about).toMatch(/<a class="btn-link" href="https:\/\/northkeep\.ai\/support" target="_blank" rel="noopener noreferrer">Open support page/);
    expect(script).toContain("e.target.closest('a[target=\"_blank\"]')");
  });
});
