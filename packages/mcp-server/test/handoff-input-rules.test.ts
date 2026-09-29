import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHarness, text, type Harness } from './harness-0060.js';

/**
 * Release 0.22.3 review F1: the handoff tools refused whole saves on rules the
 * published schema did not state, some with no reason. These tests call the
 * tools the way a host does and pin the served schema, the literal refusal and
 * the saved text.
 */

let h: Harness;
afterEach(async () => { await h.close(); });

interface Head { vault_id: string; revision: string }
interface Saved { replayed: boolean; receipt: { result_revision: string }; current: { status: string; next_actions: string; open_questions: string; decisions: string; log: string; files: unknown[] | null } }

async function setup(): Promise<Client> {
  h = createHarness();
  const mcp = await h.connect();
  const created = await mcp.callTool({ name: 'project_create', arguments: { project: 'rules', what_why: 'Rules test.', status: 'Start.' } });
  expect(created.isError).toBeFalsy();
  return mcp;
}

async function head(mcp: Client): Promise<Head> {
  return JSON.parse(text(await mcp.callTool({ name: 'project_resume', arguments: { project: 'rules' } }))) as Head;
}

/** A tool result or a protocol refusal, as the text a host would see. */
async function attempt(mcp: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  try {
    const r = await mcp.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: text(r) };
  } catch (error) {
    return { isError: true, text: (error as Error).message };
  }
}

let op = 0;
function opId(): string {
  op += 1;
  return `00000000-0000-4000-8000-${op.toString(16).padStart(12, '0')}`;
}

async function checkpoint(mcp: Client, fields: Record<string, unknown>, tool = 'project_checkpoint') {
  const { vault_id, revision } = await head(mcp);
  return attempt(mcp, tool, {
    vault_id, project: 'rules', operation_id: opId(), expected_revision: revision,
    status: 'S', completed: 'Did work.', next_actions: '', ...fields,
  });
}

function refusal(result: { isError: boolean; text: string }): string {
  expect(result.isError).toBe(true);
  return (JSON.parse(result.text) as { error: { code: string; message: string } }).error.message;
}

const OK_FILE = { type: 'local_path', label: 'notes', locator: '/tmp/notes.md', access: 'unverified' };

describe('F1: the served schema states the rules core enforces', () => {
  it('files: type enum, core limits, reported_available rule and replacement', async () => {
    const mcp = await setup();
    const { tools } = await mcp.listTools();
    for (const name of ['project_checkpoint', 'project_wrap', 'project_update']) {
      const files = (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, any>).files;
      const item = files.items.properties;
      expect(item.type.enum).toEqual(['local_path', 'url', 'memory']);
      expect(item.label.maxLength).toBe(200);
      expect(item.locator.maxLength).toBe(2048);
      expect(item.context.maxLength).toBe(500);
      expect(item.access.description).toContain('it then requires checked_at and context');
      expect(item.checked_at.description).toContain('2026-09-28T10:00:00.000Z');
      expect(files.description).toContain('Replaces the whole earlier Files list');
      expect(files.description).toContain('an empty list clears it');
    }
  });

  it('section fields describe the heading rule and the line-break normalization', async () => {
    const mcp = await setup();
    const { tools } = await mcp.listTools();
    const wrap = tools.find((t) => t.name === 'project_wrap')!;
    const props = wrap.inputSchema.properties as Record<string, { description?: string }>;
    for (const field of ['status', 'completed', 'next_actions', 'decision', 'open_questions']) {
      expect(props[field]!.description).toContain('a line starting with # and a space is refused');
      expect(props[field]!.description).toContain('Line breaks at either end are removed and CRLF becomes LF.');
    }
    expect(wrap.description).toContain('A refusal that names a field and a rule saved nothing');
    expect(JSON.stringify(tools)).not.toContain('\u2014');
  });
});

