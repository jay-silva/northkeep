import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { inspect } from 'node:util';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { sha256hex } from '../src/hash.js';
import { ipRateLimitKey } from '../src/ip-key.js';
import {
  REDIRECT_URI,
  form,
  pgliteAsNeon,
  pkce,
  postForm,
  registerClient,
  signTestEntitlement,
  startServer,
  TEST_PEPPER_B64,
  withEnv,
  nowSec,
} from './adr0061-support.js';

/**
 * ADR 0061 code review round 1: F1 (the /token limiter keys IPv6 by /56 like
 * the SDK's express-rate-limit, claims 29 and 30) and F2 (a NUL in a scope or
 * id is refused before storage and no route error escapes as an unhandled
 * rejection, claims 31 and 32), plus claim 4 over all five gated routes.
 */

const maint = { run: false, purge: false, notes: ['test'] };
const SECRET = 'adr0061-code-r1-secret';

// The SDK's own limiter key function, reached through the SDK's dependency tree.
const sdkRequire = createRequire(
  createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/auth/handlers/token.js'),
);
const { ipKeyGenerator } = sdkRequire('express-rate-limit') as { ipKeyGenerator: (ip: string, subnet?: number) => string };

describe('claim 29: ipRateLimitKey groups addresses exactly as express-rate-limit ipKeyGenerator does', () => {
  it('same partition over a corpus of IPv4, IPv6, mapped and compressed forms', () => {
    const corpus = [
      '203.0.113.9',
      '198.51.100.1',
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:db8:1:2ff::1',
      '2001:db8:1:300::1',
      '2001:0db8:0001:0002:0000:0000:0000:0001',
      '2001:DB8:1:2::5',
      '::1',
      '::',
      'fe80::1',
      '::ffff:192.0.2.1',
      '::ffff:192.0.2.2',
      '64:ff9b::192.0.2.1',
      '2001:db8::',
      '2001:db8:0:ff::',
      '2001:db8:0:100::',
      'fe80::1%eth0',
      'fe80::1',
      '2001:db8:1:2::1%en0',
      '2001:db8:1:2ff::9%x',
    ];
    for (const a of corpus) {
      for (const b of corpus) {
        const ours = ipRateLimitKey(a) === ipRateLimitKey(b);
        const theirs = ipKeyGenerator(a, 56) === ipKeyGenerator(b, 56);
        expect(ours, `${a} vs ${b}`).toBe(theirs);
      }
    }
  });
});

describe('claim 30: the /token limiter holds against IPv6 rotation inside one /64 and one /56', () => {
  async function flood(xff: (i: number) => string, n = 120) {
    const store = new InMemoryConnectorStorage();
    const { base, close } = await withEnv(
      { CONNECTOR_ENTITLEMENT_SECRET: undefined, NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES: undefined },
      () => startServer(() => createConnectorServer(store, { maintenance: maint })),
    );
    const reg = await registerClient(base, { confidential: true });
    const statuses: Record<number, number> = {};
    for (let i = 0; i < n; i++) {
      const r = await postForm(
        base,
        '/token',
        form({ grant_type: 'refresh_token', refresh_token: 'x', client_id: reg.client_id, client_secret: 'f'.repeat(64) }),
        { 'x-forwarded-for': xff(i) },
      );
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    await close();
    return statuses;
  }
  const hex = (i: number) => i.toString(16);

  it('120 wrong secrets rotating inside 2001:db8:1:2::/64: 50 admitted, 70 refused with 429', async () => {
    expect(await flood((i) => `2001:db8:1:2::${hex(i + 1)}`)).toEqual({ 400: 50, 429: 70 });
  });

  it('120 wrong secrets rotating across /64s inside 2001:db8:1:200::/56: 50 admitted, 70 refused', async () => {
    expect(await flood((i) => `2001:db8:1:2${hex(i).padStart(2, '0')}::1`)).toEqual({ 400: 50, 429: 70 });
  });

  it('control: distinct /56s are distinct clients', async () => {
    expect(await flood((i) => `2001:db8:${hex(i + 1)}::1`, 60)).toEqual({ 400: 60 });
  });
});

type Kind = 'memory' | 'pglite';

async function makeStore(kind: Kind): Promise<ConnectorStorage> {
  if (kind === 'memory') return new InMemoryConnectorStorage();
  const s = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite()));
  await s.ensureSchema();
  return s;
}

