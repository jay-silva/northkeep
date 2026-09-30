import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { NeonConnectorStorage, SCHEMA_STATEMENTS } from '../src/neon-storage.js';
import {
  BASE_NEW,
  InMemoryConnectorStorage,
  StalePushError,
  type ConnectorStorage,
  type SharedEntry,
  type VaultOrderClaim,
} from '../src/storage.js';
import { TombstoneConflictError } from '../src/tombstones.js';
import { pgliteAsNeon } from './adr0061-support.js';

/**
 * ADR 0063 storage rules, asserted with the same literals on the in-memory
 * store and on the real Neon SQL over PGlite. The PGlite driver returns every
 * number as a string, the way Neon's HTTP driver returns int8.
 */

const A = 'acct-0063';
const S = 'project:demo';

function row(entryId: string, scope = S, extra: Partial<SharedEntry> = {}): SharedEntry {
  return { entryId, scope, type: '', content: `nkc1:${entryId}`, entryHash: `h-${entryId}`, createdAt: new Date().toISOString(), ...extra };
}

function claim(server: string | null, version: number | null, reset = false): VaultOrderClaim {
  return { server, version, reset };
}

async function makeStore(kind: 'memory' | 'pglite'): Promise<ConnectorStorage> {
  if (kind === 'memory') return new InMemoryConnectorStorage();
  const s = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite(), { numbersAsStrings: true }));
  await s.ensureSchema();
  return s;
}

async function byId(store: ConnectorStorage, id: string) {
  const e = await store.getEntry(A, id);
  return e && { pending: e.pending === true, base: e.baseRevision, seq: e.writeSeq };
}