describe('F1: harmless line-ending noise is normalized, not refused', () => {
  it('saves trailing, leading and CRLF line breaks as clean text', async () => {
    const mcp = await setup();
    const r = await checkpoint(mcp, {
      status: 'Line a\r\nLine b\r\n', completed: '\nDid x.\n', next_actions: '- one\n- two\n',
      decision: '\nPick A.\n', open_questions: 'Q1?\n\n',
    });
    expect(r.isError).toBe(false);
    const saved = JSON.parse(r.text) as Saved;
    expect(saved.current.status).toBe('Line a\nLine b');
    expect(saved.current.next_actions).toBe('- one\n- two');
    expect(saved.current.open_questions).toBe('Q1?');
    expect(saved.current.decisions).toMatch(/^- \d{4}-\d{2}-\d{2} - Pick A\.$/);
    expect(saved.current.log.split('\n')[0]).toMatch(/^- \d{4}-\d{2}-\d{2} - Checkpoint: Did x\.$/);
  });

  it('stores text core already accepted byte for byte (trailing spaces and inner blank lines kept)', async () => {
    const mcp = await setup();
    const r = await checkpoint(mcp, { status: '  Indented.  ', next_actions: '- a\n\n- b  ' });
    const saved = JSON.parse(r.text) as Saved;
    expect(saved.current.status).toBe('  Indented.  ');
    expect(saved.current.next_actions).toBe('- a\n\n- b  ');
  });

  it('an exact retry of the same raw input replays; a changed request with that id conflicts', async () => {
    const mcp = await setup();
    const { vault_id, revision } = await head(mcp);
    const raw = {
      vault_id, project: 'rules', operation_id: '11111111-1111-4111-8111-111111111111', expected_revision: revision,
      status: 'Replay\r\n', completed: '\nReplay me.\n', next_actions: '- r\n',
    };
    const first = JSON.parse(text(await mcp.callTool({ name: 'project_wrap', arguments: raw }))) as Saved;
    expect(first.replayed).toBe(false);
    const second = JSON.parse(text(await mcp.callTool({ name: 'project_wrap', arguments: raw }))) as Saved;
    expect(second.replayed).toBe(true);
    expect(second.receipt.result_revision).toBe(first.receipt.result_revision);
    const clean = JSON.parse(text(await mcp.callTool({
      name: 'project_wrap', arguments: { ...raw, status: 'Replay', completed: 'Replay me.', next_actions: '- r' },
    }))) as Saved;
    expect(clean.replayed).toBe(true);
    const changed = await attempt(mcp, 'project_wrap', { ...raw, completed: 'Different.' });
    expect(JSON.parse(changed.text)).toEqual({ error: { code: 'operation_conflict', message: 'Operation id was already used for a different project request.' } });
    const log = (JSON.parse(text(await mcp.callTool({ name: 'project_resume', arguments: { project: 'rules' } }))) as { log: string }).log;
    expect(log.split('\n').filter((line) => line.includes('Replay me.'))).toHaveLength(1);
  });

  it('project_update normalizes the same fields', async () => {
    const mcp = await setup();
    const { revision } = await head(mcp);
    const r = JSON.parse(text(await mcp.callTool({
      name: 'project_update',
      arguments: { project: 'rules', expected_revision: revision, status: 'Updated.\r\n', log_entry: 'Fixed.\n', open_questions: '\nQ?\n' },
    }))) as { status: string; open_questions: string; log: string };
    expect(r.status).toBe('Updated.');
    expect(r.open_questions).toBe('Q?');
    expect(r.log.split('\n')[0]).toMatch(/ - Fixed\.$/);
  });

  it('a value of only line breaks is refused, not turned into a silent clear', async () => {
    const mcp = await setup();
    expect(refusal(await checkpoint(mcp, { next_actions: '\n\n' }))).toBe('next_actions contains only line breaks; send an empty string to clear it.');
    expect(refusal(await checkpoint(mcp, { completed: '\r\n' }))).toBe('completed must not be empty.');
  });
});

