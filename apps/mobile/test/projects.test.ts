import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KDF_INTERACTIVE,
  PROJECT_PROVENANCE_METADATA_KEY,
  Vault,
  applyProjectUpdate,
  generateDeviceSecret,
  listProjectViews,
} from '@northkeep/core';
import { entriesReader, filterProjectRows, projectDetail, projectRows, textBlocks, updatedLabel } from '../src/lib/projects.js';
import { DEMO_PASSPHRASE, demoSeed } from '../src/lib/demo-vault.js';

/**
 * The Projects tab's data mapping, driven through a real Vault the way the
 * phone's session builds its entries list (vault.list().reverse()).
 */
function provenance(host: string) {
  return {
    [PROJECT_PROVENANCE_METADATA_KEY]: {
      version: 1,
      host,
      host_version: null,
      model: null,
      session_id: '11111111-1111-4111-8111-111111111111',
      recorded_at: '2026-09-01T00:00:00.000Z',
    },
  };
}

describe('projects data mapping', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nk-projects-'));
    vault = Vault.create({
      path: join(dir, 'v.nkv'),
      passphrase: 'test-passphrase',
      deviceSecret: Buffer.from(generateDeviceSecret()),
      kdf: KDF_INTERACTIVE,
    });
  });
  afterEach(() => {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entries = () => vault.list().reverse();

  function writeProject(slug: string, status: string, extra: Record<string, unknown> = {}) {
    const content = applyProjectUpdate(
      '',
      { project: slug, expected_revision: null, what_why: `Why ${slug}`, status },
      new Date('2026-09-01T00:00:00.000Z'),
    ).content;
    // created_at has millisecond resolution; step past it so "newest" is unambiguous.
    const start = Date.now();
    while (Date.now() <= start + 1) { /* wait */ }
    return vault.remember({ content, type: 'working', scope: `project:${slug}`, source: 'test', ...extra });
  }

  it('lists projects newest first, with status line, app name, and nothing else from the vault', () => {
    vault.remember({ content: 'A plain memory', type: 'semantic', scope: 'personal' });
    vault.remember({ content: 'Not a project doc', type: 'episodic', scope: 'project:alpha' });
    vault.remember({ content: '## Current Status\n\nbad slug', type: 'working', scope: 'project:Bad_Slug' });
    writeProject('alpha', 'Alpha is going fine.\nSecond line.', { metadata: provenance('Claude') });
    writeProject('beta', 'Beta just started.');

    const rows = projectRows(entries());
    // beta was written last, so its created_at is newest.
    expect(rows.map((r) => r.slug)).toEqual(['beta', 'alpha']);
    expect(rows[1]).toMatchObject({
      slug: 'alpha',
      name: 'alpha',
      statusLine: 'Alpha is going fine.',
      updatedAt: rows[1]!.updatedAt,
      appName: 'Claude',
      notes: [],
    });
    expect(rows[0]!.appName).toBeNull();
    expect(rows[0]!.statusLine).toBe('Beta just started.');
  });

  it('puts a project with two current documents first, with a plain note', () => {
    writeProject('alpha', 'One');
    writeProject('alpha', 'Two');
    writeProject('beta', 'Fine');
    const rows = projectRows(entries());
    expect(rows.map((r) => [r.slug, r.statusLine, r.updatedAt, r.notes])).toEqual([
      ['alpha', 'More than one version is saved', null, ['Open NorthKeep on your Mac to choose which version to keep.']],
      ['beta', 'Fine', rows[1]!.updatedAt, []],
    ]);
    expect(projectDetail(entries(), 'alpha')).toEqual({
      ok: false,
      message: 'More than one version of this project is saved. Open NorthKeep on your Mac to choose which one to keep.',
    });
  });

  it('reads the same projects core reads from the real vault', () => {
    writeProject('alpha', 'A', { metadata: provenance('Codex') });
    writeProject('beta', 'B');
    vault.remember({ content: 'x', type: 'semantic', scope: 'work' });
    expect(listProjectViews(entriesReader(entries()))).toEqual(listProjectViews(vault));
  });

  it('searches full saved status and actions, filters verified local states, and sorts by name', () => {
    writeProject('zebra', 'First line.\nHidden search phrase.');
    const content = applyProjectUpdate('', { project: 'alpha', expected_revision: null, title: 'Alpine', status: 'Ready', next_actions: '- First action\n- Find the chart', draft: true }).content;
    vault.remember({ type: 'working', scope: 'project:alpha', content });
    writeProject('conflict', 'One'); writeProject('conflict', 'Two');
    const rows = projectRows(entries());
    expect(filterProjectRows(rows, 'hidden search', 'all', 'recent').map(r => r.slug)).toEqual(['zebra']);
    expect(filterProjectRows(rows, 'chart', 'all', 'recent').map(r => r.slug)).toEqual(['alpha']);
    expect(filterProjectRows(rows, '', 'draft', 'recent').map(r => r.slug)).toEqual(['alpha']);
    expect(filterProjectRows(rows, '', 'attention', 'recent').map(r => r.slug)).toEqual(['conflict']);
    expect(filterProjectRows(rows, '', 'all', 'name').map(r => r.slug)).toEqual(['conflict', 'alpha', 'zebra']);
    expect(filterProjectRows(rows, '', 'all', 'recent')[0]!.slug).toBe('conflict');
    expect(rows.find(r => r.slug === 'alpha')?.nextAction).toBe('First action');
    expect(rows.find(r => r.slug === 'conflict')?.nextAction).toBe('Choose a version first');
  });

  it('refuses a list filter it does not understand', () => {
    expect(() => entriesReader([]).list({ bogus: true } as never)).toThrow('does not support the "bogus" filter');
  });

  it('maps the detail sections, with the Log newest first', () => {
    let content = applyProjectUpdate(
      '',
      {
        project: 'alpha',
        expected_revision: null,
        title: 'Alpha Project',
        what_why: 'Because.',
        status: 'Working on it.',
        next_actions: '- First\n- Second',
        open_questions: 'Is it done?',
        decision: 'Use SQLite.',
        log_entry: 'Older entry.',
        files: [{ type: 'url', label: 'Spec', locator: 'https://example.com/spec', access: 'unverified' }],
      },
      new Date('2026-09-01T00:00:00.000Z'),
    ).content;
    content = applyProjectUpdate(
      content,
      { project: 'alpha', expected_revision: 'x', log_entry: 'Newer entry.' },
      new Date('2026-09-05T00:00:00.000Z'),
    ).content;
    vault.remember({ content, type: 'working', scope: 'project:alpha', metadata: provenance('Claude') });

    const result = projectDetail(entries(), 'alpha');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { updatedAt, ...rest } = result.detail;
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rest).toEqual({
      slug: 'alpha',
      name: 'Alpha Project',
      appName: 'Claude',
      draft: false,
      whatWhy: [{ kind: 'paragraph', text: 'Because.' }],
      status: [{ kind: 'paragraph', text: 'Working on it.' }],
      nextActions: [
        { kind: 'item', text: 'First' },
        { kind: 'item', text: 'Second' },
      ],
      decisions: [{ kind: 'item', text: '2026-09-01 - Use SQLite.' }],
      openQuestions: [{ kind: 'paragraph', text: 'Is it done?' }],
      log: ['2026-09-05 - Newer entry.', '2026-09-01 - Older entry.'],
      files: [{ type: 'url', label: 'Spec', locator: 'https://example.com/spec', access: 'unverified' }],
      filesText: null,
    });
  });

  it('says a missing or malformed slug is not on this phone', () => {
    const expected = { ok: false, message: 'That project is not on this phone. Pull down on Memories to sync.' };
    expect(projectDetail(entries(), 'nope')).toEqual(expected);
    expect(projectDetail(entries(), '../etc')).toEqual(expected);
  });

  it('tells the user to fix a document with duplicate sections on the Mac', () => {
    vault.remember({
      content: '## Current Status\n\nA\n\n## Current Status\n\nB',
      type: 'working',
      scope: 'project:dup',
    });
    expect(projectDetail(entries(), 'dup')).toEqual({
      ok: false,
      message: 'This project document cannot be read here. Open it on your Mac to fix it.',
    });
  });
});

