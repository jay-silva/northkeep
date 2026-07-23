import { describe, expect, it } from 'vitest';
import { announcementFor } from '../src/lib/announce';

/**
 * The de-dupe rule behind every VoiceOver announcement (invariant #6: degrade
 * loudly, now audibly). Guards against spamming the screen reader with an
 * unchanged value while still speaking on first appearance and on real changes.
 */
describe('announcementFor', () => {
  it('announces a value on first appearance (mount with content)', () => {
    expect(announcementFor('', 'Sync failed, subscription required')).toBe(
      'Sync failed, subscription required',
    );
    expect(announcementFor(null, 'Names could not be pseudonymized')).toBe(
      'Names could not be pseudonymized',
    );
  });

  it('stays silent when the value is unchanged', () => {
    expect(announcementFor('Not synced', 'Not synced')).toBeNull();
    // whitespace differences are not real changes
    expect(announcementFor('Not synced', '  Not synced  ')).toBeNull();
  });

  it('announces when the value changes', () => {
    expect(announcementFor('Syncing', 'Not synced')).toBe('Not synced');
  });

  it('says nothing for an empty or cleared value', () => {
    expect(announcementFor('Not synced', null)).toBeNull();
    expect(announcementFor('Not synced', '')).toBeNull();
    expect(announcementFor('Not synced', '   ')).toBeNull();
    expect(announcementFor(null, undefined)).toBeNull();
  });

  it('re-announces the same message after it was cleared (prev recorded as empty)', () => {
    // banner shows X -> hidden (caller records '') -> shows X again
    expect(announcementFor('', 'Degraded: Tier-2 unavailable')).toBe(
      'Degraded: Tier-2 unavailable',
    );
  });

  it('returns the trimmed message it will speak', () => {
    expect(announcementFor('', '  Conflict resolved  ')).toBe('Conflict resolved');
  });
});
