import { describe, expect, it } from 'vitest';
import {
  TIER2_UNAVAILABLE_MESSAGE,
  foldFailedNerPasses,
  partialNerFailureMessage,
} from '../src/lib/ner-degrade';

/**
 * The fold from per-pass NER records to the audit view's degrade summary and
 * the exact copy it renders (invariant #6: partial Tier-2 failure must be
 * user-visible, not console-only). Pure logic, tested under Node.
 */

describe('foldFailedNerPasses', () => {
  it('returns unique failed pass ids in first-failure order', () => {
    const events = [
      { pass: 'person', ok: true },
      { pass: 'org', ok: false },
      { pass: 'street', ok: false },
      { pass: 'place', ok: true },
      // runTurn redacts several segments per turn: the same passes fire again.
      { pass: 'person', ok: false },
      { pass: 'org', ok: false },
    ];
    expect(foldFailedNerPasses(events)).toEqual(['org', 'street', 'person']);
  });

  it('is empty when every pass succeeded (nothing to warn about)', () => {
    expect(
      foldFailedNerPasses([
        { pass: 'person', ok: true },
        { pass: 'org', ok: true },
      ]),
    ).toEqual([]);
    expect(foldFailedNerPasses([])).toEqual([]);
  });

  it('a pass that failed once and later succeeded still counts as failed this turn', () => {
    expect(
      foldFailedNerPasses([
        { pass: 'person', ok: false },
        { pass: 'person', ok: true },
      ]),
    ).toEqual(['person']);
  });
});

describe('partialNerFailureMessage', () => {
  it('names a single failed pass', () => {
    expect(partialNerFailureMessage(['person'])).toBe(
      'Name detection ran partially: the person pass failed this turn.',
    );
  });

  it('lists two failed passes', () => {
    expect(partialNerFailureMessage(['person', 'street'])).toBe(
      'Name detection ran partially: the person and street passes failed this turn.',
    );
  });

  it('lists three or more failed passes', () => {
    expect(partialNerFailureMessage(['person', 'org', 'street'])).toBe(
      'Name detection ran partially: the person, org, and street passes failed this turn.',
    );
  });

  it('returns an empty string for an empty list', () => {
    expect(partialNerFailureMessage([])).toBe('');
  });

  it('user-facing copy carries no em dashes and no content beyond pass ids', () => {
    for (const s of [
      TIER2_UNAVAILABLE_MESSAGE,
      partialNerFailureMessage(['person', 'org', 'street', 'place']),
    ]) {
      expect(s).not.toContain('—');
    }
  });
});
