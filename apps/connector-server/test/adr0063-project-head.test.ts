import { describe, expect, it } from 'vitest';
import { projectScopeView, staleProjectRowIds } from '../src/project-head.js';
import type { SharedEntry } from '../src/storage.js';

/** ADR 0063 D2 over decrypted rows: which document is served, which are stale. */

function r(entryId: string, extra: Partial<SharedEntry>): SharedEntry {
  return { entryId, scope: 'project:a', type: 'working', content: entryId, createdAt: '2026-09-30T00:00:00.000Z', ...extra };
}

function summary(rows: SharedEntry[]) {
  const v = projectScopeView(rows);
  return { head: v.head.kind === 'head' ? v.head.row.entryId : v.head.kind, stale: [...v.stale].sort() };
}

describe('ADR 0063 projectScopeView', () => {
  it('serves the pushed head over a pending row based on an older head, and marks that row stale', () => {
    expect(
      summary([
        r('R2', { writeSeq: 3 }),
        r('conn_old', { pending: true, baseRevision: 'R1', writeSeq: 2 }),
      ]),
    ).toEqual({ head: 'R2', stale: ['conn_old'] });
  });

  it('serves a current pending row, and never reads created_at', () => {
    expect(
      summary([
        r('R1', { writeSeq: 1, createdAt: '2030-01-01T00:00:00.000Z' }),
        r('conn_c', { pending: true, baseRevision: 'R1', writeSeq: 2, createdAt: '2000-01-01T00:00:00.000Z' }),
      ]),
    ).toEqual({ head: 'conn_c', stale: [] });
  });

  it('holds every legacy row: no base is never current, with or without a pushed head', () => {
    expect(summary([r('P', { writeSeq: 0 }), r('conn_leg', { pending: true, writeSeq: 0 })])).toEqual({
      head: 'P',
      stale: ['conn_leg'],
    });
    expect(summary([r('conn_leg', { pending: true })])).toEqual({ head: 'none', stale: ['conn_leg'] });
  });

  it('a base-new row is current only while there is no pushed head', () => {
    expect(summary([r('conn_new', { pending: true, baseRevision: 'new', writeSeq: 1 })])).toEqual({ head: 'conn_new', stale: [] });
    expect(summary([r('P', { writeSeq: 2 }), r('conn_new', { pending: true, baseRevision: 'new', writeSeq: 1 })])).toEqual({
      head: 'P',
      stale: ['conn_new'],
    });
  });

  it('the acked row outranks the old pushed row by write_seq; a tie at the top is several heads', () => {
    expect(summary([r('P1', { writeSeq: 1 }), r('H2', { writeSeq: 3 })])).toEqual({ head: 'H2', stale: [] });
    expect(
      summary([r('A', { writeSeq: 4 }), r('B', { writeSeq: 4 }), r('conn_x', { pending: true, baseRevision: 'A', writeSeq: 5 })]),
    ).toEqual({ head: 'several', stale: ['conn_x'] });
  });

  it('ignores non-working rows; staleProjectRowIds skips non-project scopes', () => {
    expect(summary([r('arch', { type: 'episodic', pending: true })])).toEqual({ head: 'none', stale: [] });
    expect(
      [...staleProjectRowIds([
        r('P', { writeSeq: 2 }),
        r('conn_s', { pending: true, baseRevision: 'P0', writeSeq: 1 }),
        r('note', { scope: 'work', pending: true, writeSeq: 1 }),
        r('conn_w', { scope: 'project:foo_bar', pending: true }),
      ])],
    ).toEqual(['conn_s']);
  });
});
