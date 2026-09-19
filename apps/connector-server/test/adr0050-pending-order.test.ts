import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { connectAiApp, mcpToolCall } from './helpers.js';

/**
 * ADR 0050 Decision 3: GET /client/pending reads pending rows FIRST and
 * tombstones SECOND, as sequential awaits. A test that only runs the sequence
 * end to end passes with either order, so these two drive real route calls
 * through the betweenPendingReads seam, in the gap between the two reads. Swap
 * the awaits in create-server.ts and both go red; that is the point of them.
 */

const storage = new InMemoryConnectorStorage();
const deviceSecret = crypto.randomBytes(32);
const connToken = deriveConnectorToken(deviceSecret);
const account = tokenHash(connToken);

/** One-shot, so the second test's hook does not fire on the first test's call. */
let betweenReads: (() => Promise<void>) | null = null;

let syncServer: Server; // carries the seam; the route under test runs here
let appServer: Server; // a second instance over the SAME storage, driven from the seam
let syncBase = '';
let appBase = '';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function listen(app: ReturnType<typeof createConnectorServer>, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function push(base: string, scope: string, id: string, sharedAt?: string): Promise<Response> {
  return fetch(`${base}/client/entries`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      scopes: [scope],
      entries: [{ entry_id: id, entry_hash: '', scope, type: 'semantic', content: `memory ${id}` }],
      ...(sharedAt ? { shared_at: { [scope]: sharedAt } } : {}),
    }),
  });
}

async function unshare(base: string, scope: string): Promise<Response> {
  return fetch(`${base}/client/scope/${encodeURIComponent(scope)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${connToken}` },
  });
}

async function getPending(): Promise<{ entries: Array<{ server_id: string; scope: string; content: string }> }> {
  const resp = await fetch(`${syncBase}/client/pending`, {
    headers: { authorization: `Bearer ${connToken}` },
  });
  expect(resp.status).toBe(200);
  return (await resp.json()) as { entries: Array<{ server_id: string; scope: string; content: string }> };
}

beforeAll(async () => {
  const portSync = await freePort();
  const portApp = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${portSync}`;
  syncBase = process.env.PUBLIC_URL;
  syncServer = await listen(
    createConnectorServer(storage, {
      tombstoneEnforce: true,
      betweenPendingReads: async () => {
        const hook = betweenReads;
        betweenReads = null;
        if (hook) await hook();
      },
    }),
    portSync,
  );
  // The second instance must be built while PUBLIC_URL names ITS port, because
  // the OAuth resource/issuer are captured at construction.
  process.env.PUBLIC_URL = `http://127.0.0.1:${portApp}`;
  appBase = process.env.PUBLIC_URL;
  appServer = await listen(createConnectorServer(storage, { tombstoneEnforce: true }), portApp);
});

afterAll(async () => {
  await new Promise<void>((r) => syncServer.close(() => r()));
  await new Promise<void>((r) => appServer.close(() => r()));
});

describe('ADR 0050 /client/pending read order', () => {
  it('delivers a row written after a deliberate re-share that lands between the two reads', async () => {
    const scope = 'reshare-race';
    expect((await push(syncBase, scope, 'rr1')).status).toBe(200);
    expect((await unshare(syncBase, scope)).status).toBe(200);
    const tomb = (await storage.listTombstones(account)).find((t) => t.scope === scope)!;
    expect(tomb).toBeDefined();

    const CANARY = 'ADR0050-RESHARED-CANARY';
    let hookRan = false;
    betweenReads = async () => {
      // A real re-share: a later shared_at clears the tombstone.
      const later = new Date(Date.parse(tomb.unsharedAt) + 60_000).toISOString();
      const res = await push(appBase, scope, 'rr2', later);
      expect(res.status).toBe(200);
      expect((await storage.listTombstones(account)).some((t) => t.scope === scope)).toBe(false);
      // A real app write into the scope the user just re-shared.
      const token = await connectAiApp(appBase, deviceSecret);
      const wrote = await mcpToolCall(appBase, token, 'memory_remember', {
        content: CANARY,
        type: 'semantic',
        scope,
      });
      expect(wrote.text).toMatch(/Saved to shared scope/);
      hookRan = true;
    };

    await getPending();
    expect(hookRan).toBe(true);
    // The row was born after this call's pending read, so it is not in this
    // response. What matters is that the tombstone read, which came second,
    // could not name its scope: it survives and the next call delivers it.
    // Reverse the two awaits and that stale tombstone read destroys it here.
    const survivor = (await storage.listEntries(account)).find((e) => e.scope === scope && e.pending === true);
    expect(survivor).toBeDefined();

    const next = await getPending();
    const delivered = next.entries.filter((e) => e.scope === scope);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.server_id).toBe(survivor!.entryId);
    expect(delivered[0]!.content).toBe(CANARY);
  });

  it('withholds and drains a row when an unshare lands between the two reads', async () => {
    const scope = 'unshare-race';
    expect((await push(syncBase, scope, 'ur1')).status).toBe(200);
    const token = await connectAiApp(appBase, deviceSecret);
    const CANARY = 'ADR0050-RACED-CANARY';
    const wrote = await mcpToolCall(appBase, token, 'memory_remember', {
      content: CANARY,
      type: 'semantic',
      scope,
    });
    expect(wrote.text).toMatch(/Saved to shared scope/);
    const pendingId = /id: (conn_[0-9a-f]+)/.exec(wrote.text)![1]!;

    let hookRan = false;
    betweenReads = async () => {
      expect((await unshare(appBase, scope)).status).toBe(200);
      hookRan = true;
    };

    const body = await getPending();
    expect(hookRan).toBe(true);
    expect(body.entries.some((e) => e.scope === scope)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(await storage.getEntry(account, pendingId)).toBeNull();
  });
});
