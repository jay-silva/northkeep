import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { sha256hex } from '../src/hash.js';

const LOST = crypto.randomBytes(32).toString('base64');
const LIVE = crypto.randomBytes(32).toString('base64');

const savedEnv = {
  cur: process.env.CONNECTOR_KEK_PEPPER,
  next: process.env.CONNECTOR_KEK_PEPPER_NEXT,
  allow: process.env.NORTHKEEP_CONNECTOR_ALLOW_REBUILD,
};
afterEach(() => {
  restore('CONNECTOR_KEK_PEPPER', savedEnv.cur);
  restore('CONNECTOR_KEK_PEPPER_NEXT', savedEnv.next);
  restore('NORTHKEEP_CONNECTOR_ALLOW_REBUILD', savedEnv.allow);
});
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** One listener whose app can be rebuilt under a different pepper, keeping keep-alive sockets valid. */
async function harness(storage: InMemoryConnectorStorage, allowRebuild = true) {
  let handler: http.RequestListener = () => {};
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUBLIC_URL = base;
  delete process.env.CONNECTOR_KEK_PEPPER_NEXT;
  if (allowRebuild) process.env.NORTHKEEP_CONNECTOR_ALLOW_REBUILD = 'on';
  else delete process.env.NORTHKEEP_CONNECTOR_ALLOW_REBUILD;
  return {
    base,
    pepper(value: string): void {
      process.env.CONNECTOR_KEK_PEPPER = value;
      handler = createConnectorServer(storage);
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function push(base: string, token: string, scopes: Record<string, string[]>, rebuild = false): Promise<Response> {
  const entries = Object.entries(scopes).flatMap(([scope, ids]) =>
    ids.map((id) => ({ entry_id: id, entry_hash: '', scope, type: 'fact', content: `memory ${id}` })),
  );
  return fetch(`${base}/client/entries`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: Object.keys(scopes), entries, ...(rebuild ? { rebuild: true } : {}) }),
  });
}

async function pairCode(base: string, token: string): Promise<string> {
  const resp = await fetch(`${base}/pair/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(resp.status).toBe(200);
  return ((await resp.json()) as { pairing_code: string }).pairing_code;
}

const ids = async (storage: InMemoryConnectorStorage, token: string) =>
  (await storage.listEntries(sha256hex(token))).map((e) => e.entryId).sort();

describe('rebuilding a connector account whose key no longer opens', () => {
  it('a plain push stays refused, and changes nothing', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = deriveConnectorToken(crypto.randomBytes(32));
    const h = await harness(storage);
    try {
      h.pepper(LOST);
      expect((await push(h.base, token, { work: ['a', 'b'] })).status).toBe(200);
      h.pepper(LIVE);
      const resp = await push(h.base, token, { work: ['c'] });
      expect(resp.status).toBe(409);
      expect(((await resp.json()) as { message: string }).message).toContain('--rebuild');
      expect(await ids(storage, token)).toEqual(['a', 'b']);
    } finally {
      await h.close();
    }
  });

  it("the owner's rebuild drops the dead key, its rows and its sign-ins, and stores the push under a fresh key", async () => {
    const storage = new InMemoryConnectorStorage();
    const token = deriveConnectorToken(crypto.randomBytes(32));
    const h = await harness(storage);
    try {
      h.pepper(LOST);
      expect((await push(h.base, token, { work: ['a', 'b'], home: ['h'] })).status).toBe(200);
      const oldCode = await pairCode(h.base, token);
      const tokenHash = 'f'.repeat(64);
      await storage.putToken(tokenHash, {
        clientId: 'app', accountHash: sha256hex(token), audience: `${h.base}/mcp`, kind: 'access',
        expiresAt: Math.floor(Date.now() / 1000) + 3600, dekWrap: 'nkw1:old',
      } as Parameters<InMemoryConnectorStorage['putToken']>[1]);
      h.pepper(LIVE);
      expect((await push(h.base, token, { work: ['c'] }, true)).status).toBe(200);
      expect(await ids(storage, token)).toEqual(['c']);
      expect(await storage.consumePairingCode(sha256hex(oldCode))).toBeNull();
      expect(await storage.getToken(tokenHash)).toBeNull();
      const audit = storage.auditRows().filter((a) => a.tool === 'client_rebuild' && a.accountHash === sha256hex(token));
      expect(audit.map((a) => a.resultCount)).toEqual([3]);
      expect((await push(h.base, token, { work: ['c', 'd'] })).status).toBe(200);
      expect(await ids(storage, token)).toEqual(['c', 'd']);
      await pairCode(h.base, token);
    } finally {
      await h.close();
    }
  });

  it('with the operator switch off, a rebuild is refused, says so, and changes nothing', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = deriveConnectorToken(crypto.randomBytes(32));
    const h = await harness(storage, false);
    try {
      h.pepper(LOST);
      expect((await push(h.base, token, { work: ['a', 'b'] })).status).toBe(200);
      h.pepper(LIVE);
      const resp = await push(h.base, token, { work: ['c'] }, true);
      expect(resp.status).toBe(409);
      const body = (await resp.json()) as { rebuild: string; message: string };
      expect(body.rebuild).toBe('unavailable');
      expect(body.message).not.toContain('--rebuild');
      expect(await ids(storage, token)).toEqual(['a', 'b']);
    } finally {
      await h.close();
    }
  });

  it('a rebuild flag on an account that opens is ignored', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = deriveConnectorToken(crypto.randomBytes(32));
    const h = await harness(storage);
    try {
      h.pepper(LIVE);
      expect((await push(h.base, token, { work: ['a'], home: ['h'] })).status).toBe(200);
      const code = await pairCode(h.base, token);
      expect((await push(h.base, token, { work: ['b'] }, true)).status).toBe(200);
      expect(await ids(storage, token)).toEqual(['b', 'h']);
      expect(await storage.consumePairingCode(sha256hex(code))).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it("one device's rebuild cannot touch another account", async () => {
    const storage = new InMemoryConnectorStorage();
    const victim = deriveConnectorToken(crypto.randomBytes(32));
    const other = deriveConnectorToken(crypto.randomBytes(32));
    const h = await harness(storage);
    try {
      h.pepper(LOST);
      expect((await push(h.base, victim, { work: ['v1', 'v2'] })).status).toBe(200);
      h.pepper(LIVE);
      expect((await push(h.base, other, { work: ['o'] }, true)).status).toBe(200);
      expect(await ids(storage, victim)).toEqual(['v1', 'v2']);
      expect((await push(h.base, victim, { work: ['v3'] })).status).toBe(409);
    } finally {
      await h.close();
    }
  });

  it('a reset against a wrap that has already changed does nothing', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = deriveConnectorToken(crypto.randomBytes(32));
    const h = await harness(storage);
    try {
      h.pepper(LIVE);
      expect((await push(h.base, token, { work: ['a'] })).status).toBe(200);
      expect(await storage.resetAccountKey(sha256hex(token), 'nkw1:not-the-stored-wrap')).toBeNull();
      expect(await ids(storage, token)).toEqual(['a']);
      expect(await storage.getAccountDekWrap(sha256hex(token))).toBeTruthy();
    } finally {
      await h.close();
    }
  });
});
