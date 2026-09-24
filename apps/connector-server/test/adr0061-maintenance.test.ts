import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { createConnectorServer } from '../src/create-server.js';
import { maintenanceConfigFromEnv, parseFlag, runMaintenance } from '../src/maintenance.js';
import { pgliteAsNeon, startServer, withEnv, TEST_PEPPER_B64 } from './adr0061-support.js';

/**
 * ADR 0061 Decisions 4 and 5, claims 18, 19 and 25: OAuth cleanup keeps live
 * rows; the maintenance line carries counts only; maintenance runs only on
 * explicit flags, never on environment inference.
 */

async function makeStore(kind: 'memory' | 'pglite'): Promise<ConnectorStorage> {
  if (kind === 'memory') return new InMemoryConnectorStorage();
  const s = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite()));
  await s.ensureSchema();
  return s;
}

const nowS = (): number => Math.floor(Date.now() / 1000);

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0061 OAuth cleanup (${kind})`, () => {
    it('claim 18: removes consumed and expired codes and expired tokens only; live ones still work', async () => {
      const store = await makeStore(kind);
      const code = (expiresAt: number) => ({
        clientId: 'c',
        accountHash: 'a',
        pkceChallenge: 'p',
        redirectUri: 'r',
        audience: 'aud',
        expiresAt,
        dekWrap: '',
      });
      await store.putCode('live', code(Date.now() + 300_000));
      await store.putCode('consumed', code(Date.now() + 300_000));
      await store.consumeCode('consumed');
      await store.putCode('expired', code(Date.now() - 1000));
      const tok = (kindT: 'access' | 'refresh', expiresAt: number) => ({
        clientId: 'c',
        accountHash: 'a',
        audience: 'aud',
        expiresAt,
        kind: kindT,
        dekWrap: '',
      });
      await store.putToken('live-access', tok('access', nowS() + 3600));
      await store.putToken('live-refresh', tok('refresh', nowS() + 3600));
      await store.putToken('old-access', tok('access', nowS() - 10));
      await store.putToken('old-refresh', tok('refresh', nowS() - 10));

      expect(await store.gcOAuth(nowS())).toEqual({ codes: 2, tokens: 2 });
      expect(await store.getCode('live')).not.toBeNull();
      expect(await store.getToken('live-access')).not.toBeNull();
      expect(await store.getToken('old-access')).toBeNull();
      expect(await store.consumeToken('live-refresh')).not.toBeNull();
      expect(await store.gcOAuth(nowS())).toEqual({ codes: 0, tokens: 0 });
    });
  });
}

describe('ADR 0061 claim 19: the maintenance line is counts only', () => {
  it('names no content, account hash or id, and exists', async () => {
    const store = new InMemoryConnectorStorage();
    const secretContent = 'CANARY-plaintext-memory-7c1e';
    const acct = 'a'.repeat(64);
    await store.upsertAccount(acct);
    await store.putEntry(acct, { entryId: 'CANARY-ID-3f9', scope: 'CANARY-SCOPE', type: '', content: secretContent, createdAt: new Date().toISOString() });
    store.putRawClientRow('CANARY-CLIENT', JSON.stringify({ client_id: 'CANARY-CLIENT', client_secret: 'CANARY-SECRET-99', redirect_uris: [] }), null);
    const lines: string[] = [];
    await runMaintenance(
      store,
      maintenanceConfigFromEnv({ NORTHKEEP_CONNECTOR_MAINTENANCE: 'on', NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on' }),
      (l) => lines.push(l),
    );
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatch(/^connector maintenance: purged=1 clientsMigrated=1 /);
    expect(line).toContain('clientsPlaintextRemaining=0');
    for (const bad of [secretContent, acct, 'CANARY']) expect(line).not.toContain(bad);
  });
});

describe('ADR 0061 claim 25: explicit flags only', () => {
  it('parses on|true|1|yes in any case with spaces as on; everything else is off', () => {
    for (const v of ['on', 'ON', ' On ', 'true', 'TRUE', '1', 'yes', 'Yes']) expect(parseFlag(v), v).toBe('on');
    for (const v of [undefined, '', 'off', 'OFF', 'false', '0', 'no', ' no ']) expect(parseFlag(v), String(v)).toBe('off');
    for (const v of ['onn', 'enabled', '2', 'y']) expect(parseFlag(v), v).toBe('unrecognized');
  });

  it('decides on the flags alone, whatever VERCEL and VERCEL_ENV say', () => {
    const off: Array<Record<string, string>> = [
      {},
      { VERCEL: '1', VERCEL_ENV: 'production' },
      { VERCEL: '1', VERCEL_ENV: 'preview' },
      { VERCEL: '1' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: '' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: 'off' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: 'OFF' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: 'false' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: '0' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: 'no' },
      { NORTHKEEP_CONNECTOR_MAINTENANCE: 'onn' },
      { NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on', VERCEL: '1', VERCEL_ENV: 'production' },
    ];
    for (const env of off) {
      const cfg = maintenanceConfigFromEnv(env);
      expect(cfg.run, JSON.stringify(env)).toBe(false);
      expect(cfg.purge).toBe(false);
      expect(cfg.notes.join(' ')).toContain('NORTHKEEP_CONNECTOR_MAINTENANCE not on');
    }
    const noSysVars = maintenanceConfigFromEnv({ NORTHKEEP_CONNECTOR_MAINTENANCE: 'on' });
    expect(noSysVars).toMatchObject({ run: true, purge: false });
    expect(noSysVars.notes.join(' ')).toContain('purge skipped');
    expect(maintenanceConfigFromEnv({ NORTHKEEP_CONNECTOR_MAINTENANCE: ' Yes ', NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'TRUE' })).toMatchObject({
      run: true,
      purge: true,
    });
  });

  it('through the server: no flag, first request logs the skip and changes nothing; with the flags it runs once', async () => {
    for (const kind of ['memory', 'pglite'] as const) {
      const store = await makeStore(kind);
      await store.upsertAccount('acct');
      await store.putEntry('acct', { entryId: 'legacy', scope: 's', type: '', content: 'old plaintext', createdAt: new Date().toISOString() });
      const lines: string[] = [];
      await withEnv(
        {
          NORTHKEEP_CONNECTOR_MAINTENANCE: undefined,
          NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on',
          VERCEL: '1',
          VERCEL_ENV: 'production',
          CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64,
        },
        async () => {
          const { base, close } = await startServer(() => createConnectorServer(store, { maintenanceLog: (l) => lines.push(l) }));
          await fetch(`${base}/`);
          await fetch(`${base}/`);
          await close();
        },
      );
      expect(lines).toEqual(['connector maintenance: skipped (NORTHKEEP_CONNECTOR_MAINTENANCE not on)']);
      expect((await store.listEntries('acct')).length).toBe(1);

      const ran: string[] = [];
      await withEnv(
        {
          NORTHKEEP_CONNECTOR_MAINTENANCE: 'on',
          NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT: 'on',
          CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64,
        },
        async () => {
          const { base, close } = await startServer(() => createConnectorServer(store, { maintenanceLog: (l) => ran.push(l) }));
          await Promise.all([fetch(`${base}/`), fetch(`${base}/`)]);
          await close();
        },
      );
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatch(/purged=1 /);
      expect(await store.listEntries('acct')).toEqual([]);
    }
  });
});