describe('textBlocks', () => {
  it('splits bullets from paragraphs and keeps indented continuations with their item', () => {
    expect(textBlocks('Intro line\nmore intro\n\n- one\n  still one\n* two\n1. three\n\nClosing.')).toEqual([
      { kind: 'paragraph', text: 'Intro line\nmore intro' },
      { kind: 'item', text: 'one\nstill one' },
      { kind: 'item', text: 'two' },
      { kind: 'item', text: 'three' },
      { kind: 'paragraph', text: 'Closing.' },
    ]);
    expect(textBlocks('')).toEqual([]);
  });
});

describe('updatedLabel', () => {
  it('shows the day, or a plain unknown', () => {
    expect(updatedLabel('2026-09-27T15:00:00.000Z')).toBe('Updated 2026-09-27');
    expect(updatedLabel(null)).toBe('Update time unknown');
  });
});

describe('demo project', () => {
  it('shows exactly one synthetic project in the demo vault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-demo-proj-'));
    try {
      const vault = Vault.create({
        path: join(dir, 'demo.nkv'),
        passphrase: DEMO_PASSPHRASE,
        deviceSecret: Buffer.from(generateDeviceSecret()),
        kdf: KDF_INTERACTIVE,
      });
      for (const memory of demoSeed()) vault.remember(memory);
      const entries = vault.list().reverse();
      vault.close();

      const rows = projectRows(entries);
      expect(rows).toMatchObject([
        {
          slug: 'lantern-demo',
          name: 'Lantern (demo project)',
          statusLine: 'Offline sync works on one device. Next up: merging edits made on two devices.',
          updatedAt: rows[0]!.updatedAt,
          appName: 'Claude (demo)',
          notes: [],
        },
      ]);
      const detail = projectDetail(entries, 'lantern-demo');
      if (!detail.ok) throw new Error(detail.message);
      expect(detail.detail.log).toEqual([
        '2026-09-27 - Offline sync working on one device.',
        '2026-09-20 - Started the project and wrote down the goal.',
      ]);
      expect(detail.detail.decisions.map((b) => b.text)).toEqual([
        '2026-09-20 - Store notes as plain Markdown files so they stay readable without the app.',
        '2026-09-27 - Sync only when the phone is on Wi-Fi, to save data.',
      ]);
      expect(detail.detail.nextActions).toHaveLength(3);
      expect(detail.detail.files.map((f) => f.label)).toEqual(['Sync design notes (example)']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
