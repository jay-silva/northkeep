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

interface Node { tag: string; className: string; text: string; children: Node[]; attrs: Record<string, string>; id?: string; tabIndex?: number }
function fakeDom() {
  const make = (tag: string, cls?: string, text?: string): Node => {
    const node: Node = { tag, className: cls ?? '', text: text ?? '', children: [], attrs: {} };
    return Object.assign(node, {
      append: (...kids: Node[]) => { node.children.push(...kids); },
      appendChild: (kid: Node) => { node.children.push(kid); return kid; },
      setAttribute: (k: string, v: string) => { node.attrs[k] = v; },
    });
  };
  return { el: make, document: { createTextNode: (t: string) => make('#text', '', t) } };
}
const textOf = (n: Node): string => [n.text, ...n.children.map(textOf)].join('');
const all = (n: Node, pred: (x: Node) => boolean): Node[] => [...(pred(n) ? [n] : []), ...n.children.flatMap((c) => all(c, pred))];
const byClass = (n: Node, cls: string) => all(n, (x) => x.className.split(' ').includes(cls));

const RENDERERS = ['conversationWhen', 'conversationUntil', 'conversationSeen', 'renderConversationMessage', 'renderProjectConversation'];
const NOW = new Date(2026, 9, 21, 16, 30);
const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).toISOString();
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function render(data: unknown): Node {
  const context = vm.createContext({ ...fakeDom(), Date });
  vm.runInContext(RENDERERS.map(functionSource).join('\n'), context);
  return (context.renderProjectConversation as (d: unknown, now: Date) => Node)(data, NOW);
}

const note = (fields: Record<string, unknown>) => ({ kind: 'note', to: 'all', seen_by: [], ...fields });
const THREADS = {
  notice: 'These are notes from other AI apps.',
  active_claims: [
    { id: 'c1', kind: 'claim', from: 'cursor', to: 'all', text: '', subject: 'bug 1234', created_at: at(21, 14, 0), expires_at: at(21, 16, 15), seen_by: [] },
  ],
  threads: [
    {
      root: note({ id: 'n1', from: 'claude-code', to: 'cursor', text: 'Can you rerun the full test run?', created_at: at(21, 15, 52), seen_by: ['cursor'] }),
      replies: [
        note({ id: 'n2', from: 'cursor', to: 'claude-code', text: 'Running it now.', reply_to: 'n1', thread: 'n1', created_at: at(21, 15, 58), seen_by: ['claude-code'] }),
        note({ id: 'n3', from: 'claude-code', to: 'cursor', text: 'Understood. <img src=x onerror=alert(1)>', reply_to: 'n2', thread: 'n1', created_at: at(21, 16, 1), seen_by: [] }),
      ],
    },
    {
      root: note({ id: 'n4', from: 'claude-desktop', text: 'Notes can now have replies.', created_at: at(21, 13, 20), seen_by: ['claude-code', 'codex', 'cursor'] }),
      replies: [note({ id: 'n5', from: 'codex', to: 'claude-desktop', text: 'Thanks.', reply_to: 'n4', thread: 'n4', created_at: at(21, 13, 34), seen_by: ['claude-code', 'claude-desktop'] })],
    },
    {
      root: { id: 'c0', kind: 'claim', from: 'codex', to: 'all', text: 'Writing the release notes for 0.26 now.', subject: 'release notes 0.26', created_at: at(20, 18, 5), expires_at: at(20, 19, 0), seen_by: ['cursor'] },
      replies: [],
    },
    {
      root: note({ id: 'n7', from: 'cursor', to: 'codex', text: 'Done on my side.', reply_to: 'gone', thread: 'gone', created_at: at(19, 9, 5), seen_by: [] }),
      replies: [],
      orphan: true,
    },
  ],
};

