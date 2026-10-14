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
    expect(functionSource('renderRestoreBody')).toContain('project.restore_undoes[row.id]');
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
