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
  getManifest,
  pushSharedScopes,
  startPairing,
  tokenHash,
  unshareScope,
} from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';

/**
 * C2 acceptance — desktop marks scopes Shared and pushes REAL vault entries to
 * the connector, served over OAuth+/mcp. Uses a cheap-KDF temp vault (runs under
 * the root vitest config's short timeout) + the @northkeep/sync client module
 * against a locally-started InMemoryStorage connector-server.
 *
 * Proves: the WORK scope reaches an AI app while a PERSONAL memory NEVER does;
 * the "make these scopes match" push (add → appears, forget → disappears
 * server-side); unshare leaves zero rows + a tombstone; the per-account caps
 * reject an over-cap push.
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';

const storage = new InMemoryConnectorStorage();
let server: Server;
let base = '';
let RESOURCE = '';

// A real device secret → the connector token the desktop pushes/pairs with, and
// the account hash the server keys on (== sha256 of that token).
const deviceSecret = generateDeviceSecret();
const connToken = deriveConnectorToken(deviceSecret);
const account = tokenHash(connToken);

// A second device (different account) that must never see account 1's memories.
const otherSecret = generateDeviceSecret();

const WORK_1 = 'The Tuesday compliance QA/QI review starts at 0800 in the ops room.';
const WORK_2 = 'Ambulance 2 is out of service pending a brake inspection this week.';
const PERSONAL_SECRET = 'The user takes lisinopril 10mg for blood pressure.';

let tmpDir = '';
let vaultPath = '';
const passphrase = 'correct horse battery staple';

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

/** Open the temp vault, run fn, close. Injected into the client push as needed. */
function withVault<T>(fn: (v: Vault) => T): T {
  const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
  try {
    return fn(vault);
  } finally {
    vault.close();
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-c2-'));
  vaultPath = path.join(tmpDir, 'vault.nkv');
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  vault.remember({ content: WORK_1, type: 'semantic', scope: 'work' });
  vault.remember({ content: WORK_2, type: 'semantic', scope: 'work' });
  vault.remember({ content: PERSONAL_SECRET, type: 'semantic', scope: 'personal' });
  vault.save(); // create() only persists the empty schema; persist the memories.
  vault.close();

  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  RESOURCE = `${base}/mcp`;
  [server] = await listen(createConnectorServer(storage), port);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- OAuth + MCP helpers (mirrors connector-e2e; the client is the AI app) ----

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
      client_name: 'c2-e2e-client',
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
  await fetch(authUrl); // render consent form
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

async function mcpCall(token: string, body: unknown): Promise<any> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return readRpc(resp);
}

/** Full pairing → OAuth → access token, using a code from the client module. */
async function connectAiApp(): Promise<string> {
  const pairingCode = await startPairing({ server: base, deviceSecret });
  expect(pairingCode).toMatch(/^[A-Z2-9]{8}$/);
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const code = await consentToCode(clientId, challenge, pairingCode);
  expect(code).toBeTruthy();
  const token = await tokenExchange(clientId, code as string, verifier);
  expect(token).toBeTruthy();
  return token;
}

async function retrieveText(token: string, query: string): Promise<string> {
  const call = await mcpCall(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'memory_retrieve', arguments: { query } },
  });
  return call?.result?.content?.[0]?.text || '';
}

async function listText(token: string): Promise<string> {
  const call = await mcpCall(token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'memory_list', arguments: {} },
  });
  return call?.result?.content?.[0]?.text || '';
}

