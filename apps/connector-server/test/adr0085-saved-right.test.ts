import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, getProjectView, tameOneLine as coreTame } from '@northkeep/core';
import { emptyProjectDoc, mergeProjectDoc, serializeProjectDoc } from '@northkeep/core/project-doc';
import { applyDownSync, deriveConnectorToken, pushSharedScopes, startPairing, tokenHash, unshareScope } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { SAVE_HOLD_ADVICE } from '../src/mcp.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { tameAppName, tameOneLine } from '../src/text-safe.js';
import { pgliteAsNeon, startServer, TEST_PEPPER_B64, withEnv, REDIRECT_URI } from './adr0061-support.js';
import { plantWorkingRow } from '../../../packages/core/test/support/plant-working-row.js';

/**
 * ADR 0085 on the connector, end to end over HTTP with a real vault, on the
 * in-memory store and on the Neon SQL over PGlite. Fictional data throughout.
 */

const PIER_4 = 'The harbor office is at Pier 4.';
const PIER_9 = 'The harbor office is now at Pier 9.';
const BOAT = 'Pat Example keeps the skiff at the boatyard.';
/** A client_name with a bidi override, a NUL, a line separator and too many characters. */
const RAW_APP = `\u202EHarbor\u0000 Desk\u2028 ${'y'.repeat(100)}`;
const TAMED_APP = `Harbor Desk ${'y'.repeat(68)}`;

type Call = { text: string; isError: boolean; structured: Record<string, unknown> | undefined };
type PendingBody = {
  entries: Array<{ server_id: string; scope: string; content: string; app?: string }>;
  forgets: unknown[];
  replaces?: Array<{ replace_id: string; scope: string; old_id: string; new_id: string }>;
};