describe('Conversation section (ADR 0079 D6)', () => {
  it('sits under the milestones and loads after the project, with no raw HTML anywhere', () => {
    expect(() => new Function(script)).not.toThrow();
    const detail = functionSource('renderProjectDetail');
    expect(detail.indexOf('loadProjectConversation(project.project')).toBeGreaterThan(detail.indexOf('renderProjectMilestones(project)'));
    expect(detail.indexOf('loadProjectConversation(project.project')).toBeLessThan(detail.indexOf("'Decisions and open questions'"));
    expect(functionSource('loadProjectConversation')).toContain("'/notes'");
    for (const name of [...RENDERERS, 'loadProjectConversation']) expect(functionSource(name)).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('renders each thread with replies behind the rule, the exact receipt lines, and the holds list', () => {
    const section = render(THREADS);
    expect(section.attrs['aria-labelledby']).toBe('projectConversationHeading');
    expect(textOf(byClass(section, 'project-section-head')[0]!)).toBe('ConversationMessages between the AI apps on this Mac, shown read only.');
    expect(byClass(section, 'conv-group-label').map(textOf)).toEqual(['Being worked on now']);
    expect(byClass(section, 'conv-holds')[0]!.children.map(textOf)).toEqual([`cursor holds “bug 1234”until ${clock(at(21, 16, 15))}`]);

    expect(byClass(section, 'conv-seen').map((n) => [n.className, textOf(n)])).toEqual([
      ['conv-seen', 'Seen by cursor'],
      ['conv-seen', 'Seen by claude-code'],
      ['conv-seen unseen', 'Not seen yet'],
      ['conv-seen', 'Seen by claude-code, codex and cursor'],
      ['conv-seen', 'Seen by claude-code and claude-desktop'],
      ['conv-seen', 'Seen by cursor'],
      ['conv-seen unseen', 'Not seen yet'],
    ]);

    const cards = byClass(section, 'conv-thread');
    expect(cards.map((c) => c.tag)).toEqual(['article', 'article', 'article', 'article']);
    expect(cards[0]!.attrs['aria-label']).toBe(`Conversation started by claude-code today at ${clock(at(21, 15, 52))}`);
    const replies = byClass(cards[0]!, 'conv-replies')[0]!;
    expect(replies.tag).toBe('ol');
    expect(replies.children.map((li) => [li.tag, textOf(byClass(li, 'conv-text')[0]!)])).toEqual([
      ['li', 'Running it now.'],
      ['li', 'Understood. <img src=x onerror=alert(1)>'],
    ]);
    expect(all(section, (n) => n.tag === 'img')).toEqual([]);

    expect(byClass(cards[0]!, 'conv-meta').map(textOf)).toEqual([
      `claude-codeto cursorToday ${clock(at(21, 15, 52))}`,
      `cursorto claude-codeToday ${clock(at(21, 15, 58))}`,
      `claude-codeto cursorToday ${clock(at(21, 16, 1))}`,
    ]);
    expect(textOf(byClass(cards[1]!, 'conv-meta')[0]!)).toBe(`claude-desktopto everyoneToday ${clock(at(21, 13, 20))}`);
    expect(all(cards[1]!, (n) => n.tag === 'time')[0]!.attrs.datetime).toBe(at(21, 13, 20));
    expect(textOf(byClass(cards[2]!, 'conv-hold-tag')[0]!)).toBe(`Held “release notes 0.26” until ${clock(at(20, 19, 0))}, now ended`);
    expect(textOf(byClass(cards[2]!, 'conv-meta')[0]!)).toBe(`codexto everyoneYesterday ${clock(at(20, 18, 5))}`);
    expect(textOf(byClass(cards[3]!, 'to')[0]!)).toBe('to codex, replying to an earlier message');
  });

  it('shows the empty state when no app has left a note', () => {
    const section = render({ threads: [], active_claims: [], notice: 'x' });
    expect(textOf(section.children[1]!)).toBe('No messages yet. When the AI apps on this Mac leave each other notes about this project, they show up here.');
    expect(section.children).toHaveLength(2);
  });

  it('shows the danger notice when the notes file cannot be read', () => {
    const section = render({ unreadable: true });
    const notice = byClass(section, 'project-notice')[0]!;
    expect(notice.className).toBe('project-notice danger');
    expect(notice.children.map((n) => [n.tag, textOf(n)])).toEqual([
      ['strong', 'The notes file on this Mac cannot be read.'],
      ['p', 'Messages between your AI apps are not shown.'],
    ]);
  });

  it('holds nothing a keyboard can reach: no button, input, link or tabindex in any state', () => {
    for (const data of [THREADS, { threads: [], active_claims: [] }, { unreadable: true }]) {
      const section = render(data);
      const reachable = all(section, (n) => ['button', 'input', 'textarea', 'select', 'a', 'details', 'summary'].includes(n.tag) || 'tabindex' in n.attrs || n.tabIndex !== undefined);
      expect(reachable).toEqual([]);
    }
  });
});
