import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Vault, KDF_INTERACTIVE, generateDeviceSecret } from '@northkeep/core';
import { deriveConnectorToken, downSyncConnector, pushSharedScopes, startPairing, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { decryptedEntries, seedEncryptedEntry } from './helpers.js';

// The random sequence runs many real vault crypto and sync round trips; under full-suite load it passes 5 s.
vi.setConfig({ testTimeout: 30_000 });

/**
 * C3 property test — random sequences over {remember, forget, unshare, re-share,
 * downSync, push} against a real temp vault + an in-memory connector server.
 * After every down-sync+push, all FIVE invariants must hold:
 *   (1) Vault.verifyChain() is true;
 *   (2) no duplicate vault entry per connector server_id (dedupe + pending filter);
 *   (3) no resurrection of a forgotten entry;
 *   (4) the server's rows for a shared scope EQUAL the vault's live entries there
 *       (compared through decryption — at rest they are ciphertext);
 *   (5) THE CANARY (ADR 0020, checked after EVERY operation): no plaintext that
 *       ever passed through the server — the seeded canary or ANY memory content —
 *       appears ANYWHERE in the storage state. This is the falsifiability test for
 *       "the connector database holds only ciphertext".
 * Deterministic: a seeded mulberry32 PRNG, never Math.random.
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';

/** Deterministic PRNG — no Math.random anywhere in this suite. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('C3 property: down-sync invariants under random operation sequences', () => {
  const storage = new InMemoryConnectorStorage();
  const deviceSecret = generateDeviceSecret();
  const connToken = deriveConnectorToken(deviceSecret);
  const account = tokenHash(connToken);
  const passphrase = 'correct horse battery staple';

  let server: Server;
  let base = '';
  let RESOURCE = '';
  let tmpDir = '';
  let vaultPath = '';
  let token = '';

  function withVault<T>(fn: (v: Vault) => T | Promise<T>): Promise<T> {
    const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
    return Promise.resolve(fn(vault)).finally(() => vault.close());
  }

  async function listen(port: number): Promise<void> {
    const app = createConnectorServer(storage);
    server = await new Promise<Server>((resolve) => {
      const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
    RESOURCE = `${base}/mcp`;
  }

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
  }

  async function connectAiApp(): Promise<string> {
    const pairingCode = await startPairing({ server: base, deviceSecret });
    const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
    const clientId = (await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'c3-prop', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
      }),
    }).then((r) => r.json())).client_id as string;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(8));
    await fetch(`${base}/authorize?` + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge,
      code_challenge_method: 'S256', scope: 'mcp', state, resource: RESOURCE,
    }));
    const consent = await fetch(`${base}/consent`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
      body: new URLSearchParams({
        client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, state, scope: 'mcp',
        resource: RESOURCE, pairing_code: pairingCode,
      }).toString(),
    });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const tok = (await fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId,
        code_verifier: verifier, resource: RESOURCE,
      }).toString(),
    }).then((r) => r.json())).access_token as string;
    return tok;
  }

  async function mcp(name: string, args: Record<string, unknown>): Promise<string> {
    const resp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    let call: any;
    if (ct.includes('text/event-stream')) {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      call = line ? JSON.parse(line.slice(5).trim()) : null;
    } else {
      call = JSON.parse(text);
    }
    return call?.result?.content?.[0]?.text || '';
  }

  // The canary: a distinctive plaintext that WILL flow through the server (it is
  // pushed, retrieved, re-pushed) — if it ever appears in raw storage, the
  // ciphertext-only claim is false and the suite fails.
  const CANARY = 'CANARY-7f3a19 the lighthouse keeper logs the 0400 tide by hand';
  /** Every plaintext that ever passed through the server (invariant 5 checks ALL). */
  const plaintexts = new Set<string>([CANARY, 'seed work anchor', 'seed proj anchor']);

  /** Invariant (5): walk ALL storage state — no canary, no memory plaintext, ever. */
  function checkCiphertextOnly(): void {
    const dump = storage.dumpState();
    expect(dump).not.toContain(CANARY);
    for (const p of plaintexts) {
      expect(dump.includes(p), `plaintext leaked into storage: "${p}"`).toBe(false);
    }
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-c3prop-'));
    vaultPath = path.join(tmpDir, 'vault.nkv');
    const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    // Seed both scopes so each is a currently-shared scope from the start.
    vault.remember({ content: 'seed work anchor', type: 'semantic', scope: 'work' });
    vault.remember({ content: 'seed proj anchor', type: 'semantic', scope: 'proj' });
    vault.remember({ content: CANARY, type: 'semantic', scope: 'work' });
    vault.save();
    vault.close();

    const port = await freePort();
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    await listen(port);
    await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work', 'proj'], vault: v }));
    token = await connectAiApp();
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('holds all five invariants across a random operation sequence', async () => {
    const rand = mulberry32(0xc3c3c3);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const forgottenContents = new Set<string>();
    const shared = new Set<string>(['work', 'proj']);
    let counter = 0;

    async function checkInvariants(): Promise<void> {
      await withVault((v) => {
        // (1) chain intact.
        expect(v.verifyChain().ok).toBe(true);

        const live = v.list();
        // (2) no duplicate server_id, and no duplicate (scope,content).
        const seenSid = new Set<string>();
        const seenSc = new Set<string>();
        for (const e of live) {
          const sid = (e.metadata as any)?.connector?.server_id as string | undefined;
          if (sid) {
            expect(seenSid.has(sid)).toBe(false);
            seenSid.add(sid);
          }
          const key = `${e.scope} ${e.content}`;
          expect(seenSc.has(key)).toBe(false);
          seenSc.add(key);
        }
        // (3) no resurrection.
        for (const e of live) expect(forgottenContents.has(e.content)).toBe(false);
      });

      // (4) after a full down-sync+push, nothing is left pending/queued, and each
      // shared scope's server rows equal the vault's live entries there.
      expect(await storage.listPendingEntries(account)).toHaveLength(0);
      expect(await storage.listPendingForgets(account)).toHaveLength(0);
      // Compared through decryption — at rest the rows are ciphertext (see 5).
      const rows = await decryptedEntries(storage, account, connToken);
      await withVault((v) => {
        for (const scope of shared) {
          const vaultLive = v.list({ scope }).map((e) => `${e.id} ${e.content}`).sort();
          const serverRows = rows.filter((r) => r.scope === scope).map((r) => `${r.entryId} ${r.content}`).sort();
          expect(serverRows).toEqual(vaultLive);
        }
      });

      // (5) ciphertext-only, re-checked at every settle point.
      checkCiphertextOnly();
    }

    async function downSyncAndPush(): Promise<void> {
      await withVault(async (v) => {
        await downSyncConnector({ server: base, deviceSecret, vault: v });
        await pushSharedScopes({ server: base, deviceSecret, scopes: [...shared], vault: v });
      });
      await checkInvariants();
    }

    const OPS = 40;
    for (let i = 0; i < OPS; i++) {
      const op = pick(['remember', 'remember', 'forget', 'unshare', 'reshare', 'sync']);
      if (op === 'remember') {
        // Only into a currently-shared scope that has ≥1 server row.
        const rows = await storage.listEntries(account);
        const candidates = [...shared].filter((s) => rows.some((r) => r.scope === s));
        if (candidates.length === 0) continue;
        const scope = pick(candidates);
        const content = `mem#${counter++} in ${scope}`;
        plaintexts.add(content); // invariant 5 must never see it in raw storage
        await mcp('memory_remember', { content, type: 'semantic', scope });
      } else if (op === 'forget') {
        const rows = await decryptedEntries(storage, account, connToken);
        if (rows.length === 0) continue;
        const target = pick(rows);
        await mcp('memory_forget', { id: target.entryId });
        // Whether canceled (pending) or queued (delivered), this content must
        // never be a live vault entry after the next down-sync.
        forgottenContents.add(target.content);
      } else if (op === 'unshare') {
        if (!shared.has('proj')) continue;
        await withVault((v) => v); // no-op open to keep timing uniform
        await fetch(`${base}/client/scope/proj`, { method: 'DELETE', headers: { authorization: `Bearer ${connToken}` } });
        shared.delete('proj');
      } else if (op === 'reshare') {
        if (shared.has('proj')) continue;
        shared.add('proj');
        await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: [...shared], vault: v }));
      } else {
        await downSyncAndPush();
      }
      // Invariant (5) after EVERY operation, not only at settle points: no
      // plaintext ever rests in storage, mid-sequence included.
      checkCiphertextOnly();
    }
    // Final reconcile so the closing invariant check sees a settled state.
    if (!shared.has('proj')) {
      shared.add('proj');
      await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: [...shared], vault: v }));
    }
    await downSyncAndPush();

    // Explicit dedupe coverage: inject a fresh pending connector row whose
    // (scope, content) already matches a live vault entry, then down-sync. It
    // must dedupe onto the existing id — no second vault entry, invariants hold.
    const anchorId = await withVault((v) => v.list({ scope: 'work' })[0]!.id);
    const anchorContent = await withVault((v) => v.list({ scope: 'work' })[0]!.content);
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'conn_dupe_test', scope: 'work', type: 'semantic', content: anchorContent,
      entryHash: '', origin: 'connector', pending: true, createdAt: new Date().toISOString(),
    });
    const dup = await withVault((v) => downSyncConnector({ server: base, deviceSecret, vault: v }));
    expect(dup.deduped).toBe(1);
    expect(dup.added).toBe(0);
    // The server row was acked/remapped onto the existing vault id, not duplicated.
    await withVault((v) => {
      const matches = v.list({ scope: 'work' }).filter((e) => e.content === anchorContent);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.id).toBe(anchorId);
      expect(v.verifyChain().ok).toBe(true);
    });
    await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: [...shared], vault: v }));
    await checkInvariants();
  });
});