async function readRpc(resp: Response): Promise<any> {
  const text = await resp.text();
  if ((resp.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0085-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe('ADR 0085 D1: the connector copy of tameOneLine matches the device', () => {
  it('gives the same answer on every sample', () => {
    const samples = ['Plain name', '  spaced\tout\nname  ', '\u202Eevil\u202C name', 'a\u0000b\u0007c', 'line\u2028sep\u2029para', 'lone \uD800 half', '😀'.repeat(50), '\uFEFFbom'];
    for (const s of samples) for (const max of [5, 80]) expect(tameOneLine(s, max)).toBe(coreTame(s, max));
    expect(tameAppName(RAW_APP)).toBe(TAMED_APP);
    expect(tameAppName('\u200B\u202E ')).toBeUndefined();
    expect(tameAppName(42)).toBeUndefined();
  });
});

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0085 connector (${kind})`, () => {
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

    /** A vault sharing "harbor", "boats" and project "dock", pushed, with an AI app connected under RAW_APP. */
    async function world() {
      n++;
      const deviceSecret = generateDeviceSecret();
      const connToken = deriveConnectorToken(deviceSecret);
      const account = tokenHash(connToken);
      const vault = Vault.create({ path: path.join(tmpRoot, `${kind}-${n}.nkv`), passphrase: 'harbor pass', deviceSecret, kdf: KDF_INTERACTIVE });
      const old = vault.remember({ content: PIER_4, type: 'semantic', scope: 'harbor' });
      const boat = vault.remember({ content: BOAT, type: 'semantic', scope: 'boats' });
      plantWorkingRow(vault, {
        content: serializeProjectDoc(mergeProjectDoc(emptyProjectDoc(), { whatWhy: 'Dock work.', status: 'Open.', logEntry: 'seeded' })),
        type: 'working',
        scope: 'project:dock',
      });
      for (const s of ['harbor', 'boats', 'project:dock']) vault.setScopeShared(s, true);
      vault.save();
      const docId = getProjectView(vault, 'dock').revision;

      const pairingCode = await startPairing({ server: base, deviceSecret });
      const reg = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: RAW_APP, redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
        }),
      }).then((r) => r.json()) as { client_id: string; client_name?: string };
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
      const pending = async (query: string): Promise<PendingBody> =>
        (await fetch(`${base}/client/pending${query}`, { headers: { authorization: `Bearer ${connToken}` } })).json() as Promise<PendingBody>;
      const push = () => pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
      const queue = async () => (await storage.listPendingReplaces(account)).map(({ createdAt: _c, ...r }) => r);
      const cloudRows = async () => (await storage.listPendingEntries(account)).map((e) => e.entryId);
      const local = (id: string) => vault.list({ includeSuperseded: true, includeForgotten: true }).find((e) => e.id === id);
      const localId = (content: string) => vault.list({ scope: 'harbor' }).find((e) => e.content === content)?.id;
      await push();
      return { deviceSecret, account, vault, old, boat, docId, reg, mcp, pending, push, queue, cloudRows, local, localId };
    }
    type World = Awaited<ReturnType<typeof world>>;

    async function replaceWith(w: World): Promise<{ newId: string; replaceId: string }> {
      const saved = await w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope: 'harbor', replaces: w.old.id });
      const newId = (saved.structured!.stored as { id: string }).id;
      const [entry] = await w.queue();
      return { newId, replaceId: entry!.replaceId };
    }

    it('an identical save writes nothing and returns the existing id, even with different case and punctuation', async () => {
      const w = await world();
      const res = await w.mcp('memory_remember', { content: 'the HARBOR office is at pier 4', type: 'semantic', scope: 'harbor' });
      expect(res.text).toBe(`Already saved: this repeats memory ${w.old.id} word for word, so nothing new was stored. (id: ${w.old.id})`);
      expect(res.structured).toEqual({ stored: { id: w.old.id, scope: 'harbor' }, already_saved: true, message: res.text });
      expect(await w.cloudRows()).toEqual([]);
    });

    it('two identical saves before a sync make one row', async () => {
      const w = await world();
      const first = await w.mcp('memory_remember', { content: 'The ferry leaves Pier 4 at 8:05.', type: 'semantic', scope: 'harbor' });
      const id = (first.structured!.stored as { id: string }).id;
      const second = await w.mcp('memory_remember', { content: 'The ferry leaves Pier 4 at 8:05.', type: 'semantic', scope: 'harbor' });
      expect(second.structured).toMatchObject({ stored: { id, scope: 'harbor' }, already_saved: true });
      expect(await w.cloudRows()).toEqual([id]);
    });

    it('a save that mostly repeats a memory is held: nothing written, the memory listed with its id', async () => {
      const w = await world();
      const res = await w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope: 'harbor' });
      expect(res.text).toBe(`${SAVE_HOLD_ADVICE}\nMemories it may update:\n- [harbor] ${PIER_4} (id ${w.old.id})`);
      expect(res.structured).toEqual({
        held: true,
        saved: false,
        next: SAVE_HOLD_ADVICE,
        possible_updates: [{ id: w.old.id, scope: 'harbor', type: 'semantic', content: PIER_4 }],
        message: res.text,
      });
      expect(await w.cloudRows()).toEqual([]);
    });

    it('a held memory in another scope does not hold the save', async () => {
      const w = await world();
      const res = await w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope: 'boats' });
      expect(res.text.startsWith('Saved to shared scope "boats".')).toBe(true);
    });

    it('distinct: true saves it as a separate memory', async () => {
      const w = await world();
      const res = await w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope: 'harbor', distinct: true });
      const id = (res.structured!.stored as { id: string }).id;
      expect(res.text).toBe(`Saved to shared scope "harbor". It will sync into the vault. (id: ${id})`);
      expect(await w.cloudRows()).toEqual([id]);
      expect(await w.queue()).toEqual([]);
    });

    it('replaces saves the new memory, queues the replace, and both stay visible with their ids', async () => {
      const w = await world();
      const res = await w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope: 'harbor', replaces: w.old.id });
      const newId = (res.structured!.stored as { id: string }).id;
      expect(res.text).toBe(
        `Saved to shared scope "harbor". It will sync into the vault. (id: ${newId}) It replaces memory ${w.old.id} once the user confirms it in NorthKeep; until then both memories are visible here.`,
      );
      expect(res.structured).toEqual({ stored: { id: newId, scope: 'harbor' }, replaces: w.old.id, replace_waits_for_user: true, message: res.text });
      const [entry] = await w.queue();
      expect(await w.queue()).toEqual([{ replaceId: entry!.replaceId, scope: 'harbor', oldId: w.old.id, newId }]);
      expect(entry!.replaceId).toMatch(/^rep_[0-9a-f]{32}$/);
      const list = (await w.mcp('memory_list', { scope: 'harbor' })).text;
      expect(list).toContain(`${PIER_4} (id ${w.old.id})`);
      expect(list).toContain(`${PIER_9} (id ${newId})`);
      const found = (await w.mcp('memory_retrieve', { query: 'harbor office' })).text;
      expect(found).toContain(`- [harbor] ${PIER_4} (id ${w.old.id})`);
      expect(found).toContain(`- [harbor] ${PIER_9} (id ${newId})`);
    });

    it('only ?v=3 carries the queue; ?v=2 and the legacy read have no replaces key', async () => {
      const w = await world();
      const { newId, replaceId } = await replaceWith(w);
      expect((await w.pending('?v=3')).replaces).toEqual([{ replace_id: replaceId, scope: 'harbor', old_id: w.old.id, new_id: newId }]);
      expect('replaces' in (await w.pending('?v=2'))).toBe(false);
      expect('replaces' in (await w.pending(''))).toBe(false);
    });

    it('a replace with the same text answers already saved; a second replace of the same memory is refused', async () => {
      const w = await world();
      const same = await w.mcp('memory_remember', { content: 'the harbor office is AT pier 4', type: 'semantic', scope: 'harbor', replaces: w.old.id });
      expect(same.structured).toMatchObject({ stored: { id: w.old.id, scope: 'harbor' }, already_saved: true });
      expect(await w.cloudRows()).toEqual([]);
      const { newId } = await replaceWith(w);
      const again = await w.mcp('memory_remember', { content: 'The harbor office is now at Pier 11.', type: 'semantic', scope: 'harbor', replaces: w.old.id });
      expect(again.text).toBe(`Nothing was saved: a replacement for memory ${w.old.id} is already waiting for the user to confirm it in NorthKeep.`);
      expect(await w.cloudRows()).toEqual([newId]);
    });

    it('refuses a project document, another scope, an unknown id and a memory waiting to be forgotten, writing nothing', async () => {
      const w = await world();
      const save = (replaces: string, scope = 'harbor') => w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope, replaces });
      expect((await save(w.docId, 'project:dock')).text).toBe(
        'Nothing was saved: that id is a project document or its log, which changes only through project_get and project_update.',
      );
      expect((await save(w.boat.id)).text).toBe(
        `Nothing was saved: memory ${w.boat.id} is in scope "boats", not "harbor". A replacement is saved in the scope of the memory it replaces.`,
      );
      expect((await save('mem_not_here')).text).toBe(
        'Nothing was saved: no shared memory this app can read has the id "mem_not_here". Use an id from memory_retrieve or memory_list.',
      );
      expect((await w.mcp('memory_forget', { id: w.old.id })).isError).toBe(false);
      expect((await save(w.old.id)).text).toBe(
        `Nothing was saved: no shared memory this app can read has the id "${w.old.id}". Use an id from memory_retrieve or memory_list.`,
      );
      expect(await w.cloudRows()).toEqual([]);
      expect(await w.queue()).toEqual([]);
    });

    it('D1: the app name is tamed at registration, kept inside the ciphertext, and reaches the device', async () => {
      const w = await world();
      expect(w.reg.client_name).toBe(TAMED_APP);
      expect((await storage.getClient(w.reg.client_id))?.client_name).toBe(TAMED_APP);
      const res = await w.mcp('memory_remember', { content: 'The ferry leaves Pier 4 at 8:05.', type: 'semantic', scope: 'harbor' });
      const id = (res.structured!.stored as { id: string }).id;
      const stored = (await storage.listPendingEntries(w.account)).find((e) => e.entryId === id)!;
      expect(stored.content.startsWith('nkc1:')).toBe(true);
      expect(stored.content).not.toContain('Harbor Desk');
      expect((await w.pending('?v=3')).entries.find((e) => e.server_id === id)?.app).toBe(TAMED_APP);
      await applyDownSync({ server: base, deviceSecret: w.deviceSecret, vault: w.vault });
      const added = w.local(w.localId('The ferry leaves Pier 4 at 8:05.')!)!;
      expect((added.metadata?.connector as { app?: string }).app).toBe(TAMED_APP);
    });

    it('an unapproved sync adds the new memory and re-points the queue at its vault id; approving later marks the old one replaced and empties it', async () => {
      const w = await world();
      const { replaceId } = await replaceWith(w);
      const first = await applyDownSync({ server: base, deviceSecret: w.deviceSecret, vault: w.vault });
      expect({ added: first.added, replaced: first.cloud_replaced, waiting: first.needs_review.cloud_replaces.map((r) => r.replace_id) })
        .toEqual({ added: 1, replaced: 0, waiting: [replaceId] });
      const newLocal = w.localId(PIER_9)!;
      expect(await w.queue()).toEqual([{ replaceId, scope: 'harbor', oldId: w.old.id, newId: newLocal }]);
      expect(w.local(w.old.id)?.superseded_by ?? null).toBe(null);

      const second = await applyDownSync({ server: base, deviceSecret: w.deviceSecret, vault: w.vault, approve: { replace_ids: [replaceId] } });
      expect(second.cloud_replaced).toBe(1);
      expect(w.local(w.old.id)?.superseded_by).toBe(newLocal);
      expect(w.vault.list({ scope: 'harbor' }).map((e) => e.content)).toEqual([PIER_9]);
      expect(await w.queue()).toEqual([]);
    });

    it('the phone (additiveOnly) adds the new memory but never applies or acks the replace', async () => {
      const w = await world();
      const { replaceId } = await replaceWith(w);
      const res = await applyDownSync({ server: base, deviceSecret: w.deviceSecret, vault: w.vault, additiveOnly: true, approve: { replace_ids: [replaceId] } });
      expect(res.added).toBe(1);
      expect(res.cloud_replaced).toBe(0);
      expect(w.local(w.old.id)?.superseded_by ?? null).toBe(null);
      expect(await w.queue()).toEqual([{ replaceId, scope: 'harbor', oldId: w.old.id, newId: w.localId(PIER_9)! }]);
    });

    it('editing the old memory on a device drops the queued replace; the new memory still arrives as an addition', async () => {
      const w = await world();
      const { newId } = await replaceWith(w);
      w.vault.editMemory(w.old.id, { content: 'The harbor office is at Pier 4, upstairs.' }, { actor: 'owner' });
      w.vault.save();
      await w.push();
      const after = await w.pending('?v=3');
      expect(after.replaces).toEqual([]);
      expect(after.entries.map((e) => e.server_id)).toEqual([newId]);
      expect(await w.queue()).toEqual([]);
    });

    it('keeps a queued replace whose ids another device renamed in the middle of a read', async () => {
      const w = await world();
      const { newId, replaceId } = await replaceWith(w);
      const renamed = '11111111-2222-4333-8444-555555555555';
      const realList = storage.listEntries.bind(storage);
      // The other device's ack lands after this read took the queue and before it reads the rows.
      storage.listEntries = async (account: string) => {
        storage.listEntries = realList;
        await storage.ackEntry(account, newId, renamed);
        return realList(account);
      };
      try {
        expect((await w.pending('?v=3')).replaces).toEqual([]);
      } finally {
        storage.listEntries = realList;
      }
      expect(await w.queue()).toEqual([{ replaceId, scope: 'harbor', oldId: w.old.id, newId: renamed }]);
      expect((await w.pending('?v=3')).replaces).toEqual([{ replace_id: replaceId, scope: 'harbor', old_id: w.old.id, new_id: renamed }]);
    });

    it('unsharing the scope drops the queued replace', async () => {
      const w = await world();
      await replaceWith(w);
      await unshareScope({ server: base, deviceSecret: w.deviceSecret, scope: 'harbor' });
      expect(await w.queue()).toEqual([]);
    });
  });
}

describe('ADR 0085 replace queue storage rules (memory and pglite)', () => {
  for (const kind of ['memory', 'pglite'] as const) {
    it(`${kind}: enqueue is idempotent, an ack re-points both ids, drop counts, unshare clears the scope`, async () => {
      let s: ConnectorStorage;
      if (kind === 'memory') s = new InMemoryConnectorStorage();
      else {
        const neon = new NeonConnectorStorage('postgres://unused', pgliteAsNeon(new PGlite(), { numbersAsStrings: true }));
        await neon.ensureSchema();
        s = neon;
      }
      const acct = 'acct-0085';
      const strip = async () => (await s.listPendingReplaces(acct)).map(({ createdAt: _c, ...r }) => r);
      await s.upsertAccount(acct);
      await s.writeConnectorRows(acct, 'harbor', { expectedSeq: null, rows: [{ entryId: 'conn_new', content: 'nkc1:x', baseRevision: null }], replacedId: null });
      await s.enqueueReplace(acct, { replaceId: 'rep_1', scope: 'harbor', oldId: 'mem_old', newId: 'conn_new' });
      await s.enqueueReplace(acct, { replaceId: 'rep_1', scope: 'harbor', oldId: 'mem_other', newId: 'conn_other' });
      await s.enqueueReplace(acct, { replaceId: 'rep_2', scope: 'boats', oldId: 'mem_b', newId: 'conn_b' });
      expect(await strip()).toEqual([
        { replaceId: 'rep_1', scope: 'harbor', oldId: 'mem_old', newId: 'conn_new' },
        { replaceId: 'rep_2', scope: 'boats', oldId: 'mem_b', newId: 'conn_b' },
      ]);
      await s.ackEntry(acct, 'conn_new', 'mem_new');
      expect((await strip())[0]).toEqual({ replaceId: 'rep_1', scope: 'harbor', oldId: 'mem_old', newId: 'mem_new' });
      await s.ackEntry(acct, 'mem_old', 'mem_old2');
      expect((await strip())[0]).toEqual({ replaceId: 'rep_1', scope: 'harbor', oldId: 'mem_old2', newId: 'mem_new' });
      await s.unshareScope(acct, 'boats', { paid: true });
      expect((await strip()).map((r) => r.replaceId)).toEqual(['rep_1']);
      expect(await s.dropReplaces(acct, ['rep_1', 'rep_missing'])).toBe(1);
      expect(await strip()).toEqual([]);
      expect(await s.dropReplaces(acct, [])).toBe(0);
    });
  }
});
