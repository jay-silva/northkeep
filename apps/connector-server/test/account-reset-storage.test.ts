import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { pgliteAsNeon } from './adr0061-support.js';

/** ADR 0074 reset rules on the in-memory store and on the real Neon SQL over PGlite. */
const A = 'acct-0074';
const B = 'acct-other';

async function makeStore(kind: 'memory' | 'pglite'): Promise<ConnectorStorage> {
  if (kind === 'memory') return new InMemoryConnectorStorage();
  const s = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite(), { numbersAsStrings: true }));
  await s.ensureSchema();
  return s;
}

async function fill(store: ConnectorStorage, account: string, wrap: string): Promise<void> {
  await store.upsertAccount(account);
  await store.ensureAccountDekWrap(account, wrap);
  for (const id of ['e1', 'e2']) {
    await store.putEntry(account, { entryId: `${account}-${id}`, scope: 'work', type: '', content: `nkc1:${id}`, createdAt: new Date().toISOString() });
  }
  await store.putPairingCode(`pair-${account}`, account, Date.now() + 60_000, 'nkw1:pair');
  await store.putToken(`tok-${account}`, {
    clientId: 'app', accountHash: account, audience: 'https://x/mcp', kind: 'refresh',
    expiresAt: Math.floor(Date.now() / 1000) + 3600, dekWrap: 'nkw1:tok',
  });
  await store.unshareScope(account, 'old-scope', { paid: true });
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`resetAccountKey (${kind})`, () => {
    it('does nothing when the stored wrap is not the dead one', async () => {
      const store = await makeStore(kind);
      await fill(store, A, 'nkw1:dead');
      expect(await store.resetAccountKey(A, 'nkw1:something-else')).toBeNull();
      expect((await store.listEntries(A)).length).toBe(2);
      expect(await store.getAccountDekWrap(A)).toBe('nkw1:dead');
      expect(await store.getToken(`tok-${A}`)).not.toBeNull();
    });

    it("clears the dead wrap and everything locked under it, keeps tombstones, and leaves other accounts alone", async () => {
      const store = await makeStore(kind);
      await fill(store, A, 'nkw1:dead');
      await fill(store, B, 'nkw1:fine');
      expect(await store.resetAccountKey(A, 'nkw1:dead')).toBe(2);
      expect(await store.getAccountDekWrap(A)).toBeNull();
      expect(await store.listEntries(A)).toEqual([]);
      expect(await store.getToken(`tok-${A}`)).toBeNull();
      expect(await store.consumePairingCode(`pair-${A}`)).toBeNull();
      expect((await store.listTombstones(A)).map((t) => t.scope)).toEqual(['old-scope']);
      expect((await store.listEntries(B)).length).toBe(2);
      expect(await store.getAccountDekWrap(B)).toBe('nkw1:fine');
      expect(await store.getToken(`tok-${B}`)).not.toBeNull();
      expect(await store.resetAccountKey(A, 'nkw1:dead')).toBeNull();
    });
  });
}
