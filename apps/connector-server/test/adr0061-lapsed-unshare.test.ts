import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage, type SharedEntry } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { sha256hex } from '../src/hash.js';
import { pgliteAsNeon, signTestEntitlement, startServer, TEST_PEPPER_B64, withEnv, nowSec } from './adr0061-support.js';

/**
 * ADR 0061 Decision 1, claims 1-6, 24 and 26: a lapsed subscriber can still
 * unshare; nothing else opens up; an unknown token writes nothing; the new
 * tombstone caps hold. Every scenario runs over InMemory and over the real
 * Neon SQL on PGlite.
 */

const SECRET = 'adr0061-test-entitlement-secret';
const maint = { run: false, purge: false, notes: ['test'] };

type Kind = 'memory' | 'pglite' | 'pglite-strings';

async function makeStore(kind: Kind): Promise<{ store: ConnectorStorage; db: PGlite | null }> {
  if (kind === 'memory') return { store: new InMemoryConnectorStorage(), db: null };
  const db = new PGlite();
  const store = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(db, { numbersAsStrings: kind === 'pglite-strings' }));
  await store.ensureSchema();
  return { store, db };
}

function entry(id: string, scope: string, extra: Partial<SharedEntry> = {}): SharedEntry {
  return { entryId: id, scope, type: '', content: `nkc1:cipher-${id}`, entryHash: `h-${id}`, createdAt: new Date().toISOString(), ...extra };
}

const newToken = (): string => crypto.randomBytes(24).toString('hex');

