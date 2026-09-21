import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';

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
    expect(html).toMatch(/<button data-view="projects">[\s\S]*?<svg[\s\S]*?Projects<\/button>/);
    expect(html).toContain('<section id="view-projects" hidden>');
    expect(html).toContain("'memories', 'projects', 'curation'");
    expect(html).toContain("else if (v === 'projects') loadProjects()");
    expect(html).toContain('.projects-workspace { display:grid; grid-template-columns:260px minmax(0,1fr);');
    expect(html).toContain('.projects-workspace { display:block; min-height:0; }');
    expect(html).toContain('.projects-mobile-select { display:block; }');
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
      const $=()=>({hidden:true}); const renderProjectChoices=()=>{}; const renderProjectDetail=()=>{}; const renderProjectReceipt=()=>{}; const renderProjectConflict=()=>{};
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
    expect(projects).toContain("item.conflict ? 'Needs attention' : 'Project'");
    expect(projects).toContain("project.files.some((file) => file.access === 'unavailable')");
    expect(projects).toContain("unavailable ? 'Needs attention' : 'Ready to resume'");
    expect(projects).toContain("'Updated ' + projectDate(project.updated_at)");
    expect(projects).not.toContain("' · revision ' + String(project.revision");
  });

  it('shows current Log entries with older history and uses correct file grammar', () => {
    expect(projects).toContain('log = projectLines(project.log)');
    expect(projects).toContain("el('time', undefined, 'Current')");
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
      const lists = { projectList: el('div'), projectSelect: el('select') };
      const $ = (id) => lists[id];
      const currentProjectSlug = '';
      const loadProject = () => {};
      ${functionSource('projectName')}
      ${functionSource('projectPill')}
      const projectIndex = [
        { project: 'field-notes', title: 'Field Notes', status: 'Ready', conflict: false, draft: true, last_writer_host: 'claude-code' },
        { project: 'trail-journal', title: 'Trail Journal', status: 'Ready', conflict: false, draft: false, last_writer_host: null },
      ];
      ${functionSource('renderProjectChoices')}`;
    const rows = run(setup, 'renderProjectChoices(); return lists.projectList.children;') as { children: unknown[] }[];
    expect(rows).toHaveLength(2);
    const draftRow = textOf(rows[0]!), plainRow = textOf(rows[1]!);
    expect(draftRow).toContain('Draft');
    expect(draftRow).toContain('last: claude-code');
    expect(plainRow).not.toContain('Draft');
    expect(plainRow).not.toContain('last:');
  });

  it('lists saved versions from content-free summaries, never their text', () => {
    const setup = `
      ${functionSource('projectLines')}
      ${functionSource('projectDate')}
      ${functionSource('renderProjectHistory')}`;
    const section = run(setup, `return renderProjectHistory({
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
    expect(text).toContain('Session history · 3 recent');
  });

  it('falls back to the older payload shape, which still carries revision text', () => {
    const setup = `
      ${functionSource('projectLines')}
      ${functionSource('projectDate')}
      ${functionSource('renderProjectHistory')}`;
    const section = run(setup, `return renderProjectHistory({
      log: '',
      history: [{ id: 'a', updated_at: '2026-09-20T10:00:00Z', content: 'Older revision body', mode: 'checkpoint' }],
      archives: [{ id: 'z', updated_at: '2026-09-01T10:00:00Z', content: 'Archived log entry' }],
    });`) as { children: unknown[] };
    const text = textOf(section);
    expect(text).toContain('Checkpoint');
    expect(text).toContain('Older revision body');
    expect(text).toContain('Archived log entry');
    expect(text).toContain('Session history · 1 recent · 1 archived');
  });
});