/** Wrap a store so every method call after `arm()` is recorded by name. */
function counting(store: ConnectorStorage): { store: ConnectorStorage; calls: string[]; arm: () => void } {
  const calls: string[] = [];
  let armed = false;
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (armed) calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls, arm: () => (armed = true) };
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`claim 31: a NUL in a scope or id is refused before storage (${kind})`, () => {
    let base = '';
    let close: () => Promise<void>;
    let calls: string[];
    let arm: () => void;
    let raw: ConnectorStorage;
    const paidToken = crypto.randomBytes(24).toString('hex');
    const lapsedToken = crypto.randomBytes(24).toString('hex');

    beforeAll(async () => {
      raw = await makeStore(kind);
      await raw.upsertAccount(sha256hex(lapsedToken));
      await raw.setEntitledUntil(sha256hex(lapsedToken), Date.now() - 1000);
      const c = counting(raw);
      calls = c.calls;
      arm = c.arm;
      ({ base, close } = await withEnv(
        { CONNECTOR_ENTITLEMENT_SECRET: SECRET, CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64 },
        () => startServer(() => createConnectorServer(c.store, { maintenance: maint })),
      ));
      process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
      await fetch(`${base}/`); // settle the maintenance middleware first
      arm();
    }, 30_000);
    afterAll(async () => {
      await close();
      delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    });

    const paidHeaders = () => ({
      authorization: `Bearer ${paidToken}`,
      'x-nb-entitlement': signTestEntitlement(SECRET, { active: true, expSec: nowSec() + 3600 }),
    });

    it('DELETE /client/scope/a%00b: 400 for a lapsed and a paying account, no storage call, process alive', async () => {
      for (const headers of [{ authorization: `Bearer ${lapsedToken}` }, paidHeaders()]) {
        calls.length = 0;
        const res = await fetch(`${base}/client/scope/a%00b`, { method: 'DELETE', headers });
        expect(res.status).toBe(400);
        expect(calls).toEqual([]);
      }
      expect((await fetch(`${base}/`)).status).toBe(200);
    });

    it('PUT /client/entries: a NUL in any scope, entry field or shared_at is 400 before storage', async () => {
      const ok = { entry_id: 'e1', scope: 'w', entry_hash: 'h', type: 'semantic', content: 'c' };
      const bodies: Array<[string, unknown]> = [
        ['scopes[]', { scopes: ['a\u0000b'], entries: [] }],
        ['entry_id', { scopes: ['w'], entries: [{ ...ok, entry_id: 'e\u0000' }] }],
        ['entry scope', { scopes: ['w'], entries: [{ ...ok, scope: 'w\u0000' }] }],
        ['entry_hash', { scopes: ['w'], entries: [{ ...ok, entry_hash: 'h\u0000' }] }],
        ['shared_at key', { scopes: ['w'], entries: [ok], shared_at: { 'w\u0000': new Date().toISOString() } }],
        ['shared_at value', { scopes: ['w'], entries: [ok], shared_at: { w: '2026\u0000' } }],
      ];
      for (const [label, body] of bodies) {
        calls.length = 0;
        const put = await fetch(`${base}/client/entries`, {
          method: 'PUT',
          headers: { ...paidHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(put.status, label).toBe(400);
        expect(calls, label).toEqual([]);
      }
    });

    it('POST /client/ack: a NUL in server_id, local_entry_id or forgets is 400 before storage', async () => {
      const bodies: Array<[string, unknown]> = [
        ['server_id', { acked: [{ server_id: 'x\u0000', local_entry_id: 'y' }], forgets: [] }],
        ['local_entry_id', { acked: [{ server_id: 'x', local_entry_id: 'y\u0000' }], forgets: [] }],
        ['forgets', { acked: [], forgets: ['f\u0000'] }],
      ];
      for (const [label, body] of bodies) {
        calls.length = 0;
        const ack = await fetch(`${base}/client/ack`, {
          method: 'POST',
          headers: { ...paidHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(ack.status, label).toBe(400);
        expect(calls, label).toEqual([]);
      }
    });

    it('/token and /consent with a NUL client_id are 400, not a crash', async () => {
      const tok = await postForm(base, '/token', form({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'a\u0000b' }));
      expect(tok.status).toBe(400);
      const consent = await postForm(base, '/consent', form({ client_id: 'a\u0000b', code_challenge: 'c', pairing_code: 'ABCDEFGH' }));
      expect(consent.status).toBe(400);
      expect((await fetch(`${base}/`)).status).toBe(200);
    });
  });
}

describe('claim 32: a storage error in any route is a 500 JSON, logged without the account hash', () => {
  it('manifest with a failing store answers 500 and the process keeps serving', async () => {
    const store = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    const acct = sha256hex(token);
    store.listEntries = async () => {
      const err = new Error('invalid byte sequence for encoding "UTF8": 0x00') as Error & { params?: unknown[] };
      err.params = [acct];
      throw err;
    };
    // Inspect every argument the way Node's console does, so an error object
    // logged whole (its params carry the account hash) is caught.
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 5 }))).join(' '));
    });
    const { base, close } = await withEnv({ CONNECTOR_ENTITLEMENT_SECRET: undefined, NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES: undefined }, () =>
      startServer(() => createConnectorServer(store, { maintenance: maint })),
    );
    const res = await fetch(`${base}/client/manifest`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error.' });
    expect((await fetch(`${base}/`)).status).toBe(200);
    await close();
    spy.mockRestore();
    expect(logged.some((l) => l.includes('0x00'))).toBe(true);
    for (const l of logged) expect(l).not.toContain(acct);
  });
});

