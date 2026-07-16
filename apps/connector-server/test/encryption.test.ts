import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { KEK_LABEL_TOKEN, deriveKek, generateDek, wrapDek } from '../src/crypto.js';
import { seedEncryptedEntry } from './helpers.js';

/**
 * ADR 0020 acceptance — encryption at rest, end to end.
 *
 * Proves the full chain of custody: the DEK created at /pair/start travels
 * pairing code → consent → authorization code → token pair → /mcp, where the
 * AI app still receives PLAINTEXT; a refresh rotation re-wraps and custody
 * survives. Proves the atomic refresh consume: two CONCURRENT exchanges of the
 * same refresh token produce exactly one winner (the loser gets invalid_grant)
 * and the winner's tokens still decrypt. Proves the raw DB state never holds
 * the memory plaintext, and that an account whose wrap will not open gets the
 * 409 reencrypt_required refusal, not a 500 and not garbage.
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';

const storage = new InMemoryConnectorStorage();
let server: Server;
let base = '';
let RESOURCE = '';

const deviceSecret = crypto.randomBytes(32);
const connToken = deriveConnectorToken(deviceSecret);
const account = tokenHash(connToken);

const PLAINTEXT_MEMORY = 'The engine 1 hose inventory is recertified on the first Monday of the month.';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  RESOURCE = `${base}/mcp`;
  const app = createConnectorServer(storage);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  await seedEncryptedEntry(storage, account, connToken, {
    entryId: 'enc-1',
    scope: 'work',
    type: 'procedural',
    content: PLAINTEXT_MEMORY,
    createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

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

async function retrieve(token: string, query: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_retrieve', arguments: { query } },
    }),
  });
  const msg = await readRpc(resp);
  return { status: resp.status, text: msg?.result?.content?.[0]?.text || '' };
}

/** Full pair → DCR → authorize → consent → token exchange for `connToken`. */
async function connect(): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const pair = await fetch(`${base}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connToken}` },
    body: '{}',
  });
  expect(pair.status).toBe(200);
  const pairingCode = ((await pair.json()) as { pairing_code: string }).pairing_code;

  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const clientId = (
    await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'enc-e2e',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp',
      }),
    }).then((r) => r.json())
  ).client_id as string;

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  await fetch(
    `${base}/authorize?` +
      new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp',
        state,
        resource: RESOURCE,
      }),
  );
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
  expect(consent.status).toBe(302);
  const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
  const tok = await fetch(`${base}/token`, {
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
  expect(tok.status).toBe(200);
  const json = (await tok.json()) as { access_token: string; refresh_token: string };
  return { accessToken: json.access_token, refreshToken: json.refresh_token, clientId };
}

function refreshExchange(clientId: string, refreshToken: string): Promise<Response> {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: RESOURCE,
    }).toString(),
  });
}

describe('ADR 0020 encryption at rest', () => {
  it('the raw DB state never contains the memory plaintext; rows are nkc1 with type=""', async () => {
    const rows = await storage.listEntries(account);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content.startsWith('nkc1:')).toBe(true);
    expect(rows[0]!.type).toBe('');
    expect(storage.dumpState()).not.toContain(PLAINTEXT_MEMORY);
  });

  it('CUSTODY CHAIN: pair → consent → token → /mcp returns the PLAINTEXT; refresh re-wraps and still works', async () => {
    const { accessToken, refreshToken, clientId } = await connect();

    // The AI app reads plaintext — decrypt-per-request under the token's DEK wrap.
    const first = await retrieve(accessToken, 'hose inventory recertification');
    expect(first.status).toBe(200);
    expect(first.text).toContain(PLAINTEXT_MEMORY);

    // Even after the full OAuth chain, the raw storage still holds no plaintext
    // and no unwrapped key material (only nkw1 wraps + sha256 hashes).
    expect(storage.dumpState()).not.toContain(PLAINTEXT_MEMORY);

    // Refresh rotation: the DEK is re-wrapped for the new pair; custody survives.
    const rotated = await refreshExchange(clientId, refreshToken);
    expect(rotated.status).toBe(200);
    const nt = (await rotated.json()) as { access_token: string; refresh_token: string };
    const second = await retrieve(nt.access_token, 'hose inventory recertification');
    expect(second.status).toBe(200);
    expect(second.text).toContain(PLAINTEXT_MEMORY);
  });

  it('REFRESH RACE: two concurrent exchanges of one refresh token → exactly one winner; the winner still decrypts', async () => {
    const { refreshToken, clientId } = await connect();

    const [a, b] = await Promise.all([
      refreshExchange(clientId, refreshToken),
      refreshExchange(clientId, refreshToken),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(String(((await loser.json()) as { error?: string }).error ?? '')).toContain('invalid_grant');

    const wt = (await winner.json()) as { access_token: string };
    const read = await retrieve(wt.access_token, 'hose inventory recertification');
    expect(read.status).toBe(200);
    expect(read.text).toContain(PLAINTEXT_MEMORY);
  });

  it('REENCRYPT PATH: a wrap that will not open is a 409 reencrypt_required, never a 500', async () => {
    // A different account whose stored wrap was made under the WRONG KEK — the
    // state a DB restore across a key wipe would leave behind.
    const otherToken = deriveConnectorToken(crypto.randomBytes(32));
    const otherAccount = tokenHash(otherToken);
    await storage.upsertAccount(otherAccount);
    const garbageWrap = await wrapDek(await generateDek(), await deriveKek(KEK_LABEL_TOKEN, 'not-the-conn-token'));
    await storage.ensureAccountDekWrap(otherAccount, garbageWrap);

    const pair = await fetch(`${base}/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherToken}` },
      body: '{}',
    });
    expect(pair.status).toBe(409);
    expect(((await pair.json()) as { error: string }).error).toBe('reencrypt_required');

    const push = await fetch(`${base}/client/entries`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        scopes: ['work'],
        entries: [{ entry_id: 'e', entry_hash: '', scope: 'work', type: 'fact', content: 'x' }],
      }),
    });
    expect(push.status).toBe(409);
  });

  it('a pre-0020 access token row (no dek_wrap) is refused with 401, fail-closed', async () => {
    // Simulate a legacy row: a valid sha256-only token record without a wrap.
    const legacyToken = 'legacy-access-token-value-123456';
    await storage.putToken(crypto.createHash('sha256').update(legacyToken, 'utf8').digest('hex'), {
      clientId: 'legacy-client',
      accountHash: account,
      audience: RESOURCE,
      kind: 'access',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      dekWrap: '',
    });
    const read = await retrieve(legacyToken, 'hose inventory');
    expect(read.status).toBe(401);
  });
});
