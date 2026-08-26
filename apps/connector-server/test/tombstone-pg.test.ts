import { beforeAll, describe, expect, it } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { PGlite } from '@electric-sql/pglite';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { TombstoneConflictError } from '../src/tombstones.js';

/**
 * Postgres proof of deleteScope → check → conditional tombstone delete
 * (ADR 0038 addendum N11). Runs the real NeonConnectorStorage SQL against
 * PGlite so a green in-memory suite is not the only evidence.
 */

type PendingQuery = Promise<unknown[]> & { text: string; values: unknown[] };

function pgliteAsNeon(db: PGlite): NeonQueryFunction<false, false> {
  const exec = async (text: string, values: unknown[]): Promise<unknown[]> => {
    const result = await db.query(text, values);
    return result.rows as unknown[];
  };

  const pending = (text: string, values: unknown[]): PendingQuery => {
    // Lazy: transaction reads .text/.values without executing. Awaiting
    // still runs the query (ensureSchema, listTombstones, putEntry).
    let started: Promise<unknown[]> | undefined;
    const run = (): Promise<unknown[]> => {
      started ??= exec(text, values);
      return started;
    };
    const p = {
      text,
      values,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        run().then(onFulfilled, onRejected),
    } as PendingQuery;
    return p;
  };

  const sql = ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') return pending(strings, []);
    let text = strings[0] ?? '';
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      text += `$${params.length}${strings[i + 1] ?? ''}`;
    }
    return pending(text, params);
  }) as NeonQueryFunction<false, false>;

  (
    sql as NeonQueryFunction<false, false> & {
      transaction: (queries: PendingQuery[]) => Promise<unknown[][]>;
    }
  ).transaction = async (queries: PendingQuery[]) => {
    await db.query('BEGIN');
    try {
      const results: unknown[][] = [];
      for (const q of queries) {
        results.push(await exec(q.text, q.values));
      }
      await db.query('COMMIT');
      return results;
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  };
  return sql;
}

describe('Neon tombstones on Postgres (PGlite)', () => {
  let store: NeonConnectorStorage;
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    store = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(db));
    await store.ensureSchema();
  }, 30_000);

  it('deleteScope upserts one row; a newer shared_at clears it; a stale one 412s', async () => {
    const account = 'acct-pg';
    await store.upsertAccount(account);
    await store.putEntry(account, {
      entryId: 'e1',
      scope: 'work',
      type: '',
      content: 'nkc1:cipher',
      createdAt: new Date().toISOString(),
    });

    const deleted = await store.deleteScope(account, 'work');
    expect(deleted).toBe(1);
    const afterFirst = await store.listTombstones(account);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.scope).toBe('work');

    await store.deleteScope(account, 'work');
    const afterSecond = await store.listTombstones(account);
    expect(afterSecond).toHaveLength(1);
    expect(Date.parse(afterSecond[0]!.unsharedAt)).toBeGreaterThanOrEqual(
      Date.parse(afterFirst[0]!.unsharedAt),
    );

    await expect(
      store.replaceScopesAcceptingReshare(account, ['work'], [], {}),
    ).rejects.toBeInstanceOf(TombstoneConflictError);
    expect(await store.listTombstones(account)).toHaveLength(1);

    const tombMs = Date.parse(afterSecond[0]!.unsharedAt);
    await expect(
      store.replaceScopesAcceptingReshare(account, ['work'], [], {
        work: new Date(tombMs - 1).toISOString(),
      }),
    ).rejects.toBeInstanceOf(TombstoneConflictError);

    const accepted = new Date(tombMs + 1000).toISOString();
    await store.replaceScopesAcceptingReshare(
      account,
      ['work'],
      [
        {
          entryId: 'e2',
          scope: 'work',
          type: '',
          content: 'nkc1:reshare',
          createdAt: accepted,
        },
      ],
      { work: accepted },
    );
    expect(await store.listTombstones(account)).toEqual([]);
    expect((await store.listEntries(account)).map((e) => e.entryId)).toEqual(['e2']);
  });

  it('conditional delete leaves a concurrent-unshare tombstone newer than accepted', async () => {
    const account = 'acct-race';
    await store.upsertAccount(account);
    await store.deleteScope(account, 'ops');
    const tomb = (await store.listTombstones(account)).find((t) => t.scope === 'ops')!;
    const accepted = new Date(Date.parse(tomb.unsharedAt) + 1000).toISOString();
    await store.replaceScopesAcceptingReshare(account, ['ops'], [], { ops: accepted });
    expect((await store.listTombstones(account)).some((t) => t.scope === 'ops')).toBe(false);

    const laterUnshare = new Date(Date.parse(accepted) + 1000).toISOString();
    await db.query(
      `INSERT INTO scope_tombstones (account_hash, scope, unshared_at)
       VALUES ($1, $2, $3::timestamptz)`,
      [account, 'ops', laterUnshare],
    );

    const leftover = await db.query(
      `DELETE FROM scope_tombstones
       WHERE account_hash = $1 AND scope = $2 AND unshared_at <= $3::timestamptz
       RETURNING scope, unshared_at`,
      [account, 'ops', accepted],
    );
    expect(leftover.rows).toHaveLength(0);
    const kept = await store.listTombstones(account);
    expect(kept).toHaveLength(1);
    expect(Date.parse(kept[0]!.unsharedAt)).toBeGreaterThan(Date.parse(accepted));

    await expect(
      store.replaceScopesAcceptingReshare(account, ['ops'], [], { ops: accepted }),
    ).rejects.toBeInstanceOf(TombstoneConflictError);
    expect(await store.listTombstones(account)).toHaveLength(1);
  });
});
