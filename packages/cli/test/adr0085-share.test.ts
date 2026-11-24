import { describe, expect, it } from 'vitest';
import { describePlan } from '../src/shareCmd.js';

// ADR 0085 D4: a queued replace from an AI app, in the CLI's sync preview. Fictional data.

describe('ADR 0085 share sync preview', () => {
  it('lists each queued replace in plain words', () => {
    const cloud_replaces = [
      { replace_id: 'rep_1', scope: 'harbor', old_id: 'm1', new_id: 'm2', old_first_line: 'The harbor office is at Pier 4.', new_first_line: 'The harbor office is now at Pier 9.' },
      { replace_id: 'rep_2', scope: 'boats', old_id: 'm3', new_id: 'm4', old_first_line: 'The skiff is blue.', new_first_line: 'The skiff is green.' },
    ];
    const lines = describePlan({
      additions: [], replacements: [], forgets: [], dedupes: [], discards: [], settled_forgets: [], conflicts: [],
      held: 0, held_scopes: [], deferred: 0, skipped: 0, to_mark: [], cloud_replaces, settled_replaces: [],
    });
    expect(lines).toEqual([
      '  2 memories would be replaced by a newer one from your apps (the old one stays in history):',
      '    harbor: Replace "The harbor office is at Pier 4." with "The harbor office is now at Pier 9."',
      '    boats: Replace "The skiff is blue." with "The skiff is green."',
    ]);
  });
});
