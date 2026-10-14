import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const at = script.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`Missing function ${name}`);
  const start = script.slice(at - 6, at) === 'async ' ? at - 6 : at;
  let depth = 0;
  for (let i = script.indexOf('{', at); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

interface Node { tag: string; className: string; text: string; children: Node[]; attrs: Record<string, string>; id?: string; type?: string; dataset: Record<string, string>; listeners: Record<string, () => void>; style: Record<string, string> }
function fakeDom() {
  const make = (tag: string, cls?: string, text?: string): Node => {
    const node: Node = { tag, className: cls ?? '', text: text ?? '', children: [], attrs: {}, dataset: {}, listeners: {}, style: {} };
    return Object.assign(node, {
      append: (...kids: Node[]) => { node.children.push(...kids); },
      appendChild: (kid: Node) => { node.children.push(kid); return kid; },
      setAttribute: (k: string, v: string) => { node.attrs[k] = v; },
      addEventListener: (k: string, fn: () => void) => { node.listeners[k] = fn; },
    });
  };
  return { el: make, document: { createTextNode: (t: string) => make('#text', '', t) } };
}
const textOf = (n: Node): string => [n.text, ...n.children.map(textOf)].join('');
const all = (n: Node, pred: (x: Node) => boolean): Node[] => [...(pred(n) ? [n] : []), ...n.children.flatMap((c) => all(c, pred))];

function render(project: unknown): Node {
  const dom = fakeDom();
  const context = vm.createContext({ ...dom, Date, String, Number, Array, openMilestoneRepair: () => {}, confirmMilestone: () => {} });
  vm.runInContext([functionSource('milestoneDay'), functionSource('milestoneWho'), functionSource('renderProjectMilestones')].join('\n'), context);
  return (context.renderProjectMilestones as (p: unknown) => Node)(project);
}

const PLAN = { kind: 'plan', items: [
  { id: 'M1', title: 'Define the buy box', test: 'agreed', state: 'passed', on: '2026-09-28', by: 'you' },
  { id: 'M2', title: 'Shortlist 3 markets', test: 'comps', state: 'passed', on: '2026-10-09', by: 'agent' },
  { id: 'M3', title: 'Underwrite top 5 listings', test: 'each has a pro forma', state: 'open' },
  { id: 'M4', title: 'Financing pre-approval', test: 'letter', state: 'open' },
] };

describe('Milestones block (ADR 0065 Decision 5, desktop)', () => {
  it('keeps the script valid and sits between Current Status and Decisions', () => {
    expect(() => new Function(script)).not.toThrow();
    const detail = functionSource('renderProjectDetail');
    expect(detail.indexOf('renderProjectMilestones(project)')).toBeGreaterThan(detail.indexOf('facts.append(statusBox, next)'));
    expect(detail.indexOf('renderProjectMilestones(project)')).toBeLessThan(detail.indexOf("'Decisions and open questions'"));
  });

  it('shows N of M passed, a solid check for (you), an outlined one for (agent), Confirm and Mark passed', () => {
    const block = render({ project: 'str', revision: 'r', milestones: PLAN });
    expect(textOf(block.children[0]!)).toBe('Milestones2 of 4 passed');
    const rows = all(block, (n) => n.tag === 'li');
    expect(rows.map((r) => r.className)).toEqual(['ms-row done', 'ms-row said', 'ms-row cur', 'ms-row']);
    expect(textOf(rows[0]!)).toBe('✓M1 Define the buy boxPassed Sep 28 · you confirmed');
    expect(textOf(rows[1]!)).toBe('✓M2 Shortlist 3 marketsPassed Oct 9 · agent says you confirmedConfirm');
    expect(textOf(rows[2]!)).toBe('M3 Underwrite top 5 listings, current milestoneTest: each has a pro formaMark passed');
    const buttons = all(block, (n) => n.tag === 'button');
    expect(buttons.map((b) => [b.text, b.attrs['aria-label']])).toEqual([['Confirm', 'Confirm M2 passed'], ['Mark passed', 'Mark M3 passed']]);
  });

  it('says no plan yet, no plan on purpose, or offers repair', () => {
    expect(textOf(render({ milestones: { kind: 'absent' } }))).toBe('MilestonesNo plan yetNo plan yet. Ask your AI app to propose milestones for this project.');
    expect(textOf(render({ milestones: { kind: 'none', reason: 'A one-off errand.' } }))).toBe('MilestonesNo plan on purposeA one-off errand.');
    const broken = render({ milestones: { kind: 'malformed', reason: 'M1 appears more than once.' } });
    expect(textOf(broken)).toBe('MilestonesNeeds repairNorthKeep cannot read this Milestones section.M1 appears more than once. AI apps cannot change it until you repair it.Repair milestones');
  });

  it('sends confirm and repair to their routes bound to the revision read, and handles a stale page', () => {
    const confirm = functionSource('confirmMilestone');
    expect(confirm).toContain("'/milestones/confirm', { method:'POST', json:{ id:item.id, expected_revision:project.revision } }");
    expect(confirm).toContain("ex.code === 'stale_project'");
    expect(confirm).toContain("'Did you run this test, and did it pass?'");
    expect(confirm).toContain("el('blockquote', 'ms-test', item.test)");
    expect(confirm).toContain("cancel.dataset.autofocus = ''");
    const save = functionSource('renderMilestoneRepairReview');
    expect(save).toContain('check:false, accept_passes:passes.map((pass) => pass.line)');
    expect(functionSource('renderRestoreBody')).toContain('renderRestoreMilestones(project.restore_milestones && project.restore_milestones[row.id])');
  });

  it('lists every pass a restore would add, change and undo, in words (K2 review W2)', () => {
    const dom = fakeDom();
    const context = vm.createContext({ ...dom, Date, String, Number, Array });
    vm.runInContext([functionSource('milestoneDay'), functionSource('milestoneWho'), functionSource('restorePassText'), functionSource('renderRestoreMilestones')].join('\n'), context);
    const run = context.renderRestoreMilestones as (c: unknown) => Node | null;
    expect(run(undefined)).toBeNull();
    expect(run({ adds: [], changes: [], undoes: [], unreadable: false })).toBeNull();
    const you = { id: 'M1', title: 'Agree the plan', on: '2026-10-01', by: 'you' };
    const said = { id: 'M2', title: 'Draft the outline', on: '2026-10-05', by: 'agent' };
    const mine = { id: 'M2', title: 'Draft the outline', on: '2026-10-14', by: 'you' };
    const open = { id: 'M3', title: 'Write the draft', on: '2026-10-14', by: 'you' };
    const notice = run({ adds: [you], changes: [{ from: mine, to: said }], undoes: [open], unreadable: false })!;
    expect(notice.attrs.role).toBe('status');
    expect(all(notice, (n) => n.tag === 'strong').map(textOf)).toEqual(['This restore changes your milestones.']);
    expect(all(notice, (n) => n.tag === 'p').map(textOf)).toEqual([
      'Marks 1 milestone passed:', 'Changes 1 passed milestone:', 'Undoes 1 passed milestone:',
      'Restore only if each milestone it marks passed really passed.',
    ]);
    expect(all(notice, (n) => n.tag === 'li').map(textOf)).toEqual([
      'M1 Agree the plan, passed Oct 1, you confirmed',
      'M2 Draft the outline: now passed Oct 14, you confirmed. After the restore: passed Oct 5, agent says you confirmed',
      'M3 Write the draft, passed Oct 14, you confirmed',
    ]);
    const broken = run({ adds: [], changes: [], undoes: [you, said], unreadable: true })!;
    expect(all(broken, (n) => n.tag === 'p').map(textOf)).toEqual([
      'Undoes 2 passed milestones:',
      'NorthKeep cannot read the Milestones section in this version. After the restore, you need to repair it before AI apps can change it.',
    ]);
  });

  it('highlights every line that reads like a pass in the repair view', () => {
    const dom = fakeDom();
    const context = vm.createContext({ ...dom, String });
    vm.runInContext(script.slice(script.indexOf('const MILESTONE_STAMP_HINT'), script.indexOf('\n', script.indexOf('const MILESTONE_STAMP_HINT'))) + '\n' + functionSource('renderMilestoneLines') + '\nthis.run = renderMilestoneLines; this.hint = MILESTONE_STAMP_HINT;', context);
    const list = Object.assign(dom.el('ul'), { replaceChildren: () => { list.children = []; } });
    (context.run as (l: Node, t: string) => void)(list, '- [x] M1 A | test: b | passed 2026-10-01 (You)\n- [ ] M2 B | test: c\n\nM3 forged (agent)\n- [X] M4 D');
    expect(list.children.map((c) => [c.className, c.text])).toEqual([
      ['stamped', '- [x] M1 A | test: b | passed 2026-10-01 (You)'], ['', '- [ ] M2 B | test: c'], ['stamped', 'M3 forged (agent)'], ['stamped', '- [X] M4 D'],
    ]);
  });
});

describe('guard dialog focus while a save is in flight (K2 review W3)', () => {
  interface El { id: string; hidden?: boolean; inert?: boolean; disabled?: boolean; className?: string; textContent?: string; focused?: number; isConnected?: boolean; focus: () => void; getClientRects: () => unknown[] }
  function setup() {
    const doc = { activeElement: null as unknown, body: { id: 'body' } };
    const node = (id: string, extra: Record<string, unknown> = {}): El => {
      const n = { id, focused: 0, isConnected: true, getClientRects: () => [1], focus: () => { n.focused! += 1; doc.activeElement = n; }, ...extra } as El;
      return n;
    };
    const header = node('header', { inert: false }), shell = node('shell', { inert: false });
    const yes = node('yes'), notYet = node('notYet'), opener = node('opener'), unlockField = node('passphrase');
    const inside = new Set<unknown>([yes, notYet]);
    const overlay = node('guardDialogOverlay', { hidden: true, contains: (n: unknown) => inside.has(n), querySelectorAll: () => [notYet, yes].filter((b) => !b.disabled), addEventListener: () => {} });
    const body = node('guardDialogBody', { querySelector: (sel: string) => (sel === '[data-autofocus]' ? notYet : yes), replaceChildren: () => {} });
    const ids: Record<string, El> = { guardDialogOverlay: overlay, guardDialogBody: body, guardDialog: node('guardDialog'), guardDialogTitle: node('guardDialogTitle') };
    const listeners: Record<string, (e: unknown) => void> = {};
    Object.assign(doc, { querySelector: (sel: string) => (sel === 'header' ? header : sel === '.shell' ? shell : null), addEventListener: (k: string, fn: (e: unknown) => void) => { listeners[k] = fn; } });
    const context = vm.createContext({ $: (id: string) => ids[id], document: doc, Array });
    const lets = script.slice(script.indexOf('let guardLastFocus'), script.indexOf('\n', script.indexOf('let guardInertBefore')));
    vm.runInContext([lets, functionSource('openGuardDialog'), functionSource('closeGuardDialog'), functionSource('guardDialogKeydown'), 'this.open = openGuardDialog; this.keydown = guardDialogKeydown;'].join('\n'), context);
    const key = (k: string, shiftKey = false) => { let prevented = false; (context.keydown as (e: unknown) => void)({ key: k, shiftKey, preventDefault: () => { prevented = true; } }); return prevented; };
    return { doc, header, shell, yes, notYet, opener, unlockField, overlay, open: () => (context.open as (...a: unknown[]) => void)('Mark M3 passed?', '', () => {}, opener), key };
  }

  it('makes the page behind inert while open and restores it on close', () => {
    expect(script).toContain("document.addEventListener('keydown', guardDialogKeydown)");
    const t = setup();
    t.open();
    expect([t.header.inert, t.shell.inert, t.overlay.hidden]).toEqual([true, true, false]);
    expect(t.key('Escape')).toBe(true);
    expect([t.header.inert, t.shell.inert, t.overlay.hidden]).toEqual([false, false, true]);
    expect(t.doc.activeElement).toBe(t.opener);
  });

  it('keeps Tab and Escape working after the focused button is disabled and focus falls to the page', () => {
    const t = setup();
    t.open();
    t.yes.focus(); t.yes.disabled = true; t.doc.activeElement = t.doc.body;
    expect(t.key('Tab')).toBe(true);
    expect(t.doc.activeElement).toBe(t.notYet);
    t.doc.activeElement = null;
    expect(t.key('Escape')).toBe(true);
    expect(t.overlay.hidden).toBe(true);
  });

  it('leaves keys alone when another dialog has focus or the guard dialog is closed, and keeps an earlier inert page inert', () => {
    const t = setup();
    expect(t.key('Escape')).toBe(false);
    t.shell.inert = true;
    t.open();
    t.doc.activeElement = t.unlockField;
    expect(t.key('Escape')).toBe(false);
    expect(t.overlay.hidden).toBe(false);
    t.doc.activeElement = t.notYet;
    t.key('Escape');
    expect([t.header.inert, t.shell.inert]).toEqual([false, true]);
  });
});