describe('ADR 0063 migration on a database that already holds legacy rows (PGlite)', () => {
  it('adds the columns without a backfill: legacy pending rows read base absent and write_seq 0', async () => {
    const db = new PGlite();
    const firstNew = SCHEMA_STATEMENTS.findIndex((s) => s.includes('base_revision'));
    for (const st of SCHEMA_STATEMENTS.slice(0, firstNew)) await db.exec(st);
    await db.query(
      `INSERT INTO shared_entries (account_hash, entry_id, scope, type, content, origin, pending)
       VALUES ($1, 'conn_legacy', $2, '', 'nkc1:x', 'connector', true), ($1, 'P0', $2, '', 'nkc1:p', 'vault', false)`,
      [A, S],
    );
    const store = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(db, { numbersAsStrings: true }));
    await store.ensureSchema();
    await store.ensureSchema();
    expect(await byId(store, 'conn_legacy')).toEqual({ pending: true, base: undefined, seq: 0 });
    expect(await byId(store, 'P0')).toEqual({ pending: false, base: undefined, seq: 0 });
    expect(await store.readScopeSeq(A, S)).toBe(0);
  });
});

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0063 storage (${kind})`, () => {
    it('readScopeSeq creates the counter at 0 and a push moves it once per scope, stamping every row', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      expect(await store.readScopeSeq(A, S)).toBe(0);
      expect(await store.readScopeSeq(A, S)).toBe(0);
      await store.replaceScopes(A, [S, 'notes', S], [row('P1'), row('n1', 'notes')]);
      expect(await store.readScopeSeq(A, S)).toBe(1);
      expect(await store.readScopeSeq(A, 'notes')).toBe(1);
      expect(await byId(store, 'P1')).toEqual({ pending: false, base: undefined, seq: 1 });
      await store.replaceScopes(A, [S, 'notes'], [row('n1', 'notes')]);
      expect(await store.readScopeSeq(A, S)).toBe(2);
      expect(await byId(store, 'P1')).toBeNull();
      expect(await byId(store, 'n1')).toEqual({ pending: false, base: undefined, seq: 2 });
    });

    it('writeConnectorRows is a compare-and-swap on the counter; the delete names one pending id; counts past 9 compare as numbers', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      await store.replaceScopes(A, [S], [row('P1')]);
      const s0 = await store.readScopeSeq(A, S);
      expect(s0).toBe(1);
      expect(
        await store.writeConnectorRows(A, S, { expectedSeq: s0, rows: [{ entryId: 'conn_held', content: 'nkc1:h', baseRevision: 'P0' }], replacedId: null }),
      ).toBe(2);
      const s1 = await store.readScopeSeq(A, S);
      const first = await store.writeConnectorRows(A, S, {
        expectedSeq: s1,
        rows: [{ entryId: 'conn_u1', content: 'nkc1:u1', baseRevision: 'P1' }],
        replacedId: null,
      });
      const second = await store.writeConnectorRows(A, S, {
        expectedSeq: s1,
        rows: [{ entryId: 'conn_u2', content: 'nkc1:u2', baseRevision: 'P1' }],
        replacedId: null,
      });
      expect([first, second]).toEqual([3, null]);
      expect(await byId(store, 'conn_u2')).toBeNull();
      expect(await byId(store, 'conn_u1')).toEqual({ pending: true, base: 'P1', seq: 3 });

      let prev = 'conn_u1';
      for (let i = 0; i < 9; i++) {
        const seq = await store.readScopeSeq(A, S);
        const id = `conn_n${i}`;
        const got = await store.writeConnectorRows(A, S, {
          expectedSeq: seq,
          rows: [{ entryId: id, content: 'nkc1:n', baseRevision: 'P1' }],
          replacedId: prev,
        });
        expect(got).toBe(seq + 1);
        prev = id;
      }
      expect(await store.readScopeSeq(A, S)).toBe(12);
      expect(await store.writeConnectorRows(A, S, { expectedSeq: 9, rows: [{ entryId: 'late', content: 'nkc1:l', baseRevision: 'P1' }], replacedId: prev })).toBeNull();
      const pending = (await store.listPendingEntries(A)).map((e) => e.entryId).sort();
      expect(pending).toEqual(['conn_held', 'conn_n8']);
      // The delete refuses a non-pending id even when named.
      const s2 = await store.readScopeSeq(A, S);
      await store.writeConnectorRows(A, S, { expectedSeq: s2, rows: [{ entryId: 'conn_x', content: 'nkc1:x', baseRevision: 'P1' }], replacedId: 'P1' });
      expect(await byId(store, 'P1')).toEqual({ pending: false, base: undefined, seq: 1 });
    });

    it('an unconditional write moves the counter and records a null base as absent', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      expect(await store.writeConnectorRows(A, 'notes', { expectedSeq: null, rows: [{ entryId: 'conn_m', content: 'nkc1:m', baseRevision: null }], replacedId: null })).toBe(1);
      expect(await store.writeConnectorRows(A, S, { expectedSeq: null, rows: [{ entryId: 'conn_c', content: 'nkc1:c', baseRevision: BASE_NEW }], replacedId: null })).toBe(1);
      expect(await byId(store, 'conn_m')).toEqual({ pending: true, base: undefined, seq: 1 });
      expect(await byId(store, 'conn_c')).toEqual({ pending: true, base: 'new', seq: 1 });
    });

    it('an ack stamps the renamed row above the pushed head; an ack of a vanished row leaves the pushed head alone', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      await store.replaceScopes(A, [S], [row('P1')]);
      await store.writeConnectorRows(A, S, { expectedSeq: 1, rows: [{ entryId: 'conn_c1', content: 'nkc1:c1', baseRevision: 'P1' }], replacedId: null });
      await store.ackEntry(A, 'conn_c1', 'H2');
      expect(await byId(store, 'H2')).toEqual({ pending: false, base: 'P1', seq: 3 });
      expect(await byId(store, 'P1')).toEqual({ pending: false, base: undefined, seq: 1 });
      await store.ackEntry(A, 'conn_gone', 'P1');
      expect(await byId(store, 'P1')).toEqual({ pending: false, base: undefined, seq: 1 });
      expect(await store.readScopeSeq(A, S)).toBe(3);
    });

    it('discardPending deletes only pending rows by id and moves each touched scope once; a forget drain moves its scope', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      await store.replaceScopes(A, [S, 'notes'], [row('P1'), row('n1', 'notes')]);
      await store.writeConnectorRows(A, S, { expectedSeq: 1, rows: [{ entryId: 'conn_a', content: 'nkc1:a', baseRevision: 'P0' }], replacedId: null });
      await store.writeConnectorRows(A, S, { expectedSeq: 2, rows: [{ entryId: 'conn_b', content: 'nkc1:b', baseRevision: 'P1' }], replacedId: null });
      expect(await store.discardPending(A, ['conn_a', 'conn_b', 'conn_a', 'P1', 'missing'])).toBe(2);
      expect(await store.readScopeSeq(A, S)).toBe(4);
      expect(await byId(store, 'P1')).toEqual({ pending: false, base: undefined, seq: 1 });
      expect(await store.discardPending(A, [])).toBe(0);
      await store.enqueueForget(A, 'n1');
      await store.applyForget(A, 'n1');
      expect(await store.readScopeSeq(A, 'notes')).toBe(2);
      expect(await byId(store, 'n1')).toBeNull();
    });

    it('unshare moves an existing counter and never creates one', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      await store.replaceScopes(A, [S], [row('P1')]);
      await store.unshareScope(A, S, { paid: true });
      expect(await store.readScopeSeq(A, S)).toBe(2);
      await store.unshareScope(A, 'never-seen', { paid: true });
      expect(await store.readScopeSeq(A, 'never-seen')).toBe(0);
    });

    it('the vault-order guard: older refused with nothing written, equal and newer pass, a server change replaces, reset replaces', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      const push = async (id: string, c: VaultOrderClaim): Promise<string> => {
        try {
          await store.replaceScopes(A, [S], [row(id)], c);
          return 'ok';
        } catch (err) {
          if (err instanceof StalePushError) return '428';
          throw err;
        }
      };
      const results = [
        await push('v0', claim(null, null)),
        await push('v5', claim('aaaaaaaaaaaaaaaa', 5)),
        await push('v4', claim('aaaaaaaaaaaaaaaa', 4)),
        await push('v4old', claim(null, null)),
        await push('v5b', claim('aaaaaaaaaaaaaaaa', 5)),
        await push('v6', claim('aaaaaaaaaaaaaaaa', 6)),
        await push('w1', claim('bbbbbbbbbbbbbbbb', 1)),
        await push('w0', claim('bbbbbbbbbbbbbbbb', 0)),
        await push('w0r', claim('bbbbbbbbbbbbbbbb', 0, true)),
        await push('nr', claim(null, null, true)),
        await push('n2', claim(null, null)),
      ];
      expect(results).toEqual(['ok', 'ok', '428', '428', 'ok', 'ok', 'ok', '428', 'ok', 'ok', 'ok']);
      expect(await store.getVaultOrder(A)).toEqual({ server: null, version: null });
      expect((await store.listEntries(A)).map((e) => e.entryId)).toEqual(['n2']);
      // Eight accepted pushes moved the counter; the three refusals did not.
      expect(await store.readScopeSeq(A, S)).toBe(8);
      await push('x9', claim('aaaaaaaaaaaaaaaa', 9));
      expect(await store.getVaultOrder(A)).toEqual({ server: 'aaaaaaaaaaaaaaaa', version: 9 });
    });

    it('a push that is both stale and tombstoned: the tombstone is reported first; the plain replace refuses it as stale', async () => {
      const store = await makeStore(kind);
      await store.upsertAccount(A);
      await store.replaceScopes(A, [S], [row('P1')], claim('aaaaaaaaaaaaaaaa', 5));
      await store.unshareScope(A, S, { paid: true });
      const accepting = await store
        .replaceScopesAcceptingReshare(A, [S], [row('P0')], {}, claim('aaaaaaaaaaaaaaaa', 4))
        .then(() => 'ok', (e: unknown) => (e instanceof TombstoneConflictError ? '412' : e instanceof StalePushError ? '428' : 'other'));
      const plain = await store
        .replaceScopes(A, [S], [row('P0')], claim('aaaaaaaaaaaaaaaa', 4))
        .then(() => 'ok', (e: unknown) => (e instanceof StalePushError ? '428' : 'other'));
      expect([accepting, plain]).toEqual(['412', '428']);
      expect(await store.listEntries(A)).toEqual([]);
      expect(await store.getVaultOrder(A)).toEqual({ server: 'aaaaaaaaaaaaaaaa', version: 5 });
    });
  });
}
