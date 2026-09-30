import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView } from '@northkeep/core';
import { emptyProjectDoc, mergeProjectDoc, serializeProjectDoc } from '@northkeep/core/project-doc';
import { applyDownSync, deriveConnectorToken, pushSharedScopes, startPairing, STALE_PUSH_MESSAGE, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage, type SharedEntry } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { pgliteAsNeon, startServer, TEST_PEPPER_B64, withEnv, REDIRECT_URI } from './adr0061-support.js';

/**
 * ADR 0063 on the connector, end to end over HTTP, on the in-memory store and
 * on the real Neon SQL over PGlite (numbers returned as strings, as Neon's HTTP
 * driver returns int8). The adversarial review's attacks (NorthKeep/Reviews/
 * adr-0063) are replayed here against the built rules. The connector's half of
 * the incident replay is what it can prove on its own: an old client never
 * gets the cloud document, a new client gets it with its base, and once the
 * newer head is pushed the connector serves that head and flags the row stale.
 */

type Pending = {
  entries: Array<{ server_id: string; scope: string; type: string; content: string; base_revision?: string; stale?: boolean }>;
  forgets: Array<{ entry_id: string }>;
};
type Call = { text: string; isError: boolean; structured: Record<string, unknown> | undefined };

function doc(status: string): string {
  return serializeProjectDoc(mergeProjectDoc(emptyProjectDoc(), { whatWhy: 'Guardrails.', status, logEntry: 'seeded' }));
}

