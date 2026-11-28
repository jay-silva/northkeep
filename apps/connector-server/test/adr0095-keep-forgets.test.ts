import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret } from '@northkeep/core';
import { deriveConnectorToken, pushSharedScopes, startPairing, tokenHash, unshareScope } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage, type ConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';
import { pgliteAsNeon, startServer, TEST_PEPPER_B64, withEnv, REDIRECT_URI } from './adr0061-support.js';

/**
 * ADR 0095 D4 on the connector: `keep_forgets` drops a forget request and
 * keeps the memory. Over HTTP with a real vault, on the in-memory store and
 * on the Neon SQL over PGlite. Fictional data throughout.
 */

const SLIP = "Pat Example's slip is at Pier 4.";
const PIER_4 = 'The harbor office is at Pier 4.';
const PIER_9 = 'The harbor office is now at Pier 9.';

async function readRpc(resp: Response): Promise<any> {
  const text = await resp.text();
  if ((resp.headers.get('content-type') || '').includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-0095-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

for (const kind of ['memory', 'pglite'] as const) {
  describe(`ADR 0095 keep_forgets (${kind})`, () => {
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

    /** A vault sharing "harbor", pushed, with one AI app connected. */
    async function world() {
      n++;
      const deviceSecret = generateDeviceSecret();
      const connToken = deriveConnectorToken(deviceSecret);
      const account = tokenHash(connToken);
      const vault = Vault.create({ path: path.join(tmpRoot, `${kind}-${n}.nkv`), passphrase: 'harbor pass', deviceSecret, kdf: KDF_INTERACTIVE });
      const slip = vault.remember({ content: SLIP, type: 'semantic', scope: 'harbor' });
      const office = vault.remember({ content: PIER_4, type: 'semantic', scope: 'harbor' });
      vault.setScopeShared('harbor', true);
      vault.save();

      const pairingCode = await startPairing({ server: base, deviceSecret });
      const reg = (await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Pier Helper', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
        }),
      }).then((r) => r.json())) as { client_id: string };
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

      const mcp = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structured: Record<string, unknown> | undefined }> => {
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
      const ack = async (body: Record<string, unknown>) => {
        const res = await fetch(`${base}/client/ack`, {
          method: 'POST',
          headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const pending = async (query: string) =>
        (await fetch(`${base}/client/pending${query}`, { headers: { authorization: `Bearer ${connToken}` } })).json() as Promise<{ forgets: string[]; replaces?: unknown[] }>;
      const push = () => pushSharedScopes({ server: base, deviceSecret, scopes: vault.sharedScopes(), vault });
      const cloudSees = async (text: string) => (await mcp('memory_list', {})).text.includes(text);
      await push();
      return { deviceSecret, account, vault, slip, office, mcp, ack, pending, push, cloudSees };
    }

    it('keep_forgets drops the request and keeps the memory, and cloud apps see it again', async () => {
      const w = await world();
      expect((await w.mcp('memory_forget', { id: w.slip.id })).isError).toBe(false);
      expect(await storage.listPendingForgets(w.account)).toEqual([w.slip.id]);
      expect(await w.cloudSees(SLIP)).toBe(false);

      const res = await w.ack({ acked: [], forgets: [], keep_forgets: [w.slip.id] });

      expect([res.status, res.body]).toEqual([200, { ok: true, acked: 0, forgotten: 0, replaces: 0, kept: 1, answers: 0 }]);
      expect(await storage.listPendingForgets(w.account)).toEqual([]);
      expect((await storage.getEntry(w.account, w.slip.id))?.entryId).toBe(w.slip.id);
      expect(await w.cloudSees(SLIP)).toBe(true);
      expect((await w.pending('?v=3')).forgets).toEqual([]);
    });

    it('an id that is not queued keeps nothing and deletes nothing, and a repeat is harmless', async () => {
      const w = await world();
      const res = await w.ack({ keep_forgets: ['not-queued', w.office.id] });
      expect([res.status, res.body.kept]).toEqual([200, 0]);
      expect((await storage.getEntry(w.account, w.office.id))?.entryId).toBe(w.office.id);

      await w.mcp('memory_forget', { id: w.slip.id });
      expect((await w.ack({ keep_forgets: [w.slip.id, w.slip.id] })).body.kept).toBe(1);
      expect((await w.ack({ keep_forgets: [w.slip.id] })).body.kept).toBe(0);
      expect(await w.cloudSees(SLIP)).toBe(true);
    });

    it('refuses one id in both forgets and keep_forgets, and changes nothing', async () => {
      const w = await world();
      await w.mcp('memory_forget', { id: w.slip.id });
      const res = await w.ack({ forgets: [w.slip.id], keep_forgets: [w.slip.id] });
      expect([res.status, res.body]).toEqual([400, { error: 'The same id is in forgets and keep_forgets.' }]);
      expect(await storage.listPendingForgets(w.account)).toEqual([w.slip.id]);
      expect((await storage.getEntry(w.account, w.slip.id))?.entryId).toBe(w.slip.id);
    });

    it('an ordinary forget acknowledgement still deletes the memory, and now reports kept: 0', async () => {
      const w = await world();
      await w.mcp('memory_forget', { id: w.slip.id });
      const res = await w.ack({ acked: [], forgets: [w.slip.id] });
      expect(res.body).toEqual({ ok: true, acked: 0, forgotten: 1, replaces: 0, kept: 0, answers: 0 });
      expect(await storage.getEntry(w.account, w.slip.id)).toBeNull();
      expect(await storage.listPendingForgets(w.account)).toEqual([]);
    });

    it('a forget asked for while a collection was shared stays queued after the unshare (unchanged, pinned)', async () => {
      const w = await world();
      await w.mcp('memory_forget', { id: w.slip.id });
      await unshareScope({ server: base, deviceSecret: w.deviceSecret, scope: 'harbor' });
      expect(await storage.listPendingForgets(w.account)).toEqual([w.slip.id]);
    });

    it('a queued replace whose old memory a push leaves out is dropped at the next v3 read with no acknowledgement (unchanged, pinned)', async () => {
      const w = await world();
      const saved = await w.mcp('memory_remember', { content: PIER_9, type: 'semantic', scope: 'harbor', replaces: w.office.id });
      expect(saved.isError, saved.text).toBe(false);
      expect(await storage.listPendingReplaces(w.account)).toHaveLength(1);

      w.vault.forget(w.office.id, { actor: 'owner' });
      w.vault.save();
      await w.push();

      expect((await w.pending('?v=3')).replaces).toEqual([]);
      expect(await storage.listPendingReplaces(w.account)).toEqual([]);
    });
  });
}
