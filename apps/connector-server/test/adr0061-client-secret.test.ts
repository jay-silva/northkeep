import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { authenticateClient } from '@modelcontextprotocol/sdk/server/auth/middleware/clientAuth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { ConnectorOAuthProvider } from '../src/provider.js';
import { ClientSecretBinder, migrateClientSecrets, SECRET_SENTINEL_PREFIX } from '../src/client-secrets.js';
import { DEV_KEK_PEPPER } from '../src/crypto.js';
import { sha256hex } from '../src/hash.js';
import {
  REDIRECT_URI,
  TEST_PEPPER_B64,
  form,
  pgliteAsNeon,
  pkce,
  postForm,
  registerClient,
  startServer,
  withEnv,
} from './adr0061-support.js';

/**
 * ADR 0061 Decision 2, claims 8-13, 21-23, 27 and 28: client secrets are held
 * as a hash only, checked in constant time by our code behind a req.ip-keyed
 * limiter, and nothing stored authenticates. Real SDK 1.29.0 router, real app.
 */

const maint = { run: false, purge: false, notes: ['test'] };
const dummyRefresh = (clientId: string, secret?: string) =>
  form({ grant_type: 'refresh_token', refresh_token: 'not-a-real-token', client_id: clientId, client_secret: secret });

async function makeStore(kind: 'memory' | 'pglite'): Promise<{ store: ConnectorStorage; db: PGlite | null }> {
  if (kind === 'memory') return { store: new InMemoryConnectorStorage(), db: null };
  const db = new PGlite();
  const store = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(db));
  await store.ensureSchema();
  return { store, db };
}

async function serve(store: ConnectorStorage, extra: Parameters<typeof createConnectorServer>[1] = {}) {
  return withEnv(
    {
      CONNECTOR_KEK_PEPPER: store instanceof InMemoryConnectorStorage ? undefined : TEST_PEPPER_B64,
      CONNECTOR_ENTITLEMENT_SECRET: undefined,
      NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES: undefined,
    },
    () => startServer(() => createConnectorServer(store, { maintenance: maint, ...extra })),
  );
}

async function rawClientRow(store: ConnectorStorage, db: PGlite | null, id: string, json: string, hash: string | null) {
  if (store instanceof InMemoryConnectorStorage) store.putRawClientRow(id, json, hash);
  else await db!.query('INSERT INTO oauth_clients (client_id, client_json, client_secret_hash) VALUES ($1, $2, $3)', [id, json, hash]);
}

async function storedClient(store: ConnectorStorage, db: PGlite | null, id: string) {
  if (store instanceof InMemoryConnectorStorage) {
    const rows = await store.listClientSecretCandidates();
    const r = rows.find((x) => x.clientId === id);
    return r ? { json: r.clientJson, hash: r.clientSecretHash } : null;
  }
  const r = await db!.query<{ client_json: string; client_secret_hash: string | null }>(
    'SELECT client_json, client_secret_hash FROM oauth_clients WHERE client_id = $1',
    [id],
  );
  return r.rows[0] ? { json: r.rows[0].client_json, hash: r.rows[0].client_secret_hash } : null;
}

/** A pre-0061 confidential client JSON exactly as the old server stored it. */
function legacyClientJson(id: string, secret: string, name = 'legacy'): string {
  return JSON.stringify({
    redirect_uris: [REDIRECT_URI],
    client_name: name,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp',
    client_secret: secret,
    client_secret_expires_at: 0,
    client_id: id,
    client_id_issued_at: 1,
  });
}