describe('F1: real rule violations are refused by name', () => {
  it('structure rules stay: headings and lone carriage returns', async () => {
    const mcp = await setup();
    expect(refusal(await checkpoint(mcp, { completed: 'Did x.\n## Done' })))
      .toBe('completed cannot contain a Markdown heading (a line starting with # and a space); it would split the project document.');
    expect(refusal(await checkpoint(mcp, { status: 'Text\n## Sneaky\nmore' })))
      .toBe('status cannot contain a Markdown heading (a line starting with # and a space); it would split the project document.');
    expect(refusal(await checkpoint(mcp, { next_actions: '# Plan' }, 'project_wrap')))
      .toBe('next_actions cannot contain a Markdown heading (a line starting with # and a space); it would split the project document.');
    expect(refusal(await checkpoint(mcp, { completed: 'a\rb' }))).toBe('completed cannot contain a carriage return; use plain line breaks (\\n).');
    expect(refusal(await checkpoint(mcp, { completed: '   ' }))).toBe('completed must not be empty.');
  });

  it('file rules the schema can express are refused by the schema, naming the path', async () => {
    const mcp = await setup();
    const type = await checkpoint(mcp, { files: [{ ...OK_FILE, type: 'document' }] }, 'project_wrap');
    expect(type.isError).toBe(true);
    expect(type.text).toContain('"path": [\n      "files",\n      0,\n      "type"\n    ]');
    expect(type.text).toContain('type must be one of local_path, url, memory');
    const label = await checkpoint(mcp, { files: [OK_FILE, OK_FILE, { ...OK_FILE, label: 'y'.repeat(240) }] });
    expect(label.text).toContain('label is limited to 200 characters');
    expect(label.text).toContain('"path": [\n      "files",\n      2,\n      "label"\n    ]');
  });

  it('file rules only core knows name the file index and the rule', async () => {
    const mcp = await setup();
    const files = async (file: Record<string, unknown>) => refusal(await checkpoint(mcp, { files: [OK_FILE, file] }, 'project_wrap'));
    expect(await files({ ...OK_FILE, access: 'reported_available' }))
      .toBe('files[1] has access reported_available, so it needs checked_at: when you checked the file, as a UTC timestamp with milliseconds, e.g. 2026-09-28T10:00:00.000Z.');
    expect(await files({ ...OK_FILE, access: 'reported_available', checked_at: '2026-09-28T10:00:00Z', context: 'ls ok' }))
      .toBe('files[1].checked_at must be a UTC timestamp with milliseconds in exactly this form: 2026-09-28T10:00:00.000Z.');
    expect(await files({ ...OK_FILE, access: 'reported_available', checked_at: '2026-09-28T10:00:00.000Z' }))
      .toBe('files[1] has access reported_available, so it needs context: a short note on how you checked the file.');
    expect(await files({ ...OK_FILE, context: 'seen' }))
      .toBe('files[1] has access unverified; checked_at and context are allowed only when access is reported_available.');
    expect(await files({ ...OK_FILE, label: '   ' })).toBe('files[1].label must not be blank.');
    expect(await files({ ...OK_FILE, locator: '/tmp/a\n/tmp/b' })).toBe('files[1].locator must be a single line.');
  });
});

describe('F1: files replaces the earlier list', () => {
  it('omitted keeps it, a new list replaces it, an empty list clears it', async () => {
    const mcp = await setup();
    const valid = { ...OK_FILE, access: 'reported_available', checked_at: '2026-09-28T10:00:00.000Z', context: 'ls showed it' };
    let saved = JSON.parse((await checkpoint(mcp, { files: [valid] })).text) as Saved;
    expect(saved.current.files).toEqual([valid]);
    saved = JSON.parse((await checkpoint(mcp, {})).text) as Saved;
    expect(saved.current.files).toEqual([valid]);
    const other = { ...OK_FILE, type: 'url', label: 'spec', locator: 'https://example.com/spec' };
    saved = JSON.parse((await checkpoint(mcp, { files: [other] })).text) as Saved;
    expect(saved.current.files).toEqual([other]);
    saved = JSON.parse((await checkpoint(mcp, { files: [] })).text) as Saved;
    expect(saved.current.files).toEqual([]);
  });
});
