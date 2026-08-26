import { describe, expect, it } from 'vitest';
import {
  findTombstoneConflicts,
  isTombstoneEnforceOn,
  parseSharedAtMap,
  parseUtcMs,
  shouldKeepTombstone,
  TOMBSTONE_USER_MESSAGE,
} from '../src/tombstones.js';

describe('tombstone helpers', () => {
  it('enforcement is off unless the env is an explicit on-value', () => {
    expect(isTombstoneEnforceOn({})).toBe(false);
    expect(isTombstoneEnforceOn({ CONNECTOR_TOMBSTONE_ENFORCE: '0' })).toBe(false);
    expect(isTombstoneEnforceOn({ CONNECTOR_TOMBSTONE_ENFORCE: 'false' })).toBe(false);
    expect(isTombstoneEnforceOn({ CONNECTOR_TOMBSTONE_ENFORCE: '1' })).toBe(true);
    expect(isTombstoneEnforceOn({ CONNECTOR_TOMBSTONE_ENFORCE: 'true' })).toBe(true);
  });

  it('finds no conflict when the scope was never unshared', () => {
    expect(findTombstoneConflicts([], ['work'], {})).toEqual([]);
    expect(findTombstoneConflicts([], ['work'], { work: '2026-01-01T00:00:00.000Z' })).toEqual([]);
  });

  it('tombstone + missing shared_at is a conflict; newer shared_at is not', () => {
    const tombs = [{ scope: 'work', unsharedAt: '2026-06-01T12:00:00.000Z' }];
    expect(findTombstoneConflicts(tombs, ['work'], {})).toEqual(['work']);
    expect(findTombstoneConflicts(tombs, ['work'], { work: '2026-05-01T00:00:00.000Z' })).toEqual(['work']);
    expect(findTombstoneConflicts(tombs, ['work'], { work: '2026-06-01T12:00:00.000Z' })).toEqual(['work']);
    expect(findTombstoneConflicts(tombs, ['work'], { work: '2026-06-01T12:00:00.001Z' })).toEqual([]);
  });

  it('names every conflicting scope and ignores unrelated tombstones', () => {
    const tombs = [
      { scope: 'work', unsharedAt: '2026-06-01T00:00:00.000Z' },
      { scope: 'personal', unsharedAt: '2026-06-01T00:00:00.000Z' },
    ];
    expect(findTombstoneConflicts(tombs, ['work', 'ops'], {})).toEqual(['work']);
    expect(findTombstoneConflicts(tombs, ['work', 'personal'], {})).toEqual(['personal', 'work']);
  });

  it('keeps a tombstone when unshared_at is strictly after the accepted share', () => {
    expect(shouldKeepTombstone('2026-06-02T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(true);
    expect(shouldKeepTombstone('2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(false);
    expect(shouldKeepTombstone('2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(false);
    expect(shouldKeepTombstone('nope', '2026-06-01T00:00:00.000Z')).toBe(true);
  });

  it('parses UTC instants, not string order', () => {
    const early = parseUtcMs('2026-01-01T00:00:00.000Z');
    const late = parseUtcMs('2026-01-01T00:00:00+00:00');
    expect(early).not.toBeNull();
    expect(late).toBe(early);
    expect(parseUtcMs('not-a-date')).toBeNull();
  });

  it('parseSharedAtMap keeps only string values', () => {
    expect(parseSharedAtMap({ work: '2026-01-01T00:00:00.000Z', skip: 1, extra: null })).toEqual({
      work: '2026-01-01T00:00:00.000Z',
    });
    expect(parseSharedAtMap(['work'])).toEqual({});
    expect(TOMBSTONE_USER_MESSAGE).not.toContain('\u2014');
  });
});
