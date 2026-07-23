import { describe, expect, it } from 'vitest';
import { spansToEntitiesJson, type NlTaggerSpan } from '../src/lib/nltagger-spans';

/**
 * The pure NLTagger span -> {"entities":[...]} mapping (the on-device name net
 * that replaced the Apple FM NER path). NLTagger returns structured spans, so
 * there is no model JSON to parse; this module only validates/dedups them into
 * the exact contract applyTier2 already consumes. Pure logic, tested under Node.
 * The native tagNames call is the only part that needs a device build.
 */

function parse(json: string): { entities: NlTaggerSpan[] } {
  return JSON.parse(json) as { entities: NlTaggerSpan[] };
}

describe('spansToEntitiesJson', () => {
  it('maps valid spans to the exact entities contract', () => {
    const json = spansToEntitiesJson([
      { text: 'Dana Whitfield', kind: 'person' },
      { text: 'Ridgeline Capital', kind: 'org' },
      { text: 'Marlow Falls', kind: 'location' },
    ]);
    expect(json).toBe(
      '{"entities":[{"text":"Dana Whitfield","kind":"person"},{"text":"Ridgeline Capital","kind":"org"},{"text":"Marlow Falls","kind":"location"}]}',
    );
  });

  it('returns an empty entities array for no spans', () => {
    expect(spansToEntitiesJson([])).toBe('{"entities":[]}');
  });

  it('trims whitespace and drops blank/whitespace-only spans', () => {
    const out = parse(spansToEntitiesJson([
      { text: '  Alan Voss  ', kind: 'person' },
      { text: '   ', kind: 'person' },
      { text: '', kind: 'org' },
    ]));
    expect(out.entities).toEqual([{ text: 'Alan Voss', kind: 'person' }]);
  });

  it('collapses case-insensitive exact duplicates, keeping the first', () => {
    const out = parse(spansToEntitiesJson([
      { text: 'Bob Henderson', kind: 'person' },
      { text: 'bob henderson', kind: 'person' },
      { text: 'Bob Henderson', kind: 'org' },
    ]));
    expect(out.entities).toEqual([{ text: 'Bob Henderson', kind: 'person' }]);
  });

  it('keeps overlapping-but-different spans (applyTier2 handles nesting)', () => {
    const out = parse(spansToEntitiesJson([
      { text: 'Annapolis Shipyards', kind: 'org' },
      { text: 'Annapolis', kind: 'location' },
    ]));
    expect(out.entities).toEqual([
      { text: 'Annapolis Shipyards', kind: 'org' },
      { text: 'Annapolis', kind: 'location' },
    ]);
  });

  it('drops spans whose kind is not person/org/location', () => {
    const out = parse(spansToEntitiesJson([
      { text: 'Tuesday', kind: 'date' },
      { text: 'Jane Doe', kind: 'person' },
      { text: 'Some Thing', kind: 'noun' },
    ]));
    expect(out.entities).toEqual([{ text: 'Jane Doe', kind: 'person' }]);
  });

  it('ignores malformed span records without throwing', () => {
    const out = parse(spansToEntitiesJson([
      { text: 'Real Name', kind: 'person' },
      // Malformed shapes a defensive caller might pass through from native.
      null as unknown as NlTaggerSpan,
      { text: 42 as unknown as string, kind: 'person' },
      { text: 'No Kind', kind: undefined as unknown as string },
    ]));
    expect(out.entities).toEqual([{ text: 'Real Name', kind: 'person' }]);
  });
});
