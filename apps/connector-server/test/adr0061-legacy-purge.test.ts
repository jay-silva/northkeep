import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage, SCHEMA_SQL, SCHEMA_STATEMENTS } from '../src/neon-storage.js';
import { isEncryptedRow } from '../src/crypto.js';
import { maintenanceConfigFromEnv, runMaintenance } from '../src/maintenance.js';
import { pgliteAsNeon } from './adr0061-support.js';

/**
 * ADR 0061 Decision 3, claims 14-16: the purge deletes exactly the rows
 * isEncryptedRow rejects, is idempotent, and never runs without both explicit
 * flags or while legacy passthrough is allowed.
 */

const HOSTILE = [
  '',
  'nkc1',
  'nkc1:',
  'NKC1:x',
  ' nkc1:x',
  'nkc1;x',
  '﻿nkc1:x',
  '​nkc1:x',
  ' nkc1:x',
  'nкc1:x', // Cyrillic ka lookalike
  'ｎkc1:x', // fullwidth n
  'nkc1：x', // fullwidth colon
  'nkc%:x',
  'nkc_:x',
  'nkc\\1:x',
  '\nnkc1:x',
  'plain memory text',
  'x'.repeat(10_000),
  '😀 emoji',
  'nkc1:abc:def',
  'nkc1:' + 'A'.repeat(64),
  'nkc1:%',
  'nkc1:_',
];

async function seeded(kind: 'memory' | 'pglite'): Promise<ConnectorStorage> {
  let store: ConnectorStorage;
  if (kind === 'memory') store = new InMemoryConnectorStorage();
  else {
    const neon = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite()));
    await neon.ensureSchema();
    store = neon;
  }
  await store.upsertAccount('acct');
  let i = 0;
  for (const content of HOSTILE) {
    await store.putEntry('acct', { entryId: `e${i++}`, scope: 's', type: '', content, createdAt: new Date().toISOString() });
  }
  return store;
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0061 legacy purge (${kind})`, () => {
    it('claim 14: deletes exactly the rows isEncryptedRow rejects; a second run deletes 0', async () => {
      const store = await seeded(kind);
      const expectKept = HOSTILE.filter((c) => isEncryptedRow(c)).sort();
      const expectPurged = HOSTILE.length - expectKept.length;
      expect(await store.purgeLegacyPlaintext()).toBe(expectPurged);
      expect((await store.listEntries('acct')).map((e) => e.content).sort()).toEqual(expectKept);
      expect(await store.purgeLegacyPlaintext()).toBe(0);
    });

    it('claim 15 (guard): nothing is purged without both flags, or with passthrough allowed', async () => {
      const cases: Array<Record<string, string>> = [
        {},
        { NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on' },
        { NORTHKEEP_CONNECTOR_MAINTENANCE: 'on' },
        { NORTHKEEP_CONNECTOR_MAINTENANCE: 'on', NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'off' },
        {
          NORTHKEEP_CONNECTOR_MAINTENANCE: 'on',
          NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on',
          NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT: '1',
        },
        { VERCEL: '1', VERCEL_ENV: 'production' },
      ];
      for (const env of cases) {
        const store = await seeded(kind);
        await runMaintenance(store, maintenanceConfigFromEnv(env), () => {});
        expect((await store.listEntries('acct')).length, JSON.stringify(env)).toBe(HOSTILE.length);
      }
      const store = await seeded(kind);
      const r = await runMaintenance(
        store,
        maintenanceConfigFromEnv({ NORTHKEEP_CONNECTOR_MAINTENANCE: 'on', NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on' }),
        () => {},
      );
      expect(r!.purged).toBeGreaterThan(0);
    }, 30_000); // several pglite databases; slow CI runners took 5.3 s
  });
}

describe('ADR 0061 claim 16 (guard): the purge is not in the hand-run schema', () => {
  it('SCHEMA_SQL has no DELETE FROM shared_entries', () => {
    expect(SCHEMA_SQL).not.toMatch(/DELETE\s+FROM\s+shared_entries/i);
    expect(SCHEMA_STATEMENTS.some((s) => /shared_entries/i.test(s) && /DELETE/i.test(s))).toBe(false);
  });
});
