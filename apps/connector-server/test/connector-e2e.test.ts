import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { sha256hex } from '../src/hash.js';

/**
 * C1 acceptance — the hosted shareable-scope connector against a locally-started
 * server with InMemoryStorage. Proves: pairing bridge, full OAuth (DCR →
 * authorize consent → token), account-scoped /mcp tools, cross-account
 * isolation, the wrong/expired-pairing-code refusals, and — the whole point of
 * C1 — that state persists across server instances built over the same storage
 * (the C0 in-memory failure mode this phase exists to fix).
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';

// One shared storage; TWO server instances over it (A "mints", B is the
// "serverless cold start / different worker" that must serve the same tokens).
const storage = new InMemoryConnectorStorage();
let serverA: Server;
let serverB: Server;
let baseA = ''; // == PUBLIC_URL: both instances share this configured origin
let baseB = ''; // B's real bind port (a "different serverless worker")
let RESOURCE = ''; // the single RFC 8707 audience, derived from PUBLIC_URL

// Account 1 (the primary subscriber) and account 2 (a different device secret).
const deviceSecret1 = crypto.randomBytes(32);
const deviceSecret2 = crypto.randomBytes(32);
const connToken1 = deriveConnectorToken(deviceSecret1);
const connToken2 = deriveConnectorToken(deviceSecret2);
const account1 = tokenHash(connToken1);
const account2 = tokenHash(connToken2);

const SECRET_MEMORY = 'The user chairs the Tuesday compliance QA/QI review at 0800.';

async function listen(app: ReturnType<typeof createConnectorServer>, port: number): Promise<[Server, string]> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return [server, `http://127.0.0.1:${addr.port}`];
}

/** Grab a free ephemeral port, then release it so we can bind PUBLIC_URL to it. */
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
  // Both "instances" model ONE deployment behind a single public origin, so they
  // must share PUBLIC_URL (→ same issuer + same /mcp audience). A binds to that
  // origin's port; B binds elsewhere but keeps the same PUBLIC_URL, so a token
  // minted anywhere validates everywhere. RESOURCE is the shared audience.
  const portA = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${portA}`;
  baseA = process.env.PUBLIC_URL;
  RESOURCE = `${baseA}/mcp`;
  [serverA] = await listen(createConnectorServer(storage), portA);
  [serverB, baseB] = await listen(createConnectorServer(storage), 0);
});

afterAll(async () => {
  await new Promise<void>((r) => serverA.close(() => r()));
  await new Promise<void>((r) => serverB.close(() => r()));
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

async function mcpCall(base: string, token: string, body: unknown): Promise<{ status: number; msg: any }> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, msg: await readRpc(resp) };
}

/** Start a pairing on `base` for a connector token, returning the shown code. */
async function pairStart(base: string, connToken: string): Promise<string> {
  const resp = await fetch(`${base}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connToken}` },
    body: '{}',
  });
  expect(resp.status).toBe(200);
  const json = (await resp.json()) as { pairing_code: string };
  expect(json.pairing_code).toMatch(/^[A-Z2-9]{8}$/);
  return json.pairing_code;
}

/** DCR: register a public PKCE client on `base`. */
async function register(base: string): Promise<string> {
  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'c1-e2e-client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    }),
  }).then((r) => r.json());
  expect(reg.client_id).toBeTruthy();
  return reg.client_id;
}

/** authorize → consent(pairingCode) → returns the authorization code (or the raw consent Response for refusal tests). */
async function authorizeAndConsent(
  base: string,
  clientId: string,
  challenge: string,
  state: string,
  pairingCode: string,
): Promise<{ code: string | null; consentStatus: number; consentText: string; location: string | null }> {
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
  const page = await fetch(authUrl);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('name="pairing_code"'); // it's the consent form, not an auto-approve

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
  const code = location ? new URL(location).searchParams.get('code') : null;
  return { code, consentStatus: consent.status, consentText: location ? '' : await consent.text(), location };
}

async function tokenExchange(
  base: string,
  clientId: string,
  code: string,
  verifier: string,
  resource = RESOURCE,
): Promise<{ status: number; json: any }> {
  const resp = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

describe('C1 connector acceptance', () => {
  it('sha256hex matches @northkeep/sync tokenHash (account key alignment)', () => {
    expect(sha256hex(connToken1)).toBe(account1);
  });

  it('serves RFC 9728 PRM and RFC 8414 AS metadata', async () => {
    const prm = await fetch(`${baseA}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
    expect(prm.resource).toBe(`${baseA}/mcp`);
    const as = await fetch(`${baseA}/.well-known/oauth-authorization-server`).then((r) => r.json());
    expect(as.registration_endpoint).toBeTruthy();
    expect(as.code_challenge_methods_supported).toContain('S256');
  });

  it('unauthenticated /mcp -> 401 with WWW-Authenticate resource_metadata', async () => {
    const resp = await fetch(`${baseA}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(resp.status).toBe(401);
    expect(resp.headers.get('www-authenticate') || '').toMatch(/resource_metadata=/);
  });

  it('full flow: pair (A) → DCR+authorize+consent (A) → token+/mcp (B, a DIFFERENT instance)', async () => {
    // Seed a shared memory for account 1 (C1: seeded rows).
    await storage.putEntry(account1, {
      entryId: 'e1',
      scope: 'work',
      type: 'fact',
      content: SECRET_MEMORY,
      createdAt: new Date().toISOString(),
    });

    // Pair + register + authorize + consent all on instance A.
    const pairingCode = await pairStart(baseA, connToken1);
    const clientId = await register(baseA);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code, consentStatus } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    expect(consentStatus).toBe(302);
    expect(code).toBeTruthy();

    // Token exchange happens on instance B — proves the DCR client AND the
    // authorization code persisted in shared storage, not an A-local Map.
    const tok = await tokenExchange(baseB, clientId, code as string, verifier);
    expect(tok.status).toBe(200);
    expect(tok.json.access_token).toBeTruthy();
    expect(tok.json.refresh_token).toBeTruthy();
    const accessToken = tok.json.access_token as string;

    // MCP initialize + tools/list + tools/call, all on instance B.
    const init = await mcpCall(baseB, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c1-e2e', version: '0.1.0' } },
    });
    expect(init.status).toBe(200);
    expect(init.msg?.result?.serverInfo?.name).toBe('northkeep-connector');

    const list = await mcpCall(baseB, accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolNames = (list.msg?.result?.tools || []).map((t: any) => t.name);
    expect(toolNames).toContain('memory_retrieve');
    expect(toolNames).toContain('memory_list');

    const call = await mcpCall(baseB, accessToken, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_retrieve', arguments: { query: 'compliance review' } },
    });
    const text = call.msg?.result?.content?.[0]?.text || '';
    expect(text).toContain(SECRET_MEMORY);

    // A content-free audit row was written (no content, ids only).
    const audit = storage.auditRows().filter((a) => a.accountHash === account1);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const last = audit[audit.length - 1]!;
    expect(last.resultIds).toContain('e1');
    expect(JSON.stringify(last)).not.toContain(SECRET_MEMORY);
  });

  it('SCOPE ISOLATION: a second account cannot read the first account’s entries', async () => {
    // Account 2 pairs and gets its own token, but has no seeded entries.
    const pairingCode = await pairStart(baseA, connToken2);
    const clientId = await register(baseA);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code, consentStatus } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    expect(consentStatus).toBe(302);
    const tok = await tokenExchange(baseB, clientId, code as string, verifier);
    const token2 = tok.json.access_token as string;

    // Seed a DIFFERENT secret for account 2 so we can prove the boundary both ways.
    await storage.putEntry(account2, {
      entryId: 'x1',
      scope: 'personal',
      type: 'fact',
      content: 'Account two likes espresso.',
      createdAt: new Date().toISOString(),
    });

    const retrieve = await mcpCall(baseB, token2, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'memory_retrieve', arguments: { query: 'compliance review' } },
    });
    const text = retrieve.msg?.result?.content?.[0]?.text || '';
    // Account 2 must NOT see account 1's specific memory content.
    expect(text).not.toContain(SECRET_MEMORY);
    expect(text).not.toContain('compliance QA/QI');

    const list = await mcpCall(baseB, token2, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'memory_list', arguments: {} },
    });
    const listText = list.msg?.result?.content?.[0]?.text || '';
    expect(listText).toContain('espresso'); // its own entry
    expect(listText).not.toContain(SECRET_MEMORY); // never the other account's
  });

  it('PERSISTENCE: a token issued via instance A validates on instance B (C0 failure mode fixed)', async () => {
    // Full mint on A, then use ONLY on B (a fresh createConnectorServer over the
    // same storage — simulating a serverless cold start hitting a warm token).
    await storage.putEntry(account1, {
      entryId: 'e2',
      scope: 'work',
      type: 'fact',
      content: SECRET_MEMORY,
      createdAt: new Date().toISOString(),
    });
    const pairingCode = await pairStart(baseA, connToken1);
    const clientId = await register(baseA);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    const tok = await tokenExchange(baseA, clientId, code as string, verifier); // minted on A
    const accessToken = tok.json.access_token as string;

    // Validate on B.
    const call = await mcpCall(baseB, accessToken, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'memory_retrieve', arguments: { query: 'compliance' } },
    });
    expect(call.status).toBe(200);
    expect(call.msg?.result?.content?.[0]?.text || '').toContain(SECRET_MEMORY);
  });

  it('REFUSE: a wrong pairing code is rejected (no auth code issued)', async () => {
    const clientId = await register(baseA);
    const { challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code, consentStatus, consentText } = await authorizeAndConsent(
      baseA,
      clientId,
      challenge,
      state,
      'WRONGCODE'.slice(0, 8), // 8 chars, valid shape, but never issued
    );
    expect(code).toBeNull();
    expect(consentStatus).toBe(200); // re-renders the consent page with an error
    expect(consentText.toLowerCase()).toContain('wrong');
  });

  it('REFUSE: an expired pairing code is rejected', async () => {
    // Insert a pairing code that already expired.
    const expiredCode = 'EXPIRE23';
    await storage.upsertAccount(account1);
    await storage.putPairingCode(sha256hex(expiredCode), account1, Date.now() - 1000);
    const clientId = await register(baseA);
    const { challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code, consentStatus } = await authorizeAndConsent(baseA, clientId, challenge, state, expiredCode);
    expect(code).toBeNull();
    expect(consentStatus).toBe(200);
  });

  it('PKCE is enforced: a wrong code_verifier fails the token exchange', async () => {
    const pairingCode = await pairStart(baseA, connToken1);
    const clientId = await register(baseA);
    const { challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    const bad = await tokenExchange(baseA, clientId, code as string, b64url(crypto.randomBytes(32)));
    expect(bad.status).toBe(400);
  });

  it('RFC 8707: a token request for a foreign resource is refused (invalid_target)', async () => {
    const pairingCode = await pairStart(baseA, connToken1);
    const clientId = await register(baseA);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    const bad = await tokenExchange(baseA, clientId, code as string, verifier, 'https://evil.example.com/mcp');
    expect(bad.status).toBe(400);
    expect(String(bad.json?.error || '')).toContain('invalid_target');
  });

  it('REFRESH: refresh grant works on a DIFFERENT instance, rotates, and old token is rejected', async () => {
    // Mint the initial pair on A.
    const pairingCode = await pairStart(baseA, connToken1);
    const clientId = await register(baseA);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    const first = await tokenExchange(baseA, clientId, code as string, verifier);
    expect(first.status).toBe(200);
    const refreshToken = first.json.refresh_token as string;

    // Refresh on instance B (a different worker) — proves the refresh token
    // persisted, not just the access token. Public client: no client_secret.
    const refreshResp = await fetch(`${baseB}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      }).toString(),
    });
    expect(refreshResp.status).toBe(200);
    const refreshed = (await refreshResp.json()) as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(refreshToken); // rotated

    // The new access token works on /mcp (B).
    await storage.putEntry(account1, {
      entryId: 'e3',
      scope: 'work',
      type: 'fact',
      content: SECRET_MEMORY,
      createdAt: new Date().toISOString(),
    });
    const call = await mcpCall(baseB, refreshed.access_token, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'memory_retrieve', arguments: { query: 'compliance' } },
    });
    expect(call.status).toBe(200);
    expect(call.msg?.result?.content?.[0]?.text || '').toContain(SECRET_MEMORY);

    // The OLD refresh token must now be rejected (rotation → single-use).
    const replay = await fetch(`${baseA}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it('single-use: an authorization code cannot be exchanged twice', async () => {
    const pairingCode = await pairStart(baseA, connToken1);
    const clientId = await register(baseA);
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(8));
    const { code } = await authorizeAndConsent(baseA, clientId, challenge, state, pairingCode);
    const first = await tokenExchange(baseB, clientId, code as string, verifier);
    expect(first.status).toBe(200);
    const second = await tokenExchange(baseA, clientId, code as string, verifier); // replay on the OTHER instance
    expect(second.status).toBe(400);
  });
});