for (const kind of ['memory', 'pglite'] as const) {
  describe(`claim 4, all five gated routes (${kind})`, () => {
    it('a 402 on manifest, entries, pending, ack or pair/start creates no account row', async () => {
      const store = await makeStore(kind);
      const { base, close } = await withEnv(
        { CONNECTOR_ENTITLEMENT_SECRET: SECRET, CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64 },
        () => startServer(() => createConnectorServer(store, { maintenance: maint })),
      );
      await withEnv({ CONNECTOR_ENTITLEMENT_SECRET: SECRET }, async () => {
        const reqs: Array<[string, string, string | undefined]> = [
          ['GET', '/client/manifest', undefined],
          ['PUT', '/client/entries', JSON.stringify({ scopes: ['w'], entries: [] })],
          ['GET', '/client/pending', undefined],
          ['POST', '/client/ack', JSON.stringify({ acked: [], forgets: [] })],
          ['POST', '/pair/start', '{}'],
        ];
        for (const [method, path, body] of reqs) {
          const token = crypto.randomBytes(24).toString('hex');
          const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body,
          });
          expect(res.status, path).toBe(402);
          expect(await store.hasAccount(sha256hex(token)), path).toBe(false);
        }
      });
      await close();
    }, 30_000);
  });
}

for (const kind of ['memory', 'pglite'] as const) {
  describe(`/consent refuses control characters before storage and keeps the pairing code (${kind})`, () => {
    it('a NUL code_challenge is 400 and the same pairing code still works afterwards', async () => {
      const raw = await makeStore(kind);
      const c = counting(raw);
      const { base, close } = await withEnv(
        {
          CONNECTOR_ENTITLEMENT_SECRET: undefined,
          NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES: undefined,
          CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64,
        },
        () => startServer(() => createConnectorServer(c.store, { maintenance: maint })),
      );
      const reg = await registerClient(base, { confidential: false });
      const pair = await fetch(`${base}/pair/start`, {
        method: 'POST',
        headers: { authorization: `Bearer ${crypto.randomBytes(24).toString('hex')}`, 'content-type': 'application/json' },
        body: '{}',
      });
      const { pairing_code } = (await pair.json()) as { pairing_code: string };
      const { challenge } = pkce();
      const fields = {
        client_id: reg.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        state: 's',
        scope: 'mcp',
        resource: `${base}/mcp`,
        pairing_code,
      };
      c.arm();
      const bad: Array<[string, string]> = [
        ['code_challenge', form({ ...fields, code_challenge: 'a\u0000b' })],
        ['redirect_uri', form({ ...fields, redirect_uri: `${REDIRECT_URI}\u0000` })],
        ['state', form({ ...fields, state: 's\u0007' })],
        ['resource', form({ ...fields, resource: 'x\u007f' })],
        ['scope', form({ ...fields, scope: 'mcp\n' })],
        ['duplicated field', `${form(fields)}&code_challenge=second`],
      ];
      for (const [label, body] of bad) {
        c.calls.length = 0;
        const r = await fetch(`${base}/consent`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          redirect: 'manual',
          body,
        });
        expect(r.status, label).toBe(400);
        expect(c.calls, label).toEqual([]);
      }
      const good = await fetch(`${base}/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: form(fields),
      });
      expect(good.status).toBe(302);
      expect(new URL(good.headers.get('location')!).searchParams.get('code')).toBeTruthy();
      await close();
    }, 30_000);
  });
}