async function tableCounts(store: ConnectorStorage, db: PGlite | null): Promise<string> {
  if (store instanceof InMemoryConnectorStorage) return store.dumpState();
  const counts: Record<string, number> = {};
  for (const t of ['connector_accounts', 'scope_tombstones', 'connector_audit', 'shared_entries', 'pending_forgets']) {
    const r = await db!.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = r.rows[0]!.n;
  }
  return JSON.stringify(counts);
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0061 lapsed unshare (${kind})`, () => {
    let store: ConnectorStorage;
    let db: PGlite | null;
    let base = '';
    let close: () => Promise<void>;
    const lapsedToken = newToken();
    const lapsed = sha256hex(lapsedToken);

    const del = (token: string, scope: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/client/scope/${encodeURIComponent(scope)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, ...headers },
      });

    beforeAll(async () => {
      ({ store, db } = await makeStore(kind));
      await withEnv(
        { CONNECTOR_ENTITLEMENT_SECRET: SECRET, CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64 },
        async () => {
          ({ base, close } = await startServer(() => createConnectorServer(store, { maintenance: maint })));
        },
      );
      process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
      // A former subscriber: stamped once, stamp now in the past.
      await store.upsertAccount(lapsed);
      await store.setEntitledUntil(lapsed, Date.now() - 60_000);
      await store.putEntry(lapsed, entry('w1', 'work'));
      await store.putEntry(lapsed, entry('w2', 'work'));
      await store.putEntry(lapsed, entry('app1', 'work', { origin: 'connector', pending: true }));
      await store.putEntry(lapsed, entry('p1', 'personal'));
      await store.enqueueForget(lapsed, 'w-forgotten-by-app');
    }, 30_000);

    afterAll(async () => {
      await close();
      delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    });

    it('claim 5 (guard): lapsed, the other routes still answer 402', async () => {
      const auth = { authorization: `Bearer ${lapsedToken}` };
      expect((await fetch(`${base}/client/manifest`, { headers: auth })).status).toBe(402);
      expect((await fetch(`${base}/client/pending`, { headers: auth })).status).toBe(402);
      const put = await fetch(`${base}/client/entries`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ scopes: ['work'], entries: [] }),
      });
      expect(put.status).toBe(402);
      const ack = await fetch(`${base}/client/ack`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ acked: [], forgets: [] }),
      });
      expect(ack.status).toBe(402);
      const pair = await fetch(`${base}/pair/start`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(pair.status).toBe(402);
      // /mcp with a live access token bound to the lapsed account.
      const access = newToken();
      await store.putToken(sha256hex(access), {
        clientId: 'c',
        accountHash: lapsed,
        audience: `${base}/mcp`,
        expiresAt: nowSec() + 3600,
        kind: 'access',
        dekWrap: '',
      });
      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(mcp.status).toBe(402);
      // Nothing above touched the rows.
      expect((await store.listEntries(lapsed)).length).toBe(4);
    });

    it('claims 1 and 2: a lapsed account unshares; rows (incl. undelivered app rows) go, tombstone lands, forgets stay', async () => {
      const res = await del(lapsedToken, 'work');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: unknown };
      expect(body.deleted).toBe(3);
      const left = await store.listEntries(lapsed);
      expect(left.map((e) => e.entryId).sort()).toEqual(['p1']);
      expect((await store.listTombstones(lapsed)).map((t) => t.scope)).toContain('work');
      expect(await store.listPendingForgets(lapsed)).toEqual(['w-forgotten-by-app']);
    });

    it('a repeated lapsed unshare that changes nothing adds no audit row', async () => {
      const before = await tableCounts(store, db);
      const res = await del(lapsedToken, 'work');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { deleted: number }).deleted).toBe(0);
      const after = await tableCounts(store, db);
      if (store instanceof InMemoryConnectorStorage) {
        expect(JSON.parse(after).audit.length).toBe(JSON.parse(before).audit.length);
      } else {
        expect(JSON.parse(after).connector_audit).toBe(JSON.parse(before).connector_audit);
      }
    });

    it('claim 3: an unknown token unshare answers 200 deleted 0 and writes nothing', async () => {
      const before = await tableCounts(store, db);
      const res = await del(newToken(), 'anything', {
        'x-nb-entitlement': signTestEntitlement(SECRET, { active: true, expSec: nowSec() - 5 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, deleted: 0 });
      expect(await tableCounts(store, db)).toBe(before);
    });

    it('claim 4: a 402 on a gated route creates no account row', async () => {
      const token = newToken();
      const auth = { authorization: `Bearer ${token}` };
      expect((await fetch(`${base}/client/manifest`, { headers: auth })).status).toBe(402);
      expect((await fetch(`${base}/client/pending`, { headers: auth })).status).toBe(402);
      const pair = await fetch(`${base}/pair/start`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(pair.status).toBe(402);
      expect(await store.hasAccount(sha256hex(token))).toBe(false);
    });

    it('claim 24: a never-stamped account row still deletes and tombstones, but cannot add a new empty tombstone', async () => {
      const token = newToken();
      const acct = sha256hex(token);
      await store.upsertAccount(acct); // a pre-0061 free row
      await store.putEntry(acct, entry('x1', 'held'));
      const r1 = await del(token, 'held');
      expect(r1.status).toBe(200);
      expect(((await r1.json()) as { deleted: number }).deleted).toBe(1);
      expect((await store.listTombstones(acct)).map((t) => t.scope)).toEqual(['held']);
      const r2 = await del(token, 'never-had-rows');
      expect(r2.status).toBe(200);
      expect((await store.listTombstones(acct)).map((t) => t.scope)).toEqual(['held']);
    });

    it('a lapsed account that was stamped once may add a new empty-scope tombstone', async () => {
      const res = await del(lapsedToken, 'empty-scope');
      expect(res.status).toBe(200);
      expect((await store.listTombstones(lapsed)).map((t) => t.scope)).toContain('empty-scope');
    });
  });
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0061 tombstone caps (${kind}), claim 6`, () => {
    let store: ConnectorStorage;
    const acct = 'acct-caps';

    beforeAll(async () => {
      ({ store } = await makeStore(kind));
      await store.upsertAccount(acct);
      for (let i = 0; i < 1000; i++) await store.unshareScope(acct, `s${i}`, { paid: true });
    }, 60_000);

    it('at 1000 tombstones a new empty scope gets none; a scope with rows still does; a refresh is fine', async () => {
      expect((await store.listTombstones(acct)).length).toBe(1000);
      expect(await store.unshareScope(acct, 'new-empty', { paid: true })).toEqual({ deleted: 0, newTombstones: 0 });
      await store.putEntry(acct, entry('r1', 'has-rows'));
      expect(await store.unshareScope(acct, 'has-rows', { paid: true })).toEqual({ deleted: 1, newTombstones: 1 });
      expect(await store.unshareScope(acct, 's5', { paid: true })).toEqual({ deleted: 0, newTombstones: 0 });
      expect((await store.listTombstones(acct)).length).toBe(1001);
    });

    it('a new empty-scope tombstone is refused past 1024 bytes (bytes, not characters); a long scope with rows is still unshared', async () => {
      const other = 'acct-names';
      await store.upsertAccount(other);
      expect((await store.unshareScope(other, 'a'.repeat(1024), { paid: true })).newTombstones).toBe(1);
      expect((await store.unshareScope(other, 'b'.repeat(1025), { paid: true })).newTombstones).toBe(0);
      expect((await store.unshareScope(other, 'é'.repeat(513), { paid: true })).newTombstones).toBe(0);
      const long = 'c'.repeat(3000);
      await store.putEntry(other, entry('L1', long));
      expect(await store.unshareScope(other, long, { paid: true })).toEqual({ deleted: 1, newTombstones: 1 });
      expect(await store.listEntries(other)).toEqual([]);
    });
  });
}

describe('ADR 0061 claim 26: counts reach the client as numbers even when the driver returns strings', () => {
  it('unshare answers "deleted": 2 as a JSON number', async () => {
    const { store } = await makeStore('pglite-strings');
    const token = newToken();
    const acct = sha256hex(token);
    await store.upsertAccount(acct);
    await store.setEntitledUntil(acct, Date.now() - 1000);
    await store.putEntry(acct, entry('n1', 'work'));
    await store.putEntry(acct, entry('n2', 'work'));
    let close = async (): Promise<void> => {};
    let base = '';
    await withEnv({ CONNECTOR_ENTITLEMENT_SECRET: SECRET, CONNECTOR_KEK_PEPPER: TEST_PEPPER_B64 }, async () => {
      ({ base, close } = await startServer(() => createConnectorServer(store, { maintenance: maint })));
      const res = await fetch(`${base}/client/scope/work`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"deleted":2');
      expect(typeof (JSON.parse(text) as { deleted: unknown }).deleted).toBe('number');
    });
    await close();
  }, 30_000);
});
