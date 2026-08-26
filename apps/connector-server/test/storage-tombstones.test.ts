import { describe, expect, it } from 'vitest';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { TombstoneConflictError } from '../src/tombstones.js';

describe('InMemoryConnectorStorage tombstone upsert', () => {
  it('deleteScope upserts one row per account+scope, latest unshared_at', async () => {
    const store = new InMemoryConnectorStorage();
    await store.upsertAccount('acct');
    await store.deleteScope('acct', 'work');
    const first = (await store.listTombstones('acct')).find((t) => t.scope === 'work');
    expect(first).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    await store.deleteScope('acct', 'work');
    const tombs = (await store.listTombstones('acct')).filter((t) => t.scope === 'work');
    expect(tombs).toHaveLength(1);
    expect(Date.parse(tombs[0]!.unsharedAt)).toBeGreaterThanOrEqual(Date.parse(first!.unsharedAt));
  });

  it('replaceScopesAcceptingReshare refuses a tombstoned scope without a newer shared_at', async () => {
    const store = new InMemoryConnectorStorage();
    await store.deleteScope('acct', 'work');
    await expect(
      store.replaceScopesAcceptingReshare('acct', ['work'], [], {}),
    ).rejects.toBeInstanceOf(TombstoneConflictError);
    expect(await store.listTombstones('acct')).toHaveLength(1);
  });

  it('accepts a newer shared_at and deletes the outranked tombstone', async () => {
    const store = new InMemoryConnectorStorage();
    await store.deleteScope('acct', 'work');
    const tomb = (await store.listTombstones('acct'))[0]!;
    const later = new Date(Date.parse(tomb.unsharedAt) + 1000).toISOString();
    await store.replaceScopesAcceptingReshare(
      'acct',
      ['work'],
      [
        {
          entryId: 'e1',
          scope: 'work',
          type: '',
          content: 'nkc1:test',
          createdAt: later,
        },
      ],
      { work: later },
    );
    expect(await store.listTombstones('acct')).toEqual([]);
    expect(await store.listEntries('acct')).toHaveLength(1);
  });

  it('equal shared_at and unshared_at is a conflict (must be strictly newer)', async () => {
    const store = new InMemoryConnectorStorage();
    await store.deleteScope('acct', 'work');
    const tomb = (await store.listTombstones('acct'))[0]!;
    await expect(
      store.replaceScopesAcceptingReshare('acct', ['work'], [], { work: tomb.unsharedAt }),
    ).rejects.toBeInstanceOf(TombstoneConflictError);
    expect(await store.listTombstones('acct')).toHaveLength(1);
  });
});
