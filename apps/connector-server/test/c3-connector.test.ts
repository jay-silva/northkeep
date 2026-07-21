import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Vault, KDF_INTERACTIVE, generateDeviceSecret } from '@northkeep/core';
import {
  deriveConnectorToken,
  downSyncConnector,
  pushSharedScopes,
  startPairing,
  tokenHash,
} from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { decryptContent } from '../src/content-crypto.js';

/** Fixed 32-byte content secret injected into the server; the store holds ciphertext at rest. */
const TEST_CONTENT_SECRET = Buffer.alloc(32, 0x2b);
/** Decrypt a stored blob under an account's key (storage rows are ciphertext, not plaintext). */
const dec = (acct: string, blob: string): string | null => decryptContent(acct, blob, TEST_CONTENT_SECRET);

/**
 * C3 acceptance — write-back down-sync + the billing gate (ADR 0019).
 *
 * Proves: a memory created INSIDE an AI flow (memory_remember over /mcp) surfaces
 * on /client/pending, flows into the vault on downSyncConnector (verifyChain
 * intact), and after a re-push the server row carries the vault-local id with
 * pending cleared; memory_forget then removes it from BOTH vault and server. A
 * push that RACES ahead of a down-sync does NOT clobber the pending connector
 * row. And the billing gate: non-entitled ⇒ 402, allowlisted ⇒ free, a valid
 * HMAC entitlement ⇒ allowed, forged/expired ⇒ 402.
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';

// ---- shared test infra -------------------------------------------------

async function listen(app: ReturnType<typeof createConnectorServer>, port: number): Promise<[Server, string]> {
  const s = await new Promise<Server>((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
  });
  const addr = s.address() as AddressInfo;
  return [s, `http://127.0.0.1:${addr.port}`];
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

// ---- write-back down-sync ----------------------------------------------

describe('C3 write-back down-sync', () => {
  const storage = new InMemoryConnectorStorage();
  const deviceSecret = generateDeviceSecret();
  const connToken = deriveConnectorToken(deviceSecret);
  const account = tokenHash(connToken);
  const passphrase = 'correct horse battery staple';
  const WORK_SEED = 'Ambulance 2 is out of service pending a brake inspection.';
  const FERRY = 'I take the 8:05 ferry to the mainland on QA days.';

  let server: Server;
  let base = '';
  let RESOURCE = '';
  let tmpDir = '';
  let vaultPath = '';

  function withVault<T>(fn: (v: Vault) => T | Promise<T>): Promise<T> {
    const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
    return Promise.resolve(fn(vault)).finally(() => vault.close());
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-c3-'));
    vaultPath = path.join(tmpDir, 'vault.nkv');
    const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
    vault.remember({ content: WORK_SEED, type: 'semantic', scope: 'work' });
    vault.save();
    vault.close();

    const port = await freePort();
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    base = process.env.PUBLIC_URL;
    RESOURCE = `${base}/mcp`;
    [server] = await listen(createConnectorServer(storage, { contentSecret: TEST_CONTENT_SECRET }), port);

    // Seed the server so 'work' is a currently-shared scope (memory_remember
    // fails closed against a scope with no existing rows).
    await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault: v }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- OAuth + MCP helpers (the client is the AI app) ----
  async function readRpc(resp: Response): Promise<any> {
    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    if (ct.includes('text/event-stream')) {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      return line ? JSON.parse(line.slice(5).trim()) : null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function register(): Promise<string> {
    const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
    const reg = await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'c3-e2e-client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp',
      }),
    }).then((r) => r.json());
    return reg.client_id as string;
  }

  function pkce(): { verifier: string; challenge: string } {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
  }

  async function consentToCode(clientId: string, challenge: string, pairingCode: string): Promise<string | null> {
    const state = b64url(crypto.randomBytes(8));
    const authUrl = new URL(`${base}/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      state,
      resource: RESOURCE,
    }).toString();
    await fetch(authUrl);
    const consent = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        state,
        scope: 'mcp',
        resource: RESOURCE,
        pairing_code: pairingCode,
      }).toString(),
    });
    const location = consent.headers.get('location');
    return location ? new URL(location).searchParams.get('code') : null;
  }

  async function tokenExchange(clientId: string, code: string, verifier: string): Promise<string> {
    const resp = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    });
    const json = (await resp.json()) as { access_token?: string };
    return json.access_token ?? '';
  }

  async function connectAiApp(): Promise<string> {
    const pairingCode = await startPairing({ server: base, deviceSecret });
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await consentToCode(clientId, challenge, pairingCode);
    const token = await tokenExchange(clientId, code as string, verifier);
    expect(token).toBeTruthy();
    return token;
  }

  async function mcpCall(token: string, name: string, args: Record<string, unknown>): Promise<string> {
    const resp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const call = await readRpc(resp);
    return call?.result?.content?.[0]?.text || '';
  }

  it('remember over /mcp → pending → down-sync into vault → re-push clears pending; forget → gone both sides', async () => {
    const token = await connectAiApp();

    // 1. The AI remembers a new work memory.
    const rememberText = await mcpCall(token, 'memory_remember', { content: FERRY, type: 'semantic', scope: 'work' });
    expect(rememberText).toContain('Saved to shared scope "work"');
    const serverId = /id: (conn_[0-9a-f]+)/.exec(rememberText)?.[1];
    expect(serverId).toBeTruthy();

    // 2. It shows up as pending, connector-origin, undelivered.
    const pending = await storage.listPendingEntries(account);
    expect(pending).toHaveLength(1);
    // Stored at rest as ciphertext; decrypts transiently to the plaintext.
    expect(pending[0]!.content.startsWith('nkc1:')).toBe(true);
    expect(dec(account, pending[0]!.content)).toBe(FERRY);
    expect(pending[0]!.origin).toBe('connector');

    // 3. Down-sync: it lands in the vault as a normal append; chain stays valid.
    const down = await withVault((v) => downSyncConnector({ server: base, deviceSecret, vault: v }));
    expect(down.added).toBe(1);
    let localId = '';
    await withVault((v) => {
      const live = v.list({ scope: 'work' }).find((e) => e.content === FERRY);
      expect(live).toBeTruthy();
      expect(live!.source.startsWith('connector:')).toBe(true);
      expect((live!.metadata as any)?.connector?.server_id).toBe(serverId);
      expect(v.verifyChain().ok).toBe(true);
      localId = live!.id;
    });

    // After the down-sync ack, the server row is remapped to the vault id and no
    // longer pending; a re-push then rehashes it with the real vault entry_hash.
    expect(await storage.listPendingEntries(account)).toHaveLength(0);
    let row = (await storage.listEntries(account)).find((e) => dec(account, e.content) === FERRY);
    expect(row!.entryId).toBe(localId);
    expect(row!.pending).toBe(false);

    await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault: v }));
    row = (await storage.listEntries(account)).find((e) => dec(account, e.content) === FERRY);
    expect(/^[0-9a-f]{64}$/.test(row!.entryHash ?? '')).toBe(true);

    // 4. The AI forgets it. It is hidden immediately, then tombstoned in the
    // vault and deleted from the server on the next down-sync.
    const forgetText = await mcpCall(token, 'memory_forget', { id: localId });
    expect(forgetText).toContain('Forgotten');
    const listAfterForget = await mcpCall(token, 'memory_list', {});
    expect(listAfterForget).not.toContain(FERRY);

    const down2 = await withVault((v) => downSyncConnector({ server: base, deviceSecret, vault: v }));
    expect(down2.forgotten).toBe(1);
    await withVault((v) => {
      expect(v.list({ scope: 'work' }).some((e) => e.content === FERRY)).toBe(false);
      expect(v.verifyChain().ok).toBe(true);
    });
    expect((await storage.listEntries(account)).some((e) => dec(account, e.content) === FERRY)).toBe(false);
    expect(await storage.listPendingForgets(account)).toHaveLength(0);
  });

  it('a push that races ahead of the down-sync does not clobber the pending remember', async () => {
    const token = await connectAiApp();
    const RACE = 'Station 3 generator load test is Friday 1400.';
    const rememberText = await mcpCall(token, 'memory_remember', { content: RACE, type: 'semantic', scope: 'work' });
    const serverId = /id: (conn_[0-9a-f]+)/.exec(rememberText)?.[1];
    expect(serverId).toBeTruthy();

    // Push BEFORE down-sync (the desktop pushes vault-live entries; RACE isn't in
    // the vault yet). The reconcile-delete must spare the pending connector row.
    await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault: v }));
    const stillPending = await storage.listPendingEntries(account);
    expect(stillPending.some((e) => e.entryId === serverId && dec(account, e.content) === RACE)).toBe(true);

    // Now the down-sync succeeds and the memory reaches the vault.
    const down = await withVault((v) => downSyncConnector({ server: base, deviceSecret, vault: v }));
    expect(down.added).toBe(1);
    await withVault((v) => {
      expect(v.list({ scope: 'work' }).some((e) => e.content === RACE)).toBe(true);
      expect(v.verifyChain().ok).toBe(true);
    });
  });

  it('forget-race: GET /pending → memory_forget → POST /ack leaves state FORGOTTEN, not orphaned', async () => {
    const token = await connectAiApp();
    const RACED = 'The QA/QI packet is due to the state by the 15th.';

    // The AI remembers a memory.
    const rememberText = await mcpCall(token, 'memory_remember', { content: RACED, type: 'semantic', scope: 'work' });
    const serverId = /id: (conn_[0-9a-f]+)/.exec(rememberText)?.[1];
    expect(serverId).toBeTruthy();

    // 1. The client GETs /client/pending and SEES the entry (it is "delivered").
    const pending = await fetch(`${base}/client/pending`, {
      headers: { authorization: `Bearer ${connToken}` },
    }).then((r) => r.json());
    expect(pending.entries.some((e: any) => e.server_id === serverId)).toBe(true);

    // 2. The client applies it to the vault (a normal append) — but has NOT acked.
    let localId = '';
    await withVault((v) => {
      const e = v.remember({
        content: RACED,
        type: 'semantic',
        scope: 'work',
        source: 'connector:test',
        metadata: { connector: { server_id: serverId } },
      });
      localId = e.id;
      v.save();
    });

    // 3. THE RACE: a forget arrives over /mcp before the client acks.
    await mcpCall(token, 'memory_forget', { id: serverId! });
    expect(await storage.listPendingForgets(account)).toContain(serverId);

    // 4. The client now acks the (already-delivered) entry. The ack must re-point
    //    the queued forget from the server id onto the vault-local id.
    await fetch(`${base}/client/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ acked: [{ server_id: serverId, local_entry_id: localId }], forgets: [] }),
    });
    const forgetsAfterAck = await storage.listPendingForgets(account);
    expect(forgetsAfterAck).toContain(localId);
    expect(forgetsAfterAck).not.toContain(serverId);

    // 5. A down-sync now propagates the forget: the vault entry is tombstoned and
    //    the server row deleted — the memory is FORGOTTEN, not orphaned.
    await withVault((v) => downSyncConnector({ server: base, deviceSecret, vault: v }));
    await withVault((v) => {
      expect(v.list({ scope: 'work' }).some((e) => e.content === RACED)).toBe(false); // not live
      const tomb = v.list({ scope: 'work', includeForgotten: true }).find((e) => e.id === localId);
      expect(tomb?.forgotten_at).toBeTruthy(); // tombstoned, chain preserved
      expect(v.verifyChain().ok).toBe(true);
    });
    expect((await storage.listEntries(account)).some((e) => dec(account, e.content) === RACED)).toBe(false);
    expect(await storage.listPendingForgets(account)).toHaveLength(0);

    // 6. A re-push must NOT resurrect it server-side.
    await withVault((v) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault: v }));
    expect((await storage.listEntries(account)).some((e) => dec(account, e.content) === RACED)).toBe(false);
  });
});

// ---- billing gate ------------------------------------------------------

/** Sign an entitlement token exactly as apps/sync-server/src/entitlement.ts does. */
function signTestEntitlement(secret: string, opts: { active: boolean; expSec: number }): string {
  const claims = { active: opts.active, period_end: opts.active ? 9_999_999_999 : 0, exp: opts.expSec, nonce: 'testnonce' };
  const body = JSON.stringify(claims);
  const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sig}`;
}

describe('C3 billing gate', () => {
  const SECRET = 'connector-entitlement-secret-xyz';
  const nowSec = () => Math.floor(Date.now() / 1000);

  const storage = new InMemoryConnectorStorage();
  const paidSecret = generateDeviceSecret();
  const paidToken = deriveConnectorToken(paidSecret);
  const compSecret = generateDeviceSecret();
  const compToken = deriveConnectorToken(compSecret);
  const compAccount = tokenHash(compToken);

  const priorAllow = process.env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES;
  const priorSecret = process.env.CONNECTOR_ENTITLEMENT_SECRET;
  const priorPublic = process.env.PUBLIC_URL;

  let server: Server;
  let base = '';

  beforeAll(async () => {
    process.env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES = compAccount;
    process.env.CONNECTOR_ENTITLEMENT_SECRET = SECRET;
    const port = await freePort();
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    [server, base] = await listen(createConnectorServer(storage, { contentSecret: TEST_CONTENT_SECRET }), port);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (priorAllow === undefined) delete process.env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES;
    else process.env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES = priorAllow;
    if (priorSecret === undefined) delete process.env.CONNECTOR_ENTITLEMENT_SECRET;
    else process.env.CONNECTOR_ENTITLEMENT_SECRET = priorSecret;
    if (priorPublic === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = priorPublic;
  });

  const manifest = (token: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/client/manifest`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const pairStart = (token: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: '{}',
    });

  it('non-allowlisted, no entitlement → 402 on /client/* and /pair/start', async () => {
    expect((await manifest(paidToken)).status).toBe(402);
    expect((await pairStart(paidToken)).status).toBe(402);
  });

  it('allowlisted account → allowed free (200), no entitlement needed', async () => {
    expect((await manifest(compToken)).status).toBe(200);
    expect((await pairStart(compToken)).status).toBe(200);
  });

  it('forged or expired entitlement → 402', async () => {
    const forged = signTestEntitlement('WRONG-SECRET', { active: true, expSec: nowSec() + 3600 });
    expect((await manifest(paidToken, { 'x-nb-entitlement': forged })).status).toBe(402);
    const expired = signTestEntitlement(SECRET, { active: true, expSec: nowSec() - 10 });
    expect((await manifest(paidToken, { 'x-nb-entitlement': expired })).status).toBe(402);
  });

  it('valid HMAC entitlement → allowed, and the stamped grace lets /mcp through', async () => {
    const valid = signTestEntitlement(SECRET, { active: true, expSec: nowSec() + 3600 });
    // The header stamps a grace window on this pair/push.
    expect((await pairStart(paidToken, { 'x-nb-entitlement': valid })).status).toBe(200);
    // A subsequent request with NO header still passes on the stored grace.
    expect((await manifest(paidToken)).status).toBe(200);
  });
});
