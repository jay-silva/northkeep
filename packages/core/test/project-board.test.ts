/**
 * ADR 0054 Decision 1 and 3 over the pure functions: the Done rule in both
 * directions, the date sweep (nearest-year resolution, impossible dates),
 * fence removal to a fixed point, caps, sorting, needs repair and imported
 * aging. Vault-backed checks at the end use a temp directory only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import {
  BOARD_DONE_RULE,
  BOARD_SECTION_CAP,
  buildBoard,
  datedItems,
  isProjectDone,
  newestLogDate,
  sweepDates,
  tameBoardText,
  type BoardView,
} from '../src/project-board.js';
import { getProjectView, listProjectViews, type ProjectSummary } from '../src/project-handoff.js';
import { planImport } from '../src/project-import.js';
import { Vault } from '../src/vault.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');

function summary(extra: Partial<ProjectSummary>): ProjectSummary {
  return { project: 'demo', scope: 'project:demo', title: null, status: 'Working.', revision: 'r1', updated_at: '2026-09-22T10:00:00.000Z', conflict: false, last_writer_host: null, draft: false, imported: false, ...extra };
}
function view(extra: Partial<BoardView> = {}): BoardView {
  return { status: 'Working.', next_actions: '', open_questions: '', log: '', ...extra };
}

describe('the Done rule', () => {
  it('counts the bare word followed by end or . : !', () => {
    for (const s of ['Done.', 'Complete: shipped 2026-09-01', 'DONE', 'done', 'Completed!', '\n\n  Done  \nmore']) {
      expect(isProjectDone(s), s).toBe(true);
    }
  });
  it('does not count a sentence that starts with the word', () => {
    for (const s of ['Done with phase 1; phase 2 blocked', 'Complete rewrite in progress', 'Finished the migration', 'Doneness unclear', '- Done.', 'Not done.', '']) {
      expect(isProjectDone(s), s).toBe(false);
    }
  });
  it('reads the first line on every terminator, not only \\n', () => {
    expect(isProjectDone('Done.\u2028Reopened later')).toBe(true);
    expect(isProjectDone('Done with it\u0085x')).toBe(false);
  });
});

describe('the date sweep', () => {
  it('Sep 20 read on 2026-09-23 is 2026-09-20', () => {
    expect(sweepDates('- Sep 20 file the renewal', NOW)).toEqual(['2026-09-20']);
  });
  it('Jan 5 read on 2026-12-20 is 2027-01-05', () => {
    expect(sweepDates('Jan 5 call the bank', new Date('2026-12-20T09:00:00.000Z'))).toEqual(['2027-01-05']);
  });
  it('Dec 30 read on 2027-01-02 is last year', () => {
    expect(sweepDates('Dec 30 renewal', new Date('2027-01-02T09:00:00.000Z'))).toEqual(['2026-12-30']);
  });
  it('rejects impossible dates, ISO and month-name', () => {
    expect(sweepDates('2026-02-30 and 2026-13-01 and Feb 30 and Sep 31, 2026', NOW)).toEqual([]);
  });
  it('Feb 29 without a year resolves to the nearest year that has one', () => {
    expect(sweepDates('Feb 29', new Date('2027-09-01T00:00:00.000Z'))).toEqual(['2028-02-29']);
  });
  it('matches ISO, full and abbreviated names, ordinals and explicit years, in line order', () => {
    expect(sweepDates('by 2026-10-15, then September 3rd, 2027 and Sept. 4 and Oct 1 2026', NOW))
      .toEqual(['2026-10-15', '2027-09-03', '2026-09-04', '2026-10-01']);
  });
  it('ignores lowercase month words, digits glued to letters, and numbers that are not days', () => {
    expect(sweepDates('we may 5 times; May 5pm; Sep 2026; 12026-10-15; Mayday 3', NOW)).toEqual([]);
  });
});

describe('text made safe', () => {
  it('removes nested and assembled fence markers to a fixed point', () => {
    const nested = '===END ===END MEMORY DATA===MEMORY DATA=== ok';
    expect(tameBoardText(nested, 160)).toBe('ok');
    const assembled = `===BEGIN MEMORY DA\u200BTA=== ok ===END MEMORY DATA\u2028===`;
    expect(tameBoardText(assembled, 160)).toBe('ok');
  });
  it('strips Cc, Cf, separators and lone surrogates and cuts without splitting a pair', () => {
    const hostile = `\u001b[31mred\r\u2028x\u0085\u202Ey\uD800z`;
    expect(tameBoardText(hostile, 160)).toBe('[31mredxyz');
    expect(tameBoardText('a😀b', 2)).toBe('a');
  });
  it('the dated line is cut to 160 before the sweep, so a date past the cut is not reported', () => {
    const rows = datedItems('p', { next_actions: `${'x'.repeat(170)} 2026-10-01`, open_questions: '- 2026-10-02 early' }, NOW);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-02']);
    expect(rows.every((r) => r.line.length <= 160)).toBe(true);
  });
  it('one row per match: a repeated line or a repeated date is not collapsed', () => {
    const rows = datedItems('p', { next_actions: '- 2026-10-01 a\n- 2026-10-01 a\nOct 1 or 2026-10-01', open_questions: '' }, NOW);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-01', '2026-10-01', '2026-10-01']);
  });
  it('splits Next Actions on every terminator', () => {
    const rows = datedItems('p', { next_actions: 'a 2026-10-01\u2028b 2026-10-02\u0085c 2026-10-03\rd 2026-10-04', open_questions: '' }, NOW);
    expect(rows.map((r) => r.line)).toEqual(['a 2026-10-01', 'b 2026-10-02', 'c 2026-10-03', 'd 2026-10-04']);
  });
});

describe('buildBoard', () => {
  it('states the Done rule and leaves Done projects out of Stale', () => {
    const board = buildBoard({
      summaries: [summary({ project: 'a', updated_at: '2026-01-01T00:00:00.000Z' }), summary({ project: 'b', updated_at: '2026-01-01T00:00:00.000Z' })],
      views: new Map([['a', view({ status: 'Done.' })], ['b', view({ status: 'Done with phase 1' })]]),
      now: NOW, staleDays: 14, openSessions: new Map(),
    });
    expect(board.done_rule).toBe(BOARD_DONE_RULE);
    expect(board.stale.rows.map((r) => r.project)).toEqual(['b']);
  });

  it('stale means strictly more than N days, oldest first, ties by slug', () => {
    const at = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
    const board = buildBoard({
      summaries: [summary({ project: 'edge', updated_at: at(14) }), summary({ project: 'z', updated_at: at(20) }), summary({ project: 'y', updated_at: at(20) }), summary({ project: 'old', updated_at: at(30) })],
      views: new Map(['edge', 'z', 'y', 'old'].map((p) => [p, view()])),
      now: NOW, staleDays: 14, openSessions: new Map(),
    });
    expect(board.stale.rows.map((r) => r.project)).toEqual(['old', 'y', 'z']);
    expect(board.stale.rows[0]).toMatchObject({ activity_source: 'last write', status: 'Working.' });
  });

  it('ages an imported head from its newest Log date, and from the import only when no entry is dated', () => {
    const importedAt = NOW.toISOString();
    const board = buildBoard({
      summaries: [summary({ project: 'dated', imported: true, updated_at: importedAt }), summary({ project: 'undated', imported: true, updated_at: importedAt })],
      views: new Map([
        ['dated', view({ log: '- 2026-08-14 (Agent) - older\n- **2026-07-01** oldest\nnot an entry 2026-09-22' })],
        ['undated', view({ log: '- no date here' })],
      ]),
      now: NOW, staleDays: 14, openSessions: new Map(),
    });
    expect(board.stale.rows).toEqual([{ project: 'dated', last_activity: '2026-08-14', activity_source: 'last log entry', status: 'Working.' }]);
  });

  it('lists conflicted and unreadable projects under needs repair only', () => {
    const board = buildBoard({
      summaries: [summary({ project: 'c', conflict: true, updated_at: null, revision: null, status: null }), summary({ project: 'u', draft: true, updated_at: '2026-01-01T00:00:00.000Z' }), summary({ project: 'ok', draft: true })],
      views: new Map([['ok', view({ next_actions: '- 2026-10-01 x' })]]),
      now: NOW, staleDays: 0, openSessions: new Map([['u', [{ session_id: 's', host: 'h', opened_at: 'o', last_read_at: 'l' }]]]),
    });
    expect(board.needs_repair.rows).toEqual([{ project: 'c', reason: 'conflict' }, { project: 'u', reason: 'unreadable' }]);
    expect(board.drafts.rows).toEqual([{ project: 'ok', updated_at: '2026-09-22T10:00:00.000Z' }]);
    expect(board.stale.rows.map((r) => r.project)).toEqual(['ok']);
    expect(board.dated.rows.map((r) => r.project)).toEqual(['ok']);
    expect(board.open_sessions).toEqual({ total: 0, shown: 0, rows: [] });
  });

  it('caps every section at 50 rows and states the total', () => {
    const n = 70;
    const slugs = Array.from({ length: n }, (_, i) => `p${String(i).padStart(3, '0')}`);
    const board = buildBoard({
      summaries: slugs.map((p) => summary({ project: p, draft: true, updated_at: '2026-01-01T00:00:00.000Z' })),
      views: new Map(slugs.map((p) => [p, view({ next_actions: '- 2026-10-01 a' })])),
      now: NOW, staleDays: 14,
      openSessions: new Map(slugs.map((p, i) => [p, [0, 1, 2, 3].map((k) => ({ session_id: `${p}-${k}`, host: 'h', opened_at: 'o', last_read_at: `2026-09-${String(10 + (i % 10)).padStart(2, '0')}T00:00:0${k}.000Z` }))])),
    });
    for (const s of [board.stale, board.dated, board.drafts] as const) expect([s.total, s.shown, s.rows.length]).toEqual([n, BOARD_SECTION_CAP, BOARD_SECTION_CAP]);
    const open = board.open_sessions as { total: number; shown: number; rows: Array<{ last_read_at: string }> };
    expect([open.total, open.shown]).toEqual([n * 3, BOARD_SECTION_CAP]);
    expect(open.rows[0]!.last_read_at >= open.rows[49]!.last_read_at).toBe(true);
  });

  it('dated items sort by date, then slug, then line, and read Open Questions too', () => {
    const board = buildBoard({
      summaries: [summary({ project: 'b' }), summary({ project: 'a' })],
      views: new Map([['b', view({ next_actions: '- 2026-10-15 renew', open_questions: 'Oct 1 ask?' })], ['a', view({ next_actions: '- 2026-10-15 alpha' })]]),
      now: NOW, staleDays: 14, openSessions: new Map(),
    });
    expect(board.dated.rows).toEqual([
      { date: '2026-10-01', project: 'b', line: 'Oct 1 ask?' },
      { date: '2026-10-15', project: 'a', line: '- 2026-10-15 alpha' },
      { date: '2026-10-15', project: 'b', line: '- 2026-10-15 renew' },
    ]);
  });

  it('an unavailable call log is stated, never an empty list', () => {
    const board = buildBoard({ summaries: [summary({})], views: new Map([['demo', view()]]), now: NOW, staleDays: 14, openSessions: { unavailable: 'The call log exists but could not be read.' } });
    expect(board.open_sessions).toEqual({ unavailable: 'The call log exists but could not be read.' });
    expect(board.stale.total).toBe(0);
  });

  it('refuses a stale window outside 0 to 3650', () => {
    for (const d of [-1, 1.5, 3651]) expect(() => buildBoard({ summaries: [], views: new Map(), now: NOW, staleDays: d, openSessions: new Map() })).toThrow(RangeError);
  });

  it('core imports no model, fetch or network module', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'project-board.ts'), 'utf8');
    expect(src).not.toMatch(/ollama|fetch\(|node:http|node:net|librarian/i);
    expect([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['./project-doc.js', './project-handoff.js', './project-import.js', './text-safe.js']);
  });

  it('newestLogDate reads dash and bold entries and ignores prose dates', () => {
    expect(newestLogDate('- 2026-01-01 a\n**2026-03-01** b\nsee 2026-09-01')).toBe('2026-03-01');
    expect(newestLogDate('')).toBeNull();
  });
});

describe('imported on a real vault', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-board-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a head written by import is imported until the first ordinary write, and ages from its Log', () => {
    const v = Vault.create({ path: path.join(dir, 'v.nkv'), passphrase: 'synthetic board passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
    try {
      const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
      const plan = planImport([{ name: 'aged.md', text: `# Aged\n\n## What & Why\n\nWhy.\n\n## Current Status\n\nQuiet.\n\n## Log\n\n- ${old} - last real work\n` }]);
      expect(plan.projects).toHaveLength(1);
      v.importProject(plan.projects[0]!);
      const [s] = listProjectViews(v);
      expect(s).toMatchObject({ project: 'aged', imported: true });
      const board = buildBoard({ summaries: [s!], views: new Map([['aged', getProjectView(v, 'aged')]]), now: new Date(), staleDays: 14, openSessions: new Map() });
      expect(board.stale.rows).toEqual([{ project: 'aged', last_activity: old, activity_source: 'last log entry', status: 'Quiet.' }]);
      v.updateProject({ project: 'aged', expected_revision: s!.revision, status: 'Moving again.' });
      expect(listProjectViews(v)[0]).toMatchObject({ imported: false });
      v.remember({ content: 'x', type: 'working', scope: 'project:aged' });
      expect(listProjectViews(v)[0]).toMatchObject({ conflict: true, imported: false });
    } finally { v.close(); }
  });
});
