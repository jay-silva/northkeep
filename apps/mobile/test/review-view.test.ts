import { describe, expect, it } from 'vitest';
import {
  REVIEW_EMPTY_ACCEPTED,
  acceptedLead,
  answerAppLine,
  answerYesLine,
  buttonLabels,
  chatSinceLine,
  checkedLine,
  reportedAnswer,
  reportedLead,
  retiredLabel,
  clockTime,
  dayLabel,
  hiddenLine,
  reviewHeading,
  shortDate,
  sourceLines,
  tabBadge,
  tabLabel,
  waitingOnMacLine,
  yesLine,
} from '../src/lib/review-view';
import { badgeNumber } from '../src/lib/app-badge';

/** ADR 0095 section 2: the Review tab's fixed words. Dates are built in local time, as the phone reads them. */

const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe('the Review tab copy', () => {
  it('names each kind of request and what its buttons do', () => {
    expect([reviewHeading('replace'), reviewHeading('forget')]).toEqual(['Replace a memory?', 'Forget a memory?']);
    expect(buttonLabels('replace')).toEqual({ yes: 'Replace', no: 'Keep both', later: 'Not now' });
    expect(buttonLabels('forget')).toEqual({ yes: 'Forget', no: 'Keep it', later: 'Not now' });
    expect(yesLine('replace')).toBe('Yes marks Old as replaced by New. You can undo this.');
    expect(yesLine('forget')).toBe('Yes forgets this memory on all your devices. This cannot be undone.');
  });

  it('shows the app as a value after "App:", with when the new memory arrived', () => {
    expect(sourceLines({ kind: 'replace', app: 'Pier Helper', arrived: local(2026, 11, 24), not_shared_now: false })).toEqual(['App: Pier Helper (as the app reported) · arrived Nov 24']);
    expect(sourceLines({ kind: 'replace', app: 'a connected app', arrived: null, not_shared_now: false })).toEqual(['App: a connected app (as the app reported)']);
  });

  it('says a forget names no app, and adds a line when its collection is no longer shared', () => {
    expect(sourceLines({ kind: 'forget', app: null, arrived: null, not_shared_now: false })).toEqual(['Asked by a connected app. NorthKeep does not record which one or when.']);
    expect(sourceLines({ kind: 'forget', app: null, arrived: null, not_shared_now: true })).toEqual([
      'Asked by a connected app. NorthKeep does not record which one or when.',
      'Asked while this collection was shared with your apps. It is not shared now.',
    ]);
  });

  it('formats times and days in the phone\'s own zone', () => {
    expect(shortDate(local(2026, 11, 4))).toBe('Nov 4');
    expect([clockTime(local(2026, 11, 26, 15, 12)), clockTime(local(2026, 11, 26, 0, 5)), clockTime(local(2026, 11, 26, 12, 0))]).toEqual(['3:12 PM', '12:05 AM', '12:00 PM']);
    expect(checkedLine(local(2026, 11, 26, 15, 12))).toBe('Checked 3:12 PM. Pull down to check again.');
    expect(checkedLine(null)).toBe('Pull down to check.');
    const now = new Date(2026, 10, 26, 18, 0);
    expect([dayLabel(local(2026, 11, 26, 9), now), dayLabel(local(2026, 11, 22), now)]).toEqual(['Today', 'Nov 22']);
    expect([shortDate('nonsense'), clockTime('nonsense')]).toEqual(['', '']);
  });

  it('counts what is hidden and what waits for the Mac, and says nothing at zero', () => {
    expect([waitingOnMacLine(0), waitingOnMacLine(1), waitingOnMacLine(3)]).toEqual([null, '1 change to a project waits for your Mac.', '3 changes to projects wait for your Mac.']);
    expect([hiddenLine(0), hiddenLine(1), hiddenLine(2)]).toEqual([null, '1 item is hidden until tomorrow because you chose Not now.', '2 items are hidden until tomorrow because you chose Not now.']);
    expect([acceptedLead({ state: 'applied' }), acceptedLead({ state: 'undone' })]).toEqual(['You said yes on this phone', 'Undone']);
  });

  it('shows the tab count only above zero, caps it, and reads it aloud', () => {
    expect([tabBadge(0), tabBadge(-2), tabBadge(3), tabBadge(120), tabBadge(Number.NaN)]).toEqual([null, null, '3', '99+', null]);
    expect([tabLabel(0), tabLabel(1), tabLabel(3)]).toEqual(['Review', 'Review, 1 needs your yes', 'Review, 3 need your yes']);
    expect([badgeNumber(0), badgeNumber(-1), badgeNumber(4.9), badgeNumber(5000), badgeNumber(Number.NaN)]).toEqual([0, 0, 4, 999, 0]);
  });

  it('words an answer an app reported as a report, never as what the person said (ADR 0092)', () => {
    expect(reviewHeading('answer')).toBe('Settle a disagreement?');
    expect(buttonLabels('answer')).toEqual({ yes: 'Yes, apply it', no: 'No', later: 'Not now' });
    expect(reportedLead('Cloud Two')).toBe('Cloud Two (as the app reported) reported you said:');
    expect((['first', 'second', 'both', 'neither'] as const).map(reportedAnswer)).toEqual([
      'Reported answer: 1 is right.',
      'Reported answer: 2 is right.',
      'Reported answer: both are right.',
      'Reported answer: neither; it reported the right fact as:',
    ]);
    expect(answerYesLine('second')).toBe('Yes marks 2 as confirmed by you and 1 as replaced by it. You can undo this.');
    expect([chatSinceLine(0), chatSinceLine(Number.NaN), chatSinceLine(1), chatSinceLine(3)]).toEqual([
      null,
      null,
      '1 answer was accepted in chat since you last looked. It is under Accepted lately, with an Undo.',
      '3 answers were accepted in chat since you last looked. They are under Accepted lately, each with an Undo.',
    ]);
    expect([
      acceptedLead({ kind: 'answer', by: 'chat', state: 'applied' }),
      acceptedLead({ kind: 'answer', by: 'chat', state: 'both' }),
      acceptedLead({ kind: 'answer', by: 'phone', state: 'both' }),
      acceptedLead({ kind: 'answer', state: 'declined' }),
      acceptedLead({ kind: 'answer', state: 'void' }),
    ]).toEqual(['Accepted in chat', 'Both kept in chat', 'You said yes on this phone', 'Declined', 'Not used']);
    expect([answerAppLine('Cloud Two'), answerAppLine(undefined)]).toEqual(['App: Cloud Two (as the app reported)', 'App: a connected app (as the app reported)']);
    expect(REVIEW_EMPTY_ACCEPTED).toContain('Answers your AI apps settle in chat');
  });

  it('labels the old text of an undone yes as brought back, not retired', () => {
    expect(retiredLabel({ state: 'undone' })).toBe('Brought back');
    expect(retiredLabel({ state: 'applied' })).toBe('Retired');
  });
});
