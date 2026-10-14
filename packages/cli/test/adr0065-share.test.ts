import { describe, expect, it } from 'vitest';
import type { DownSyncConflict } from '@northkeep/sync';
import { describePlan, takeTheirsWarnings } from '../src/shareCmd.js';

const held: DownSyncConflict = {
  scope: 'project:fresh',
  project: 'fresh',
  server_id: 'conn_1',
  base_revision: 'new',
  local_revision: null,
  reason: 'milestones_changed',
  content: '',
  pass_changes: [{ id: 'M1', change: 'added', text: 'M1 Define the buy box would be marked passed, confirmed by you on 2026-09-28.' }],
  shares_scope: true,
};

describe('ADR 0065 share conflicts text', () => {
  it('names every pass change and the Shared mark before take theirs', () => {
    expect(takeTheirsWarnings(held)).toEqual([
      'Milestone changes if you take the cloud version:',
      '  M1 Define the buy box would be marked passed, confirmed by you on 2026-09-28.',
      'Taking the cloud version also marks project:fresh Shared, so your connected AI apps can read everything in it.',
    ]);
    expect(takeTheirsWarnings({ ...held, pass_changes: [], shares_scope: false })).toEqual([]);
  });

  it('gives milestones_changed its own reason in the plan', () => {
    const lines = describePlan({ additions: [], replacements: [], forgets: [], dedupes: [], discards: [], settled_forgets: [], conflicts: [held], held: 0, held_scopes: [], deferred: 0, skipped: 0, to_mark: [] });
    expect(lines).toEqual([
      '  1 conflict, not applied (see "northkeep share conflicts"):',
      '    fresh: the cloud version changes which milestones have passed, and only you can decide that (id conn_1)',
    ]);
  });
});
