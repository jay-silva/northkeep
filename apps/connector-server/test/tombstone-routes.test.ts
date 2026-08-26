import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { TOMBSTONE_USER_MESSAGE } from '../src/tombstones.js';

/**
 * PUT /client/entries tombstone enforcement (ADR 0038 addendum).
 * Uses its own servers so CONNECTOR_TOMBSTONE_ENFORCE is not toggled in
 * process.env (c2 and other files must stay 0.19.0 flag-off).
 */

const storageOff = new InMemoryConnectorStorage();
const storageOn = new InMemoryConnectorStorage();
let serverOff: Server;
let serverOn: Server;
let baseOff = '';
let baseOn = '';

const deviceSecret = crypto.randomBytes(32);
const connToken = deriveConnectorToken(deviceSecret);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function listen(
  app: ReturnType<typeof createConnectorServer>,
  port: number,
): Promise<[Server, string]> {
  const s = await new Promise<Server>((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
  });
  const addr = s.address() as AddressInfo;
  return [s, `http://127.0.0.1:${addr.port}`];
}

function entry(scope: string, id: string) {
  return { entry_id: id, entry_hash: '', scope, type: 'semantic', content: `memory ${id}` };
}

async function put(
  base: string,
  body: { scopes: string[]; entries: ReturnType<typeof entry>[]; shared_at?: Record<string, string> },
): Promise<Response> {
  return fetch(`${base}/client/entries`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function unshare(base: string, scope: string): Promise<Response> {
  return fetch(`${base}/client/scope/${encodeURIComponent(scope)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${connToken}` },
  });
}

beforeAll(async () => {
  const portOff = await freePort();
  const portOn = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${portOff}`;
  [serverOff, baseOff] = await listen(createConnectorServer(storageOff, { tombstoneEnforce: false }), portOff);
  [serverOn, baseOn] = await listen(createConnectorServer(storageOn, { tombstoneEnforce: true }), portOn);
});

afterAll(async () => {
  await new Promise<void>((r) => serverOff.close(() => r()));
  await new Promise<void>((r) => serverOn.close(() => r()));
});

describe('PUT /client/entries tombstones (flag off)', () => {
  it('0.19.0 compatible: unshare then re-push without shared_at succeeds', async () => {
    const first = await put(baseOff, { scopes: ['work'], entries: [entry('work', 'a')] });
    expect(first.status).toBe(200);
    const del = await unshare(baseOff, 'work');
    expect(del.status).toBe(200);
    expect(await storageOff.listTombstones(tokenHash(connToken))).toHaveLength(1);
    const again = await put(baseOff, { scopes: ['work'], entries: [entry('work', 'a')] });
    expect(again.status).toBe(200);
    expect(await storageOff.listEntries(tokenHash(connToken))).toHaveLength(1);
  });
});

describe.sequential('PUT /client/entries tombstones (flag on)', () => {
  it('never-unshared push without shared_at is 200', async () => {
    const res = await put(baseOn, { scopes: ['ops'], entries: [entry('ops', 'n1')] });
    expect(res.status).toBe(200);
  });

  it('tombstoned push without shared_at is 412 and names the scope', async () => {
    await put(baseOn, { scopes: ['work'], entries: [entry('work', 'w1')] });
    await unshare(baseOn, 'work');
    const res = await put(baseOn, { scopes: ['work'], entries: [entry('work', 'w1')] });
    expect(res.status).toBe(412);
    expect(res.status).not.toBe(409);
    const body = (await res.json()) as { error: string; scopes: string[] };
    expect(body.error).toBe(TOMBSTONE_USER_MESSAGE);
    expect(body.error).not.toContain('\u2014');
    expect(body.scopes).toEqual(['work']);
    expect(await storageOn.listEntries(tokenHash(connToken))).toHaveLength(1); // ops only
    expect((await storageOn.listEntries(tokenHash(connToken))).some((e) => e.scope === 'work')).toBe(false);
  });

  it('older shared_at is 412; newer shared_at is 200 and the tombstone is gone', async () => {
    const tombs = await storageOn.listTombstones(tokenHash(connToken));
    const work = tombs.find((t) => t.scope === 'work');
    expect(work).toBeDefined();
    const older = new Date(Date.parse(work!.unsharedAt) - 60_000).toISOString();
    const olderRes = await put(baseOn, {
      scopes: ['work'],
      entries: [entry('work', 'w2')],
      shared_at: { work: older },
    });
    expect(olderRes.status).toBe(412);

    const newer = new Date(Date.parse(work!.unsharedAt) + 60_000).toISOString();
    const newerRes = await put(baseOn, {
      scopes: ['work'],
      entries: [entry('work', 'w2')],
      shared_at: { work: newer },
    });
    expect(newerRes.status).toBe(200);
    expect((await storageOn.listTombstones(tokenHash(connToken))).some((t) => t.scope === 'work')).toBe(
      false,
    );
    expect((await storageOn.listEntries(tokenHash(connToken))).some((e) => e.entryId === 'w2')).toBe(true);
  });

  it('a later unshare outranks the previous shared_at (sequential race)', async () => {
    const tombsBefore = await storageOn.listTombstones(tokenHash(connToken));
    expect(tombsBefore.some((t) => t.scope === 'work')).toBe(false);
    await unshare(baseOn, 'work');
    const stale = new Date(Date.now() - 60_000).toISOString();
    const res = await put(baseOn, {
      scopes: ['work'],
      entries: [entry('work', 'w3')],
      shared_at: { work: stale },
    });
    expect(res.status).toBe(412);
    expect((await storageOn.listTombstones(tokenHash(connToken))).some((t) => t.scope === 'work')).toBe(
      true,
    );
  });
});
