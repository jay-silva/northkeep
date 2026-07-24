import { describe, expect, it } from 'vitest';
import { filterMemories, type SearchableEntry } from '../src/lib/search.js';

function entry(content: string, scope = 'personal', type = 'semantic'): SearchableEntry {
  return { content, scope, type };
}

const ENTRIES: SearchableEntry[] = [
  entry('Jay prefers dark roast coffee in the morning', 'personal', 'semantic'),
  entry('The Dartmouth STR uses a Schlage keypad, code rotates monthly', 'str-business', 'procedural'),
  entry('Anna is allergic to penicillin', 'family-health', 'identity'),
  entry('Quarterly protocols review is due in September', 'ems-work', 'episodic'),
];

describe('filterMemories', () => {
  it('returns everything, in order, for an empty or token-less query', () => {
    expect(filterMemories(ENTRIES, '')).toEqual(ENTRIES);
    expect(filterMemories(ENTRIES, '   ')).toEqual(ENTRIES);
    expect(filterMemories(ENTRIES, '! ?')).toEqual(ENTRIES);
  });

  it('matches content terms case-insensitively', () => {
    expect(filterMemories(ENTRIES, 'COFFEE')).toEqual([ENTRIES[0]]);
  });

  it('requires every term to match (AND semantics)', () => {
    expect(filterMemories(ENTRIES, 'coffee morning')).toEqual([ENTRIES[0]]);
    expect(filterMemories(ENTRIES, 'coffee keypad')).toEqual([]);
  });

  it('matches as a prefix so typing narrows results', () => {
    expect(filterMemories(ENTRIES, 'peni')).toEqual([ENTRIES[2]]);
  });

  it('matches on scope and type fields too', () => {
    expect(filterMemories(ENTRIES, 'str')).toContainEqual(ENTRIES[1]);
    expect(filterMemories(ENTRIES, 'identity')).toEqual([ENTRIES[2]]);
  });

  it('ignores punctuation and short noise tokens in the query', () => {
    expect(filterMemories(ENTRIES, 'coffee, a!')).toEqual([ENTRIES[0]]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterMemories(ENTRIES, 'zebra')).toEqual([]);
  });

  it('preserves input order for multiple matches', () => {
    const result = filterMemories(ENTRIES, 'in');
    expect(result).toEqual(ENTRIES.filter((e) => result.includes(e)));
  });
});