describe('C2 client push + share marking', () => {
  it('share add work (push) → an AI app retrieves the WORK memory; PERSONAL never leaks', async () => {
    // "share add work" auto-push: send the configured shared scope [work].
    const result = await withVault((vault) =>
      pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault }),
    );
    expect(result.pushed).toBe(2); // two live work memories

    // Server holds exactly the work rows, byte-faithful, with entry_hash set.
    const rows = await storage.listEntries(account);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === 'work')).toBe(true);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.entryHash ?? ''))).toBe(true);
    expect(rows.some((r) => r.content === WORK_1)).toBe(true);
    // The personal secret was NEVER pushed.
    expect(rows.some((r) => r.content.includes('lisinopril'))).toBe(false);

    // The AI app connects and retrieves the work memory.
    const token = await connectAiApp();
    const work = await retrieveText(token, 'compliance review time');
    expect(work).toContain(WORK_1);

    // A personal query returns nothing personal — the boundary holds end to end.
    // (Query terms are chosen NOT to contain the secret; memory_retrieve echoes
    // the query back, so a leak-word in the query would be a false positive.)
    const personal = await retrieveText(token, 'what prescription does the user take daily');
    expect(personal).not.toContain('lisinopril');
    expect(personal).not.toContain(PERSONAL_SECRET);

    const list = await listText(token);
    expect(list).toContain(WORK_1);
    expect(list).not.toContain('lisinopril');
  });

  it('add a work memory + push → it appears; forget one + push → it disappears (make-scopes-match)', async () => {
    // Add a third work memory in the vault, then re-push.
    const NEW = 'Station 3 generator load test is scheduled for Friday 1400.';
    let newId = '';
    withVault((vault) => {
      newId = vault.remember({ content: NEW, type: 'semantic', scope: 'work' }).id;
      vault.save();
    });
    await withVault((vault) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault }));

    let manifest = await getManifest({ server: base, deviceSecret });
    expect(manifest).toHaveLength(3);
    let serverRows = await storage.listEntries(account);
    expect(serverRows.some((r) => r.content === NEW)).toBe(true);

    // Forget the new memory in the vault and re-push: the server row must vanish.
    withVault((vault) => {
      vault.forget(newId);
      vault.save();
    });
    await withVault((vault) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault }));

    manifest = await getManifest({ server: base, deviceSecret });
    expect(manifest).toHaveLength(2);
    serverRows = await storage.listEntries(account);
    expect(serverRows.some((r) => r.content === NEW)).toBe(false); // gone server-side
    expect(serverRows.some((r) => r.content === WORK_1)).toBe(true); // the others remain
  });

  it('share remove work → /mcp returns nothing, shared_entries is empty, a tombstone exists', async () => {
    const { deleted } = await unshareScope({ server: base, deviceSecret, scope: 'work' });
    expect(deleted).toBe(2);

    // Server-side: zero rows for the account, and a content-free tombstone.
    expect(await storage.listEntries(account)).toHaveLength(0);
    const tombs = await storage.listTombstones(account);
    expect(tombs.some((t) => t.scope === 'work')).toBe(true);

    // An AI app now finds nothing.
    const token = await connectAiApp();
    expect(await listText(token)).toBe('No shared memories yet.');
    expect(await retrieveText(token, 'compliance review')).not.toContain(WORK_1);
  });

  it('a different account never sees these memories (scope isolation)', async () => {
    // Re-share work for account 1 so there is something to (not) leak.
    await withVault((vault) => pushSharedScopes({ server: base, deviceSecret, scopes: ['work'], vault }));

    // Account 2 pushes its own scope and reads only its own row.
    const otherAccount = tokenHash(deriveConnectorToken(otherSecret));
    await storage.upsertAccount(otherAccount);
    await storage.putEntry(otherAccount, {
      entryId: 'other-1',
      scope: 'work',
      type: 'semantic',
      content: 'Account two prefers oat milk.',
      createdAt: new Date().toISOString(),
    });
    const rows = await storage.listEntries(otherAccount);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.content === WORK_1)).toBe(false);
  });

  it('caps: an over-cap push is rejected (per-entry content > 8 KB)', async () => {
    const huge = 'x'.repeat(9 * 1024); // > 8 KB
    const res = await fetch(`${base}/client/entries`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        scopes: ['work'],
        entries: [{ entry_id: 'big', entry_hash: '', scope: 'work', type: 'semantic', content: huge }],
      }),
    });
    expect(res.status).toBe(413);
    // The oversized content did NOT land.
    const rows = await storage.listEntries(account);
    expect(rows.some((r) => r.entryId === 'big')).toBe(false);
  });

  it('caps: too many entries is rejected (> 5000)', async () => {
    const entries = Array.from({ length: 5001 }, (_, i) => ({
      entry_id: `e${i}`,
      entry_hash: '',
      scope: 'work',
      type: 'semantic',
      content: 'x',
    }));
    const res = await fetch(`${base}/client/entries`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: ['work'], entries }),
    });
    expect(res.status).toBe(413);
  });
});
