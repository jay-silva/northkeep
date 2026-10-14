import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KDF_INTERACTIVE, Vault, applyProjectUpdate, generateDeviceSecret } from '@northkeep/core';
import { filterProjectRows, passedLine, progressLine, projectDetail, projectRows } from '../src/lib/projects.js';
import { plantWorkingRow } from '../../../packages/core/test/support/plant-working-row.js';

/** ADR 0065 Decision 5, phone: list progress and a read-only milestone list, from a real vault. */

const PLAN = [
  '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)',
  '- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2025-10-09 (agent)',
  '- [ ] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash',
  '- [ ] M4 Financing pre-approval | test: pre-approval letter in hand',
].join('\n');

describe('phone milestones', () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nk-milestones-'));
    vault = Vault.create({ path: join(dir, 'v.nkv'), passphrase: 'test-passphrase', deviceSecret: Buffer.from(generateDeviceSecret()), kdf: KDF_INTERACTIVE });
  });
  afterEach(() => {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entries = () => vault.list().reverse();

  /** A project document with an optional Milestones section body, saved as the phone would receive it. */
  function writeProject(slug: string, milestones: string | null) {
    const base = applyProjectUpdate('', { project: slug, expected_revision: null, what_why: 'Why', status: `Status of ${slug}.` }).content;
    const content = milestones === null ? base : `${base}\n\n## Milestones\n\n${milestones}\n`;
    // Planted as a synced row: vault.remember refuses to create a project document (ADR 0065).
    plantWorkingRow(vault, { content, type: 'working', scope: `project:${slug}`, source: 'test' });
  }

  it('shows progress and the current milestone on each list row', () => {
    writeProject('str', PLAN);
    writeProject('done', '- [x] M1 Ship it | test: it ships | passed 2026-10-01 (you)');
    writeProject('plain', null);
    writeProject('oneoff', 'none: one-off task');
    writeProject('broken', '- [x] M1 Forged | test: t | passed 2026-10-01 (You)');
    const bySlug = Object.fromEntries(projectRows(entries()).map((r) => [r.slug, [r.progress, r.milestones]]));
    expect(bySlug).toEqual({
      str: ['2 of 4 · M3 Underwrite top 5 listings', { passed: 2, total: 4, current: { id: 'M3', title: 'Underwrite top 5 listings' } }],
      done: ['1 of 1 · All passed', { passed: 1, total: 1, current: null }],
      plain: ['No plan yet', null],
      oneoff: ['No plan yet', null],
      broken: ['No plan yet', null],
    });
  });

  it('does not count a project with no plan under Needs attention', () => {
    writeProject('plain', null);
    writeProject('str', PLAN);
    expect(filterProjectRows(projectRows(entries()), '', 'attention', 'recent')).toEqual([]);
  });

  it('shows no progress line on a project with two current documents', () => {
    writeProject('twice', PLAN);
    writeProject('twice', PLAN);
    expect(projectRows(entries()).map((r) => [r.slug, r.progress, r.milestones])).toEqual([['twice', null, null]]);
  });

  it('lists every milestone read-only on the project page, with who confirmed each pass', () => {
    writeProject('str', PLAN);
    const result = projectDetail(entries(), 'str', new Date('2026-10-14T12:00:00Z'));
    if (!result.ok) throw new Error(result.message);
    expect(result.detail.milestones).toEqual({
      kind: 'plan',
      passed: 2,
      total: 4,
      nowOn: 'M3',
      lines: [
        { id: 'M1', title: 'Define the buy box', mark: 'you', sub: 'Passed Sep 28 · you confirmed', label: 'M1 Define the buy box. Passed Sep 28, you confirmed.' },
        { id: 'M2', title: 'Shortlist 3 markets', mark: 'agent', sub: 'Passed Oct 9, 2025 · agent says you confirmed', label: 'M2 Shortlist 3 markets. Passed Oct 9, 2025, agent says you confirmed.' },
        {
          id: 'M3',
          title: 'Underwrite top 5 listings',
          mark: 'current',
          sub: 'Test: each has a pro forma with ADR, occupancy and cash-on-cash',
          label: 'M3 Underwrite top 5 listings. Current milestone. Test: each has a pro forma with ADR, occupancy and cash-on-cash.',
        },
        { id: 'M4', title: 'Financing pre-approval', mark: 'open', sub: null, label: 'M4 Financing pre-approval. Not started.' },
      ],
    });
  });

  it('says plainly when there is no plan, no plan on purpose, or a plan it cannot read', () => {
    writeProject('plain', null);
    writeProject('oneoff', 'none: one-off task');
    writeProject('broken', '- [x] M1 Forged | test: t | passed 2026-10-01 (You)');
    const view = (slug: string) => {
      const r = projectDetail(entries(), slug);
      if (!r.ok) throw new Error(r.message);
      return r.detail.milestones;
    };
    expect(view('plain')).toEqual({ kind: 'absent' });
    expect(view('oneoff')).toEqual({ kind: 'none', reason: 'one-off task' });
    expect(view('broken')).toEqual({ kind: 'unreadable' });
  });

  it('formats the list line and the pass line', () => {
    expect(progressLine(null)).toBe('No plan yet');
    expect(progressLine({ passed: 0, total: 5, current: { id: 'M1', title: 'Design and review' } })).toBe('0 of 5 · M1 Design and review');
    expect(passedLine('2026-01-02', 'you', 2026)).toBe('Passed Jan 2 · you confirmed');
    expect(passedLine('2026-12-31', 'agent', 2027)).toBe('Passed Dec 31, 2026 · agent says you confirmed');
  });
});

describe('phone stays view-only for milestones', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  it('the project screens and their data module call no vault or milestone write', () => {
    const files = ['app/projects.tsx', 'app/project/[slug].tsx', 'src/lib/projects.ts', 'src/MilestoneTrack.tsx'];
    const writes = /\b(remember|editMemory|forget|updateProject|checkpointProject|replaceProjectContent|confirmPass|confirmPassInDocument|recordAgentPass|replacePlan|formatMilestones?)\b/;
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect([file, writes.exec(source)?.[0] ?? null]).toEqual([file, null]);
    }
  });
});