/** Call the SDK's own authenticateClient directly; returns 'ACCEPTED' or the error description. */
async function sdkAuth(clientsStore: OAuthRegisteredClientsStore, body: Record<string, string>): Promise<string> {
  const mw = authenticateClient({ clientsStore });
  return new Promise((resolve) => {
    const res = {
      status() {
        return this;
      },
      json(o: { error_description?: string }) {
        resolve(o.error_description ?? 'error');
      },
    };
    void mw({ body } as never, res as never, () => resolve('ACCEPTED'));
  });
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0061 client secrets (${kind})`, () => {
    let store: ConnectorStorage;
    let db: PGlite | null;
    let base = '';
    let close: () => Promise<void>;
    let reg: { client_id: string; client_secret?: string };

    beforeAll(async () => {
      ({ store, db } = await makeStore(kind));
      ({ base, close } = await serve(store));
      reg = await registerClient(base, { confidential: true });
    }, 30_000);
    afterAll(async () => close());

    it('claim 8: after /register nothing stored contains the secret; JSON holds the sentinel, the column the hash', async () => {
      expect(reg.client_secret).toMatch(/^[0-9a-f]{64}$/);
      const row = await storedClient(store, db, reg.client_id);
      expect(row!.json).not.toContain(reg.client_secret!);
      expect(row!.hash).toBe(sha256hex(reg.client_secret!));
      expect((JSON.parse(row!.json) as { client_secret: string }).client_secret.startsWith(SECRET_SENTINEL_PREFIX)).toBe(true);
      if (store instanceof InMemoryConnectorStorage) expect(store.dumpState()).not.toContain(reg.client_secret!);
    });

    it('claim 9 (guard): full confidential round trip through mcpAuthRouter', async () => {
      const connToken = crypto.randomBytes(24).toString('hex');
      const pair = await fetch(`${base}/pair/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(pair.status).toBe(200);
      const { pairing_code } = (await pair.json()) as { pairing_code: string };
      const { verifier, challenge } = pkce();
      const authUrl = new URL(`${base}/authorize`);
      authUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: reg.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp',
        state: 's',
        resource: `${base}/mcp`,
      }).toString();
      expect((await fetch(authUrl)).status).toBe(200);
      const consent = await fetch(`${base}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: form({
          client_id: reg.client_id,
          redirect_uri: REDIRECT_URI,
          code_challenge: challenge,
          state: 's',
          scope: 'mcp',
          resource: `${base}/mcp`,
          pairing_code,
        }),
      });
      const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
      const tok = await postForm(
        base,
        '/token',
        form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: reg.client_id,
          client_secret: reg.client_secret,
          code_verifier: verifier,
          resource: `${base}/mcp`,
        }),
      );
      expect(tok.status).toBe(200);
      const refreshed = await postForm(
        base,
        '/token',
        form({
          grant_type: 'refresh_token',
          refresh_token: tok.json.refresh_token,
          client_id: reg.client_id,
          client_secret: reg.client_secret,
        }),
      );
      expect(refreshed.status).toBe(200);
      const revoked = await postForm(
        base,
        '/revoke',
        form({ token: refreshed.json.access_token, client_id: reg.client_id, client_secret: reg.client_secret }),
      );
      expect(revoked.status).toBe(200);
    });

    it('claim 10 (guard): missing, wrong, stored hash, sentinel and foreign bound value are all invalid_client on every path variant', async () => {
      const row = await storedClient(store, db, reg.client_id);
      const sentinel = (JSON.parse(row!.json) as { client_secret: string }).client_secret;
      const foreign = await new ClientSecretBinder(crypto.randomBytes(32)).bound(row!.hash!);
      const bad = [undefined, 'f'.repeat(64), row!.hash!, sentinel, foreign];
      for (const path of ['/token', '/TOKEN', '/token/', '/Token//']) {
        for (const secret of bad) {
          const r = await postForm(base, path, dummyRefresh(reg.client_id, secret), { 'x-forwarded-for': `10.0.${bad.indexOf(secret)}.1` });
          expect(r.status, `${path} ${String(secret).slice(0, 12)}`).toBe(400);
          expect(r.json.error).toBe('invalid_client');
        }
      }
      for (const secret of bad) {
        const r = await postForm(base, '/revoke', form({ token: 'x', client_id: reg.client_id, client_secret: secret }), {
          'x-forwarded-for': '10.1.0.1',
        });
        expect(r.status).toBe(400);
        expect(r.json.error).toBe('invalid_client');
      }
      // The right secret on a path variant still reaches the grant.
      const ok = await postForm(base, '/TOKEN', dummyRefresh(reg.client_id, reg.client_secret), { 'x-forwarded-for': '10.2.0.1' });
      expect(ok.json.error).toBe('invalid_grant');
    });

    it('claim 11: bypassing our check fails closed (SDK alone, correct raw secret)', async () => {
      const provider = new ConnectorOAuthProvider(store, `${base}/mcp`, DEV_KEK_PEPPER);
      expect(await sdkAuth(provider.clientsStore, { client_id: reg.client_id, client_secret: reg.client_secret! })).toBe(
        'Invalid client_secret',
      );
    });

    it('claim 12: rollback fails closed (old getClient = raw stored JSON)', async () => {
      const oldStore = { getClient: (id: string) => store.getClient(id) } as OAuthRegisteredClientsStore;
      expect(await sdkAuth(oldStore, { client_id: reg.client_id, client_secret: reg.client_secret! })).toBe(
        'Invalid client_secret',
      );
      expect(await sdkAuth(oldStore, { client_id: reg.client_id })).toBe('Client secret is required');
    });

    it('claims 13, 22, 23, 28: migration hashes then scrubs on the parsed value, is idempotent, and fails closed on a sentinel with no hash', async () => {
      const s1 = crypto.randomBytes(32).toString('hex');
      const s2 = crypto.randomBytes(32).toString('hex');
      const s3 = crypto.randomBytes(32).toString('hex');
      const s4 = crypto.randomBytes(32).toString('hex');
      await rawClientRow(store, db, 'legacy-hash', legacyClientJson('legacy-hash', s1), sha256hex(s1));
      await rawClientRow(store, db, 'legacy-nohash', legacyClientJson('legacy-nohash', s2), null);
      await rawClientRow(store, db, 'legacy-name', legacyClientJson('legacy-name', s3, 'nkcs-scrubbed:'), sha256hex(s3));
      await rawClientRow(store, db, 'legacy-nul', legacyClientJson('legacy-nul', s4, 'a\u0000b\ud800c'), null);
      await rawClientRow(store, db, 'broken', '{"client_secret": "x"', null);
      await rawClientRow(store, db, 'sentinel-nohash', legacyClientJson('sentinel-nohash', `${SECRET_SENTINEL_PREFIX}abc`), null);

      // Before: the not-yet-migrated rows already authenticate through our check.
      for (const [id, s] of [['legacy-hash', s1], ['legacy-nohash', s2], ['legacy-name', s3], ['legacy-nul', s4]]) {
        const r = await postForm(base, '/token', dummyRefresh(id!, s), { 'x-forwarded-for': `10.3.0.${id!.length}` });
        expect(r.json.error, id).toBe('invalid_grant');
      }
      if (db) {
        const n = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM oauth_clients WHERE position('"client_secret":"' in client_json) > 0 AND position('"client_secret":"nkcs-scrubbed:' in client_json) = 0`,
        );
        expect(n.rows[0]!.n).toBe(4); // the four legacy rows; the broken row's spaced key and the sentinel row do not match
      }

      const first = await migrateClientSecrets(store);
      expect(first).toMatchObject({ migrated: 4, unparsable: 1, sentinelNoHash: 1, casMissed: 0, plaintextRemaining: 0 });
      for (const [id, s] of [['legacy-hash', s1], ['legacy-nohash', s2], ['legacy-name', s3], ['legacy-nul', s4]]) {
        const row = await storedClient(store, db, id!);
        expect(row!.json).not.toContain(s!);
        expect(row!.hash).toBe(sha256hex(s!));
        const r = await postForm(base, '/token', dummyRefresh(id!, s), { 'x-forwarded-for': `10.4.0.${id!.length}` });
        expect(r.json.error, id).toBe('invalid_grant');
      }
      const second = await migrateClientSecrets(store);
      expect(second.migrated).toBe(0);
      expect(second.unparsable).toBe(1);

      // Claim 22: sentinel with no hash is refused with and without a secret.
      for (const secret of [undefined, `${SECRET_SENTINEL_PREFIX}abc`, 'abc']) {
        const r = await postForm(base, '/token', dummyRefresh('sentinel-nohash', secret), { 'x-forwarded-for': '10.5.0.1' });
        expect(r.status).toBe(400);
        expect(r.json.error).toBe('invalid_client');
      }

      if (db) {
        // Claims 23 and 28: the text-only part B queries run despite NUL and
        // lone surrogates, and count nothing left after the migration.
        const q = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM oauth_clients WHERE position('"client_secret":"' in client_json) > 0 AND position('"client_secret":"nkcs-scrubbed:' in client_json) = 0`,
        );
        expect(q.rows[0]!.n).toBe(0);
        await expect(db.query(`SELECT count(*) FROM oauth_clients WHERE client_json::jsonb ? 'client_secret'`)).rejects.toThrow();
      }
    });

    if (kind === 'pglite') {
      it('claim 13: two concurrent migrations leave one consistent row', async () => {
        const fresh = await makeStore('pglite');
        const s = crypto.randomBytes(32).toString('hex');
        await rawClientRow(fresh.store, fresh.db, 'race', legacyClientJson('race', s), null);
        const [a, b] = await Promise.all([migrateClientSecrets(fresh.store), migrateClientSecrets(fresh.store)]);
        expect(a.migrated + b.migrated).toBe(1);
        const row = await storedClient(fresh.store, fresh.db, 'race');
        expect(row!.hash).toBe(sha256hex(s));
        expect(row!.json).not.toContain(s);
      });
    }
  });
}

describe('ADR 0061 /token and /revoke limiter', () => {
  async function flood(opts: { path: string; clientId: (i: number) => string; secret: string; xff?: (i: number) => string }) {
    const store = new InMemoryConnectorStorage();
    let reads = 0;
    const orig = store.getClientRecord.bind(store);
    store.getClientRecord = async (id: string) => {
      reads++;
      return orig(id);
    };
    const { base, close } = await serve(store);
    const reg = await registerClient(base, { confidential: true });
    reads = 0;
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 60; i++) {
      const id = opts.clientId(i) || reg.client_id;
      const body =
        opts.path === '/revoke'
          ? form({ token: 'x', client_id: id, client_secret: opts.secret })
          : dummyRefresh(id, opts.secret);
      const r = await postForm(base, opts.path, body, opts.xff ? { 'x-forwarded-for': opts.xff(i) } : {});
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get('retry-after');
    }
    await close();
    return { statuses, reads, retryAfter };
  }

  it('claim 21: 60 wrong secrets from one IP: 50 admitted, then 429 with retry-after (token and revoke)', async () => {
    for (const path of ['/token', '/revoke']) {
      const r = await flood({ path, clientId: () => '', secret: 'f'.repeat(64) });
      expect(r.statuses.slice(0, 50).every((s) => s === 400)).toBe(true);
      expect(r.statuses.slice(50).every((s) => s === 429)).toBe(true);
      expect(Number(r.retryAfter)).toBeGreaterThan(0);
      expect(r.reads).toBeLessThanOrEqual(100);
    }
    const unknown = await flood({ path: '/token', clientId: (i) => `unknown-${i}`, secret: 'x' });
    expect(unknown.statuses.filter((s) => s === 429).length).toBe(10);
  });

  it('claim 27: behind one appending proxy, a rotating first X-Forwarded-For entry does not escape the limit', async () => {
    const r = await flood({
      path: '/token',
      clientId: () => '',
      secret: 'f'.repeat(64),
      xff: (i) => `198.51.100.${i}, 203.0.113.9`,
    });
    expect(r.statuses.slice(0, 50).every((s) => s === 400)).toBe(true);
    expect(r.statuses.slice(50).every((s) => s === 429)).toBe(true);
  });

  it('CORS: a ChatGPT web origin can read our 400 and 429; another origin gets no ACAO', async () => {
    const store = new InMemoryConnectorStorage();
    const { base, close } = await serve(store);
    const reg = await registerClient(base, { confidential: true });
    const good = await postForm(base, '/token', dummyRefresh(reg.client_id, 'wrong'), { origin: 'https://chatgpt.com' });
    expect(good.status).toBe(400);
    expect(good.headers.get('access-control-allow-origin')).toBe('https://chatgpt.com');
    const evil = await postForm(base, '/token', dummyRefresh(reg.client_id, 'wrong'), { origin: 'https://evil.example' });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    await close();
  });
});

// Keep the type import used under isolatedModules.
export type _Unused = OAuthClientInformationFull;