async function readRpc(resp: Response): Promise<any> {
  const text = await resp.text();
  if ((resp.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0063-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0063 connector (${kind})`, () => {
    let storage: ConnectorStorage;
    let base = '';
    let close: () => Promise<void> = async () => {};
    let n = 0;

    beforeAll(async () => {
      if (kind === 'memory') storage = new InMemoryConnectorStorage();
      else {
        const s = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite(), { numbersAsStrings: true }));
        await s.ensureSchema();
        storage = s;
      }
      await withEnv({ CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64 }, async () => {
        ({ base, close } = await startServer(() => createConnectorServer(storage)));
      });
      if (kind === 'pglite') process.env.CONNECTOR_KEK_PEPPER = TEST_PEPPER_B64;
    }, 60_000);
    afterAll(async () => {
      await close();
      delete process.env.CONNECTOR_KEK_PEPPER;
    });

    /** A fresh account: a real vault with one shared project, pushed, and an AI app connected to it. */
    async function world(slug = 'a') {
      n++;
      const deviceSecret = generateDeviceSecret();
      const connToken = deriveConnectorToken(deviceSecret);
      const account = tokenHash(connToken);
      const vaultPath = path.join(tmpRoot, `${kind}-${n}.nkv`);
      const vault = Vault.create({ path: vaultPath, passphrase: 'guardrails pass', deviceSecret, kdf: KDF_INTERACTIVE });
      vault.remember({ content: doc('R1 status.'), type: 'working', scope: `project:${slug}` });
      vault.setScopeShared(`project:${slug}`, true);
      vault.save();

      const pairingCode = await startPairing({ server: base, deviceSecret });
      const reg = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'adr0063', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
        }),
      }).then((r) => r.json());
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url');
      const resource = `${base}/mcp`;
      const consent = await fetch(`${base}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_challenge: challenge,
          state: 's', scope: 'mcp', resource, pairing_code: pairingCode }).toString(),
      });
      const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
      const tok = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
          client_id: reg.client_id, code_verifier: verifier, resource }),
      }).then((r) => r.json());
      const token = tok.access_token as string;

      const mcp = async (name: string, args: Record<string, unknown>): Promise<Call> => {
        const call = await readRpc(await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        }));
        return {
          text: (call?.result?.content?.[0]?.text ?? call?.error?.message ?? '') as string,
          isError: call?.result?.isError === true,
          structured: call?.result?.structuredContent,
        };
      };
      const auth = { authorization: `Bearer ${connToken}` };
      const pending = async (v2: boolean): Promise<Pending> =>
        (await fetch(`${base}/client/pending${v2 ? '?v=2' : ''}`, { headers: auth })).json() as Promise<Pending>;
      const post = async (p: string, body: unknown) =>
        fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const rawPush = async (body: Record<string, unknown>) =>
        fetch(`${base}/client/entries`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const push = () => pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
      const head = () => getProjectView(vault, slug);
      const rows = async () => (await storage.listEntries(account)).filter((e) => e.scope === `project:${slug}`);
      /** Rewrite a stored row as a pre-ADR connector would have left it: base NULL. */
      const demoteToLegacy = async (id: string) => {
        const e = (await storage.getEntry(account, id))!;
        const { baseRevision: _b, ...legacy } = e;
        await storage.putEntry(account, legacy as SharedEntry);
      };
      await push();
      return { deviceSecret, connToken, account, vault, mcp, pending, post, rawPush, push, head, rows, demoteToLegacy };
    }

    it('incident replay, the connector half: an old client never gets the cloud document; ?v=2 gets it with base R1; after R2 is pushed the connector serves R2 and flags the row stale', async () => {
      const w = await world();
      const r1 = w.head().revision;
      const got = await w.mcp('project_get', { project: 'a' });
      expect(got.structured).toEqual({ project: 'a', revision: r1 });
      expect(got.text.endsWith(`Revision: ${r1} (pass it as expected_revision to project_update)`)).toBe(true);
      const up = await w.mcp('project_update', { project: 'a', expected_revision: r1, status: 'CLOUD TEXT.' });
      expect(up.isError).toBe(false);
      const cloudId = up.structured!.revision as string;

      // The Mac saves R2 and does not push.
      w.vault.editMemory(r1, { content: doc('R2 LOCAL SAVE.') });
      w.vault.save();
      const r2 = w.head().revision;

      // (a) A 0.22.x client reads /client/pending without ?v=2 and never sees the document.
      expect((await w.pending(false)).entries.filter((e) => e.scope === 'project:a')).toEqual([]);
      // (a2) The new client holds it as a conflict: the head stays R2, the row stays pending.
      const down = await applyDownSync({ server: base, deviceSecret: w.deviceSecret, vault: w.vault });
      expect({ added: down.added, replaced: down.replaced, deduped: down.deduped }).toEqual({ added: 0, replaced: 0, deduped: 0 });
      expect(down.conflicts.map((c) => ({ id: c.server_id, base: c.base_revision, local: c.local_revision, reason: c.reason }))).toEqual([
        { id: cloudId, base: r1, local: r2, reason: 'moved' },
      ]);
      expect(w.head().revision).toBe(r2);
      expect(w.head().content).toContain('R2 LOCAL SAVE.');
      expect((await storage.getEntry(w.account, cloudId))?.pending).toBe(true);

      // (b) A new client sees the row, its base and that the connector still serves it.
      const before = (await w.pending(true)).entries.filter((e) => e.scope === 'project:a');
      expect(before.map((e) => ({ id: e.server_id, base: e.base_revision, stale: e.stale }))).toEqual([
        { id: cloudId, base: r1, stale: false },
      ]);

      // (c) R2 reaches the connector: it serves R2, the row is stale and hidden from every read tool.
      await w.push();
      const after = await w.mcp('project_get', { project: 'a' });
      expect(after.structured).toEqual({ project: 'a', revision: r2 });
      expect(after.text).toContain('R2 LOCAL SAVE.');
      expect(after.text).not.toContain('CLOUD TEXT.');
      const flagged = (await w.pending(true)).entries.filter((e) => e.scope === 'project:a');
      expect(flagged.map((e) => ({ id: e.server_id, base: e.base_revision, stale: e.stale }))).toEqual([
        { id: cloudId, base: r1, stale: true },
      ]);
      expect((await w.mcp('memory_list', {})).text).not.toContain('CLOUD TEXT.');
      expect((await w.mcp('memory_retrieve', { query: 'cloud text' })).text).not.toContain('CLOUD TEXT.');
      expect((await w.mcp('search', { query: 'cloud text' })).text).not.toContain(cloudId);
      expect((await w.mcp('fetch', { id: cloudId })).isError).toBe(true);
      const list = JSON.parse((await w.mcp('project_list', {})).text) as { projects: Array<Record<string, unknown>> };
      expect(list.projects).toEqual([{ project: 'a', scope: 'project:a', status: 'R2 LOCAL SAVE.', id: r2, revision: r2 }]);

      // (d) A cloud session still holding R1 is refused with the current document.
      const late = await w.mcp('project_update', { project: 'a', expected_revision: r1, status: 'LATE CLOUD.' });
      expect(late.isError).toBe(true);
      expect(late.text.startsWith(`Project changed after it was read. Nothing was saved. The current document follows; its revision is ${r2}.`)).toBe(true);
      expect(late.structured).toMatchObject({ code: 'stale_project', project: 'a', revision: r2 });
      expect((await w.rows()).filter((e) => e.pending).map((e) => e.entryId)).toEqual([cloudId]);
    });

    it('a fast-forward is served and acked; the acked row outranks the old pushed row on both stores with no re-push (A3)', async () => {
      const w = await world();
      const r1 = w.head().revision;
      const up = await w.mcp('project_update', { project: 'a', expected_revision: r1, status: 'CLOUD FF.' });
      const c1 = up.structured!.revision as string;
      const second = await w.mcp('project_update', { project: 'a', expected_revision: c1, status: 'CLOUD FF TWO.' });
      const c2 = second.structured!.revision as string;
      expect(c2).not.toBe(c1);
      expect((await storage.getEntry(w.account, c2))?.baseRevision).toBe(r1);
      expect(await storage.getEntry(w.account, c1)).toBeNull();
      expect((await w.pending(true)).entries.map((e) => ({ id: e.server_id, base: e.base_revision, stale: e.stale }))).toEqual([
        { id: c2, base: r1, stale: false },
      ]);
      // The device applies it as H2 and acks, without pushing.
      const ack = await w.post('/client/ack', { acked: [{ server_id: c2, local_entry_id: 'H2-local-id' }], forgets: [] });
      expect(ack.status).toBe(200);
      const got = await w.mcp('project_get', { project: 'a' });
      expect(got.structured).toEqual({ project: 'a', revision: 'H2-local-id' });
      expect(got.text).toContain('CLOUD FF TWO.');
      const byId = Object.fromEntries((await w.rows()).map((e) => [e.entryId, { pending: e.pending === true, seq: e.writeSeq }]));
      expect(byId).toEqual({ [r1]: { pending: false, seq: 1 }, 'H2-local-id': { pending: false, seq: 4 } });
    });

    it('two updates with the same expected_revision fired together: exactly one lands and a held stale row survives both', async () => {
      const w = await world();
      const r1 = w.head().revision;
      await w.mcp('project_update', { project: 'a', expected_revision: r1, status: 'HELD.' });
      w.vault.editMemory(r1, { content: doc('R2.') });
      w.vault.save();
      await w.push();
      const r2 = w.head().revision;
      const held = (await w.rows()).find((e) => e.pending)!.entryId;
      const [x, y] = await Promise.all([
        w.mcp('project_update', { project: 'a', expected_revision: r2, status: 'SESSION ONE.' }),
        w.mcp('project_update', { project: 'a', expected_revision: r2, status: 'SESSION TWO.' }),
      ]);
      expect([x.isError, y.isError].sort()).toEqual([false, true]);
      const loser = x.isError ? x : y;
      expect(loser.structured).toMatchObject({ code: 'stale_project', project: 'a' });
      const pendingIds = (await w.rows()).filter((e) => e.pending).map((e) => e.entryId).sort();
      const winner = ((x.isError ? y : x).structured!.revision as string);
      expect(pendingIds).toEqual([held, winner].sort());
    });

    it('legacy rows (A2 shape): never served, never merged into, flagged stale on ?v=2 with no base, withheld from v1; refusals name the waiting conflict', async () => {
      const w = await world('b');
      const r1 = w.head().revision;
      const up = await w.mcp('project_update', { project: 'b', expected_revision: r1, status: 'LEGACY CLOUD.' });
      const x = up.structured!.revision as string;
      await w.demoteToLegacy(x);
      expect((await storage.getEntry(w.account, x))?.baseRevision).toBeUndefined();
      expect((await w.mcp('project_get', { project: 'b' })).structured).toEqual({ project: 'b', revision: r1 });
      const v2 = (await w.pending(true)).entries.filter((e) => e.scope === 'project:b');
      expect(v2).toHaveLength(1);
      expect(v2[0]!.server_id).toBe(x);
      expect('base_revision' in v2[0]!).toBe(false);
      expect(v2[0]!.stale).toBe(true);
      expect((await w.pending(false)).entries.filter((e) => e.scope === 'project:b')).toEqual([]);

      // No pushed document left, only the legacy row.
      w.vault.deleteProject('b');
      w.vault.save();
      await w.push();
      expect((await w.rows()).map((e) => e.entryId)).toEqual([x]);
      const get = await w.mcp('project_get', { project: 'b' });
      expect(get.text).toBe('No live project document for "b": a cloud version is waiting for the user to review it in NorthKeep.');
      const waiting = 'Nothing was saved: a cloud version of project "b" is waiting for the user to review it in NorthKeep. Ask them to resolve it there, then call project_get.';
      expect((await w.mcp('project_update', { project: 'b', expected_revision: x, status: 'no' })).text).toBe(waiting);
      expect((await w.mcp('project_create', { project: 'b', what_why: 'w', status: 's' })).text).toBe(waiting);
      expect(JSON.parse((await w.mcp('project_list', {})).text)).toEqual({
        projects: [{ project: 'b', scope: 'project:b', status: '', id: null, revision: null, conflict: 'A cloud version is waiting for the user to review it in NorthKeep.' }],
      });
    });

    it('a stale row whose text the device already has is discarded by id, not acked: the pushed head does not move', async () => {
      const w = await world();
      const r1 = w.head().revision;
      const up = await w.mcp('project_update', { project: 'a', expected_revision: r1, status: 'SAME TEXT.' });
      const x = up.structured!.revision as string;
      const cloudText = (await w.pending(true)).entries.find((e) => e.server_id === x)!.content;
      w.vault.editMemory(r1, { content: cloudText });
      w.vault.save();
      await w.push();
      const h = w.head().revision;
      expect((await w.pending(true)).entries.find((e) => e.server_id === x)?.stale).toBe(true);
      const seqBefore = await storage.readScopeSeq(w.account, 'project:a');
      const res = await w.post('/client/discard', { server_ids: [x, h] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, discarded: 1 });
      expect((await w.rows()).map((e) => ({ id: e.entryId, pending: e.pending === true }))).toEqual([{ id: h, pending: false }]);
      expect(await storage.readScopeSeq(w.account, 'project:a')).toBe(seqBefore + 1);
      expect((await w.mcp('project_get', { project: 'a' })).structured).toEqual({ project: 'a', revision: h });
    });

    it('/client/discard refuses a malformed body and a missing token', async () => {
      const w = await world();
      expect((await w.post('/client/discard', { server_ids: 'x' })).status).toBe(400);
      expect((await w.post('/client/discard', { server_ids: [1] })).status).toBe(400);
      expect((await w.post('/client/discard', { server_ids: ['a\u0000b'] })).status).toBe(400);
      const anon = await fetch(`${base}/client/discard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"server_ids":[]}' });
      expect(anon.status).toBe(401);
    });

    it('a cloud create is base new: withheld from v1, current on ?v=2, stale once the device pushes its own document', async () => {
      const w = await world('a');
      const c = await w.mcp('project_create', { project: 'fresh', what_why: 'Cloud made it.', status: 'CLOUD CREATE.' });
      const id = c.structured!.revision as string;
      expect((await w.pending(false)).entries.filter((e) => e.scope === 'project:fresh')).toEqual([]);
      expect((await w.pending(true)).entries.filter((e) => e.scope === 'project:fresh').map((e) => ({ id: e.server_id, base: e.base_revision, stale: e.stale }))).toEqual([
        { id, base: 'new', stale: false },
      ]);
      w.vault.remember({ content: doc('LOCAL FRESH.'), type: 'working', scope: 'project:fresh' });
      w.vault.setScopeShared('project:fresh', true);
      w.vault.save();
      await w.push();
      expect((await w.pending(true)).entries.find((e) => e.server_id === id)?.stale).toBe(true);
      expect((await w.mcp('project_get', { project: 'fresh' })).text).toContain('LOCAL FRESH.');
    });

    it('memory_remember refuses a working row in a project scope (R-S1) and still takes other memories there', async () => {
      const w = await world();
      const before = (await w.rows()).length;
      const refused = await w.mcp('memory_remember', { content: 'scratch typed working', type: 'working', scope: 'project:a' });
      expect(refused.text).toBe(
        'Nothing was saved: the project document in "project:a" changes only through project_update. Call project_get, then project_update with its revision. To keep a note in this project, use another memory type, such as episodic.',
      );
      expect((await w.rows()).length).toBe(before);
      const ok = await w.mcp('memory_remember', { content: 'a project note', type: 'episodic', scope: 'project:a' });
      expect(ok.text.startsWith('Saved to shared scope "project:a".')).toBe(true);
      const v1 = (await w.pending(false)).entries.filter((e) => e.scope === 'project:a');
      expect(v1.map((e) => ({ type: e.type, content: e.content }))).toEqual([{ type: 'episodic', content: 'a project note' }]);
      const v2 = (await w.pending(true)).entries.filter((e) => e.scope === 'project:a');
      expect(v2.map((e) => ({ type: e.type, stale: e.stale, hasBase: 'base_revision' in e }))).toEqual([
        { type: 'episodic', stale: false, hasBase: false },
      ]);
    });

    it('the 428 guard over HTTP: an older vault version is refused and the newer document stays served (A4); reset unwedges; bad claims are 400', async () => {
      const w = await world('d');
      const entry = (status: string) => ({ entry_id: `id-${status}`, entry_hash: '', scope: 'project:d', type: 'working', content: doc(status) });
      const S = 'a1b2c3d4e5f60718';
      const newer = await w.rawPush({ scopes: ['project:d'], entries: [entry('R2 NEW.')], vault: { server: S, version: 2 } });
      expect(newer.status).toBe(200);
      const older = await w.rawPush({ scopes: ['project:d'], entries: [entry('R1 OLD.')], vault: { server: S, version: 1 } });
      expect(older.status).toBe(428);
      expect(await older.json()).toEqual({
        error: 'Cloud Connect already has a copy from a newer version of your vault. Sync this device first. If your sync account was recreated, push once with northkeep share push --reset-order.',
        code: 'stale_push',
        vault_version: 2,
      });
      expect((await w.mcp('project_get', { project: 'd' })).text).toContain('R2 NEW.');
      // A push with no vault (an old client, or a device with no vault sync) is refused once a pair is recorded.
      const oldClient = await w.push().then(() => 200, (e: Error) => e.message);
      expect(oldClient).toBe(STALE_PUSH_MESSAGE);
      const equal = await w.rawPush({ scopes: ['project:d'], entries: [entry('R2 NEW.')], vault: { server: S, version: 2 } });
      expect(equal.status).toBe(200);
      const reset = await w.rawPush({ scopes: ['project:d'], entries: [entry('RESTARTED.')], vault: { server: S, version: 1 }, reset: true });
      expect(reset.status).toBe(200);
      expect((await w.mcp('project_get', { project: 'd' })).text).toContain('RESTARTED.');
      for (const bad of [
        { vault: { server: 'NOTHEX', version: 1 } },
        { vault: { server: S, version: -1 } },
        { vault: { server: S, version: 1.5 } },
        { vault: { server: S } },
        { vault: 'x' },
        { reset: 'yes' },
      ]) {
        expect((await w.rawPush({ scopes: ['project:d'], entries: [entry('BAD.')], ...bad })).status).toBe(400);
      }
      expect((await w.mcp('project_get', { project: 'd' })).text).toContain('RESTARTED.');
    });

    it('a stale push racing an unshare: 412 with enforcement on, and still 428, never a silent write, with it off', async () => {
      const w = await world('e');
      const S = '00000000000000aa';
      const entry = { entry_id: 'e1', entry_hash: '', scope: 'project:e', type: 'working', content: doc('E.') };
      expect((await w.rawPush({ scopes: ['project:e'], entries: [entry], vault: { server: S, version: 5 } })).status).toBe(200);
      await fetch(`${base}/client/scope/${encodeURIComponent('project:e')}`, { method: 'DELETE', headers: { authorization: `Bearer ${w.connToken}` } });
      const off = await w.rawPush({ scopes: ['project:e'], entries: [entry], vault: { server: S, version: 4 } });
      expect(off.status).toBe(428);
      expect(await w.rows()).toEqual([]);
      const enforced = await withEnv({ CONNECTOR_KEK_PEPPER: kind === 'memory' ? undefined : TEST_PEPPER_B64 }, () =>
        startServer(() => createConnectorServer(storage, { tombstoneEnforce: true })),
      );
      try {
        const on = await fetch(`${enforced.base}/client/entries`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${w.connToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ scopes: ['project:e'], entries: [entry], vault: { server: S, version: 4 } }),
        });
        expect(on.status).toBe(412);
      } finally {
        await enforced.close();
      }
      expect(await w.rows()).toEqual([]);
    });
  });
}

describe('ADR 0063 tombstone enforcement is visible, read-only', () => {
  it('the health page and the manifest report the parsed flag', async () => {
    const lines: Record<string, string> = {};
    for (const [label, value] of [['unset', undefined], ['zero', '0'], ['one', '1'], ['true', 'true']] as const) {
      await withEnv({ CONNECTOR_TOMBSTONE_ENFORCE: value }, async () => {
        const storage = new InMemoryConnectorStorage();
        const srv = await startServer(() => createConnectorServer(storage));
        try {
          const html = await (await fetch(`${srv.base}/`)).text();
          const token = 'manifest-token-0123456789';
          const manifest = (await (await fetch(`${srv.base}/client/manifest`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
            tombstone_enforce: boolean;
          };
          lines[label] = `${/Tombstone enforcement: (on|off)/.exec(html)?.[1]} ${manifest.tombstone_enforce}`;
        } finally {
          await srv.close();
        }
      });
    }
    expect(lines).toEqual({ unset: 'off false', zero: 'off false', one: 'on true', true: 'on true' });
  });

  it('the health page calls no storage method, even as the first request with maintenance on', async () => {
    const calls: string[] = [];
    const inner = new InMemoryConnectorStorage();
    const spy = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const logs: string[] = [];
    const srv = await startServer(() =>
      createConnectorServer(spy, { maintenance: { run: true, purge: true, notes: [] }, maintenanceLog: (l) => logs.push(l) }),
    );
    try {
      const res = await fetch(`${srv.base}/`);
      expect(res.status).toBe(200);
      expect(calls).toEqual([]);
      await fetch(`${srv.base}/client/manifest`, { headers: { authorization: 'Bearer manifest-token-0123456789' } });
      expect(calls).toContain('gcOAuth');
    } finally {
      await srv.close();
    }
  });
});
