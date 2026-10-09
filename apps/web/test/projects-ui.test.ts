import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { summarizeMirror } from '@northkeep/core';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const projectStart = script.indexOf('// --- Projects:');
const projectEnd = script.indexOf("$('addMemoryToggle').addEventListener", projectStart);
const projects = script.slice(projectStart, projectEnd);

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  const start = script.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  if (start < 0) throw new Error(`Missing function ${name}`);
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe('Projects handoff UI', () => {
  it('keeps the application script syntactically valid', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('adds Projects to the established task navigation and responsive workspace', () => {
    expect(html).toMatch(/<button data-view="projects" class="active">[\s\S]*?<svg[\s\S]*?Projects<\/button>/);
    expect(html).toContain('<section id="view-projects">');
    expect(html).toContain('<section id="view-memories" hidden>');
    expect(html.indexOf('data-view="projects"')).toBeLessThan(html.indexOf('data-view="memories"'));
    expect(html).toContain('id="projectSearch"');
    expect(html).toContain('id="projectsBack"');
    expect(html).toContain("'memories', 'projects', 'curation'");
    expect(html).toContain("else if (v === 'projects') { loadProjects(); renderContractOffer(); }");
    expect(html).toContain('.projects-workspace { display:block; min-height:0; }');
    expect(html).toContain('#view-projects [hidden] { display:none !important; }');
    expect(html).toContain('#view-projects .project-detail-head h2');
    expect(html).toContain('font:500 27px/1.15 var(--serif)');
  });

  it('uses the exact list, detail, checkpoint and wrap routes', () => {
    expect(projects).toContain("api('/api/projects')");
    expect(projects).toContain("api('/api/projects/' + encodeURIComponent(slug))");
    expect(projects).toContain("api('/api/projects/' + encodeURIComponent(draft.slug) + '/' + draft.mode");
    expect(projects).toContain("[['edit','Edit',false],['delete','Delete',false],['checkpoint','Checkpoint',false],['wrap','Wrap up',false],['resume','Resume',true]]");
  });

  it('binds writes to the vault and exact revision with an idempotency key', () => {
    expect(projects).toContain('vault_id:draft.vault_id');
    expect(projects).toContain('expected_revision:draft.expected_revision');
    expect(projects).toContain('projectPendingOperations.get(key) || crypto.randomUUID()');
    expect(projects).toContain('operation_id:operationId');
    expect(projects).toContain('if (ex.status && ex.status >= 400 && ex.status < 500) projectPendingOperations.delete(key)');
    expect(projects).toContain('The save result is uncertain. Retry this exact draft to check it safely.');
  });

  it('supports authored status, completed work, explicit empty next actions and optional fields', () => {
    expect(projects).toContain("projectField('Current status'");
    expect(projects).toContain("projectField('Completed this session'");
    expect(projects).toContain("projectField('Next actions (may be empty)'");
    expect(projects).toContain("projectField('Open questions'");
    expect(projects).toContain("projectField('Decision to add (optional)'");
    expect(projects).toContain('next_actions:draft.next_actions');
    expect(projects).toContain('open_questions:draft.open_questions');
    expect(projects).toContain("...(draft.decision.trim() ? { decision:draft.decision } : {})");
    expect(projects).not.toContain('files:');
  });

  it('sends exact open-question text and the original revision', async () => {
    let sent: { route: string; options: { json: Record<string, unknown> } } | null = null;
    const context = vm.createContext({
      crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
      api: async (route: string, options: { json: Record<string, unknown> }) => { sent = { route, options }; return { current: {} }; },
      JSON,
    });
    vm.runInContext(`
      let projectReview={mode:'checkpoint',slug:'trail-journal',vault_id:'vault',expected_revision:'original-revision',status:'Exact status',completed:'Exact completed',next_actions:'',open_questions:'  Keep leading space?\\n- Keep this marker',decision:''};
      const projectPendingOperations=new Map(); let projectActionSequence=0; const status={unlocked:false}; const currentProjectSlug='trail-journal';
      const $=()=>({hidden:true}); const renderProjectChoices=()=>{}; const renderProjectDetail=()=>{}; const renderProjectReceipt=()=>{}; const renderProjectConflict=()=>{}; const projectWriteCurrent=async()=>false;
      ${functionSource('saveProjectDraft')}
      this.run=()=>saveProjectDraft({disabled:false},{textContent:''});
    `, context);
    await context.run();
    expect(sent).not.toBeNull();
    expect(sent!.route).toBe('/api/projects/trail-journal/checkpoint');
    expect(sent!.options.json.open_questions).toBe('  Keep leading space?\n- Keep this marker');
    expect(sent!.options.json.expected_revision).toBe('original-revision');
  });

  it('preserves the draft and shows current state on a stale response', () => {
    expect(script).toContain('e.code = data.code; e.current = data.current');
    expect(projects).toContain('if (ex.status === 409 && ex.current) { renderProjectConflict(draft, ex.current, ex.message); return; }');
    expect(projects).toContain('Save blocked. Your draft is preserved below beside the latest status.');
    expect(projects).toContain("el('h4', undefined, 'Your preserved draft')");
    expect(projects).toContain("el('h4', undefined, 'Latest update')");
    expect(projects).toContain("'Completed\\n' + draft.completed");
    expect(projects).toContain('renderProjectEditor(draft.mode');
    expect(projects).toContain(', draft);');
  });

  it('renders every project and file value through DOM text APIs', () => {
    expect(projects).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(projects).toContain("copy.append(el('strong', undefined, file.label), el('small', undefined, file.locator))");
    expect(projects).not.toMatch(/openExternal|window\.open|location\s*=|href\s*=/);
  });

  it('describes file access as caller-reported and resume access as unverified', () => {
    expect(projects).toContain("file.access === 'reported_available' ? 'Reported available'");
    expect(projects).toContain("file.access === 'unavailable' ? 'Reported unavailable' : 'Unverified for this assistant'");
    expect(projects).toContain('File access is caller-reported. Every reference remains unverified for this assistant');
    expect(projects).toContain("file.label + ': unverified for this assistant'");
    expect(projects).toContain('This form does not open, verify, or change them.');
  });

  it('uses readable names and truthful project state', () => {
    expect(projects).toContain('function projectName(slug)');
    expect(projects).toContain("projectName(item.project)");
    expect(projects).toContain("decide ? 'Needs your decision' : 'Needs attention'");
    expect(projects).not.toContain("'In progress'");
    expect(projects).toContain("project.files.some((file) => file.access === 'unavailable')");
    expect(projects).toContain("unavailable ? 'File missing' : 'Ready to resume'");
    expect(projects).toContain("'Updated ' + projectDate(project.updated_at)");
    expect(projects).not.toContain("' · revision ' + String(project.revision");
  });

  it('shows current Log entries with older history and uses correct file grammar', () => {
    expect(projects).toContain('log = projectLines(project.log)');
    expect(projects).toContain("el('div', 'review-meta-title hist-sub', 'Log')");
    expect(projects).toContain("values.length === 1 ? 'reference' : 'references'");
  });

  it('uses truthful local-only receipt language', () => {
    expect(html).toContain('id="projectsLocalPill">Local vault</span>');
    expect(projects).toContain('Saving updates this project on this device.');
    expect(projects).toContain("'Save on this device'");
    expect(projects).toContain("'Checkpoint saved on this device'");
    expect(projects).not.toContain("not synced or delivered");
    expect(projects).toContain('A read-only brief');
  });

  it('guards delayed responses and scrubs project state when locked', () => {
    expect(projects).toContain('const requestId = ++projectLoadSequence');
    expect(projects).toContain("requestId !== projectLoadSequence || !status.unlocked || $('view-projects').hidden");
    expect(script).toContain("if (v !== 'projects') invalidateProjectView()");
    expect(script).toContain('clearDetailedReviewSensitive(); clearProjectsSensitive();');
    expect(projects).toContain('projectPendingOperations.clear()');
    expect(projects).toContain("$('projectDetail').replaceChildren()");
  });

  it('announces operation changes, restores focus and supports Escape', () => {
    expect(html).toContain('<div id="projectLive" role="status" aria-live="polite"></div>');
    expect(projects).toContain('projectReturnFocus.focus()');
    expect(projects).toContain("if (event.key === 'Escape')");
    expect(projects).toContain("heading.tabIndex = -1; heading.focus()");
    expect(html).toContain('.project-choice[aria-current=true]');
    expect(projects).toContain("setAttribute('aria-current', String(item.project === currentProjectSlug))");
  });

  it('shows a connected-assistant empty state without creating projects', () => {
    expect(projects).toContain('Start a project through a connected assistant.');
    expect(projects).not.toMatch(/method:\s*'POST'[\s\S]{0,120}\/api\/projects['"]/);
  });
});

// ADR 0052 wave 2: provenance and draft state on the Projects page. Each test
// slices one named function and runs it against a minimal element factory.
describe('Projects provenance and draft state (ADR 0052)', () => {
  const elFactory = `
    function el(tag, cls, text) {
      return { tag, cls, text, children: [], attrs: {}, dataset: {}, title: '',
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        setAttribute(key, value) { this.attrs[key] = value; },
        replaceChildren(...nodes) { this.children = nodes; },
        addEventListener() {} };
    }`;

  function textOf(node: { text?: string; children?: unknown[] }): string {
    const own = node.text ? String(node.text) : '';
    const kids = (node.children ?? []) as { text?: string; children?: unknown[] }[];
    return [own, ...kids.map(textOf)].filter(Boolean).join('\n');
  }

  function run(setup: string, body: string) {
    const context = vm.createContext({ JSON });
    vm.runInContext(`${elFactory}\n${setup}\nthis.result = (() => { ${body} })();`, context);
    return (context as { result: unknown }).result;
  }

  it('renders the last writer line with the host, version and a local time', () => {
    const line = run(
      `${functionSource('projectDate')}\n${functionSource('projectWriterLine')}`,
      `return projectWriterLine({ last_writer: { host: 'claude-code', host_version: '0.17.0', recorded_at: '2026-09-21T15:04:00Z' } });`,
    ) as { cls: string; text: string };
    expect(line.cls).toBe('project-writer');
    expect(line.text).toContain('Last written by claude-code 0.17.0, ');
    expect(line.text).not.toContain('Date unavailable');
  });

  it('omits the version when absent and renders no line at all without a writer', () => {
    const [withoutVersion, missing] = run(
      `${functionSource('projectDate')}\n${functionSource('projectWriterLine')}`,
      `return [projectWriterLine({ last_writer: { host: 'northkeep-app', host_version: null, recorded_at: '2026-09-21T15:04:00Z' } }), projectWriterLine({ last_writer: null })];`,
    ) as [{ text: string }, null];
    expect(withoutVersion.text).toContain('Last written by northkeep-app, ');
    expect(missing).toBeNull();
  });

  it('says a draft was bootstrapped and not wrapped up by a person', () => {
    const banner = run(functionSource('projectDraftBanner'), 'return projectDraftBanner();') as { cls: string; text: string };
    expect(banner.cls).toBe('project-notice');
    expect(banner.text).toBe('Draft. This document was bootstrapped automatically and has not been wrapped up by a person yet.');
  });

  it('badges draft rows only, and shows the last writer host when one is recorded', () => {
    const setup = `
      const lists = { projectList: el('div'), projectSelect: el('select'), projectsSummaryMeta: { textContent: '' } };
      const $ = (id) => lists[id] || (lists[id] = Object.assign(el('div'), { querySelectorAll: () => [] }));
      const document = { createElementNS: () => el('svg') };
      const projectQuery = '', projectFilter = 'all', projectSort = 'recent';
      ${functionSource('projectDate')}
      ${functionSource('projectLines')}
      ${functionSource('projectNeedsAttention')}
      ${functionSource('filteredProjects')}
      const currentProjectSlug = '';
      const loadProject = () => {};
      const openProjectFromList = () => {};
      const projectDecisions = new Map([['trail-journal', 1]]);
      ${functionSource('projectName')}
      ${functionSource('projectPill')}
      const projectIndex = [
        { project: 'field-notes', title: 'Field Notes', status: 'Ready', conflict: false, draft: true, last_writer_host: 'claude-code' },
        { project: 'trail-journal', title: 'Trail Journal', status: 'Ready', conflict: false, draft: false, last_writer_host: null },
      ];
      ${functionSource('renderProjectChoices')}`;
    const { rows, meta } = run(setup, 'renderProjectChoices(); return { rows: lists.projectList.children, meta: lists.projectsSummaryMeta.textContent };') as { rows: { children: unknown[] }[]; meta: string };
    expect(rows).toHaveLength(2);
    const [plainRow, draftRow] = rows.map(row => textOf(row));
    expect(plainRow).toContain('Trail Journal');
    expect(draftRow).toContain('Draft');
    expect(draftRow).toContain('last: claude-code');
    expect(plainRow).not.toContain('Draft');
    expect(plainRow).not.toContain('last:');
    expect(draftRow).not.toContain('Needs your decision');
    expect(plainRow).toContain('Needs your decision');
    expect(meta).toBe('2 projects');
  });

  it('badges only shared rows and shows a version conflict as a choice, not a missing value', () => {
    const setup = `
      const lists = { projectList: el('div'), projectSelect: el('select'), projectsSummaryMeta: { textContent: '' } };
      const $ = (id) => lists[id] || (lists[id] = Object.assign(el('div'), { querySelectorAll: () => [] }));
      const document = { createElementNS: () => el('svg') };
      const projectQuery = '', projectFilter = 'all', projectSort = 'recent';
      ${functionSource('projectDate')}
      ${functionSource('projectLines')}
      ${functionSource('projectNeedsAttention')}
      ${functionSource('filteredProjects')}
      const currentProjectSlug = '';
      const openProjectFromList = () => {};
      const projectDecisions = new Map();
      ${functionSource('projectName')}
      ${functionSource('projectPill')}
      const projectIndex = [
        { project: 'private-one', title: 'Private One', status: 'Ready', updated_at: '2026-09-02', conflict: false, draft: false, shared: false },
        { project: 'shared-one', title: 'Shared One', status: 'Ready', updated_at: '2026-09-01', conflict: false, draft: false, shared: true },
        { project: 'paper-atlas', title: null, status: null, next_actions: null, updated_at: null, conflict: true, draft: false, shared: false },
      ];
      ${functionSource('renderProjectChoices')}`;
    const { rows, notice } = run(setup, 'renderProjectChoices(); return { rows: lists.projectList.children, notice: lists.projectsAttention };') as { rows: { children: unknown[] }[]; notice: { children: unknown[] } };
    const [conflict, privateRow, sharedRow] = rows.map(row => textOf(row));
    expect(conflict).toContain('Paper Atlas');
    expect(conflict).toContain('More than one version is saved. Open it to choose one.');
    expect(conflict).toContain('Choose a version first');
    expect(conflict).not.toMatch(/unavailable/i);
    expect(privateRow).toContain('Private One');
    expect(privateRow.split('\n')).not.toContain('Private');
    expect(privateRow).not.toContain('Shared with connected apps');
    expect(sharedRow).toContain('Shared with connected apps');
    expect(textOf(notice)).toBe('1 project needs you to choose a version\nMore than one version of it is saved. Open it to pick the one to keep.\nShow it');
  });

  const historySetup = `
      ${functionSource('projectLines')}
      ${functionSource('projectDate')}
      ${functionSource('projectPill')}
      ${functionSource('plural')}
      ${functionSource('projectLogRow')}
      ${functionSource('projectVersionRows')}
      ${functionSource('renderProjectHistory')}`;

  it('lists saved versions from content-free summaries, never their text', () => {
    const section = run(historySetup, `return renderProjectHistory({
      log: '- Current entry',
      history: [{ id: 'a', updated_at: '2026-09-20T10:00:00Z', content: 'SECRET REVISION BODY', mode: 'wrap' }],
      revisions: [
        { id: 'a', updated_at: '2026-09-20T10:00:00Z', mode: 'wrap', writer: { host: 'claude-code', host_version: null, session_id: 's' }, chars: 20 },
        { id: 'b', updated_at: '2026-09-19T10:00:00Z', chars: 12 },
      ],
      archives: [],
    });`) as { children: unknown[] };
    const text = textOf(section);
    expect(text).toContain('Wrap');
    expect(text).toContain('Written by claude-code');
    expect(text).not.toContain('SECRET REVISION BODY');
    expect(text).toContain('Current entry');
    expect(text).toContain('Session history · 2 saved versions · 1 log entry');
  });

  it('splits Saved versions from the Log, offers Restore only where the text survives, and marks the current one', () => {
    const section = run(historySetup, `return renderProjectHistory({
      revision: 'head', updated_at: '2026-09-30T08:02:00Z', last_writer: { host: 'claude-code' },
      log: '- 2026-09-30: Removed the old import script.',
      history: [{ id: 'a', updated_at: '2026-09-29T18:40:00Z', content: '## Current Status\\nOlder.', mode: 'checkpoint' }],
      revisions: [{ id: 'a', updated_at: '2026-09-29T18:40:00Z', mode: 'checkpoint', chars: 20 }],
      cleared_revisions: [{ id: 'old', updated_at: '2026-09-15T09:12:00Z', writer: { host: 'chatgpt' } }],
      archives: [],
    });`) as { children: unknown[] };
    const body = (section.children[0] as { children: unknown[] }).children[1] as { children: { cls?: string; text?: string; children: unknown[] }[] };
    const rows = body.children.filter((n) => n.cls?.startsWith('ver-row')).map((n) => textOf(n));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Current version');
    expect(rows[1]).toContain('Checkpoint');
    expect(rows[1]).toContain('Restore this version');
    expect(rows[2]).toContain('Written by chatgpt');
    expect(rows[2]).toContain('Text cleared to save space. Cannot restore.');
    expect(rows[2]).not.toContain('Restore this version');
    const titles = body.children.filter((n) => n.cls === 'review-meta-title hist-sub').map((n) => n.text);
    expect(titles).toEqual(['Saved versions', 'Log']);
    const log = textOf(body.children.find((n) => n.cls === 'project-event')!);
    expect(log).toContain('Removed the old import script.');
    expect(log).not.toContain('2026-09-30');
    expect(textOf(section)).toContain('Session history · 3 saved versions · 1 log entry');
  });

  it('falls back to the older payload shape, listing its versions without their text', () => {
    const section = run(historySetup, `return renderProjectHistory({
      log: '',
      history: [{ id: 'a', updated_at: '2026-09-20T10:00:00Z', content: 'Older revision body', mode: 'checkpoint' }],
      archives: [{ id: 'z', updated_at: '2026-09-01T10:00:00Z', content: 'Archived log entry' }],
    });`) as { children: unknown[] };
    const text = textOf(section);
    expect(text).toContain('Checkpoint');
    expect(text).toContain('Restore this version');
    expect(text).not.toContain('Older revision body');
    expect(text).toContain('Archived log entry');
    expect(text).toContain('Session history · 1 saved version · 0 log entries · 1 archived');
  });
});

describe('Projects backup mirror line (ADR 0053 Decision 7)', () => {
  const NOW = new Date('2026-09-22T15:00:00Z');
  const rows = [
    { project: 'alpha', revision: 'r-alpha-2', conflict: false },
    { project: 'beta', revision: 'r-beta-2', conflict: false },
  ] as never;
  const exported = { projects: { alpha: { revision: 'r-alpha-1' }, beta: { revision: 'r-beta-1' } } };

  /** Runs the page's own functions against a stand-in node, so the test sees what a person sees. */
  function render(line: unknown) {
    const node = { textContent: 'stale text', title: 'stale title', hidden: false };
    const context = vm.createContext({ node, line });
    vm.runInContext(`const $ = () => node;\n${functionSource('projectsMirrorText')}\n${functionSource('showProjectsMirror')}\nshowProjectsMirror(line);`, context);
    return node;
  }

  it('sits in the summary row as one small line with no new control', () => {
    expect(html).toContain('<span class="pill" id="projectsLocalPill">Local vault</span><span class="muted projects-mirror" id="projectsMirrorMeta" hidden></span></div>');
    expect(html).toContain('.projects-mirror { flex-basis:100%; font-size:12px; line-height:1.4; }');
    expect(projects).toContain('showProjectsMirror(data.mirror);');
  });

  it('rewords a real exported line for people and shows no raw line on hover', () => {
    const line = summarizeMirror({ ...exported, last_success: { at: '2026-09-22T12:00:00Z' } }, rows, NOW);
    const node = render(line);
    expect(node.hidden).toBe(false);
    expect(node.textContent).toBe('Backup mirror last updated 3 hours ago; 2 projects changed since');
    expect(node.title).toBe('');
  });

  it('rewords a real never-exported line and a real failed-later line', () => {
    expect(render(summarizeMirror({}, rows, NOW)).textContent).toBe('Backup mirror never updated; 2 projects changed since');
    const failed = summarizeMirror({
      projects: { alpha: { revision: 'r-alpha-2' }, beta: { revision: 'r-beta-2' } },
      last_success: { at: '2026-09-22T12:00:00Z' },
      last_failure: { at: '2026-09-22T14:30:00Z' },
    }, rows, NOW);
    expect(render(failed).textContent).toBe('Backup mirror last updated 3 hours ago; 0 projects changed since; last update failed 30 minutes ago');
  });

  it('is hidden and empty when the server sends null or nothing', () => {
    for (const value of [null, undefined, '']) {
      const node = render(value);
      expect(node.hidden).toBe(true);
      expect(node.textContent).toBe('');
      expect(node.title).toBe('');
    }
  });

  it('is cleared on lock and while a reload is in flight, so a stale line never survives', () => {
    expect(functionSource('clearProjectsSensitive')).toContain('showProjectsMirror(null);');
    const load = functionSource('loadProjects');
    expect(load.indexOf('showProjectsMirror(null);')).toBeGreaterThan(-1);
    expect(load.indexOf('showProjectsMirror(null);')).toBeLessThan(load.indexOf("await api('/api/projects')"));
  });
});

describe('Conflict view comparison (ADR 0063 D1)', () => {
  const load = () => {
    const context = vm.createContext({});
    vm.runInContext(`${functionSource('shortDay')}\n${functionSource('projectSections')}\nconst PROJECT_COMPARE_GROUPS = ${script.match(/const PROJECT_COMPARE_GROUPS = (\[[^\n]*\]);/)![1]};\n${functionSource('compareProjectTexts')}\n${functionSource('diffUnits')}`, context);
    return context as unknown as { compareProjectTexts: (a: string, b: string) => Array<{ label: string; same: boolean; mine: string; theirs: string }>; diffUnits: (a: string, b: string) => Array<Array<{ text: string; only: boolean }>> };
  };
  const mine = '# home-budget\n\n## What & Why\n\nBudget.\n\n## Current Status\n\nDraft is in the sheet. Renewal came in at $1,840, up 6%.\n\n## Next Actions\n\n1. Update utilities.\n2. Move the increase into the plan.\n\n## Decisions\n\n- 2026-09-30 - Keep groceries as one line.\n\n## Log\n\n- 2026-09-29 - Entered the renewal figure.\n';
  const theirs = mine.replace('Renewal came in at $1,840, up 6%.', 'Waiting on the renewal quote.').replace('2. Move the increase into the plan.', '2. Call the agent.').replace('- 2026-09-29 - Entered the renewal figure.', '- 2026-09-27 - Drafted questions.');

  it('groups sections the way the page names them, hiding quiet ones that match', () => {
    const groups = load().compareProjectTexts(mine, theirs);
    expect(groups.map((g) => [g.label, g.same])).toEqual([['Current summary', false], ['Next actions', false], ['Decisions and open questions', true], ['Log', false]]);
    expect(groups[3]!.mine).toMatch(/^Sep 29: Entered the renewal figure\.$/);
  });

  it('marks only the sentences one version lacks, and never splits a numbered line', () => {
    const units = load().diffUnits('Draft is in the sheet. Renewal came in at $1,840, up 6%.\n1. Update utilities.', 'Draft is in the sheet. Waiting on the renewal quote.\n1. Update utilities.');
    expect(JSON.parse(JSON.stringify(units))).toEqual([
      [{ text: 'Draft is in the sheet.', only: false }, { text: 'Renewal came in at $1,840, up 6%.', only: true }],
      [{ text: '1. Update utilities.', only: false }],
    ]);
  });
});

describe('Automatic push status line (ADR 0063 D5)', () => {
  const sentence = (auto: Record<string, unknown>) => {
    const context = vm.createContext({});
    vm.runInContext(functionSource('autoPushSentence'), context);
    return vm.runInContext(`autoPushSentence(${JSON.stringify(auto)})`, context) as string;
  };
  it('says when it is on, and names Sync now instead of a CLI command when it is not', () => {
    expect(sentence({ enabled: true, phase: 'idle', reason: null })).toBe('On. Cloud Connect updates on its own a few seconds after this Mac syncs with your other devices.');
    expect(sentence({ enabled: false, phase: 'off', reason: 'switched_off', message: 'x' })).toBe('Off. Cloud Connect updates only when you use Sync now.');
    expect(sentence({ enabled: true, phase: 'paused', reason: 'stale_push', message: 'run: northkeep share push --reset-order' })).not.toContain('northkeep');
    expect(sentence({ enabled: true, phase: 'paused', reason: 'behind', message: 'This Mac is behind your other devices.' })).toBe('This Mac is behind your other devices.');
  });
});
