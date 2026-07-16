import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deriveConnectorToken, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';

/**
 * C4 acceptance — ChatGPT hardening (ADR 0019).
 *
 * Proves the ChatGPT retrieval contract on top of the SAME account-scoped data
 * path as memory_retrieve/memory_list: `search({query})` returns
 * { results: [{ id, title, snippet }] } (both structuredContent AND a JSON string
 * in content), `fetch({id})` returns the full { id, title, text, metadata }; a
 * search→fetch round-trip is account-scoped; a SECOND account can neither see the
 * first's memories via search nor fetch them by id (fetch → not-found); and the
 * browser-side connect-flow CORS returns the expected preflight/response headers.
 */

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';
const CHATGPT_ORIGIN = 'https://chatgpt.com';

const storage = new InMemoryConnectorStorage();
let server: Server;
let base = '';
let RESOURCE = '';

const deviceSecret1 = crypto.randomBytes(32);
const deviceSecret2 = crypto.randomBytes(32);
const connToken1 = deriveConnectorToken(deviceSecret1);
const connToken2 = deriveConnectorToken(deviceSecret2);
const account1 = tokenHash(connToken1);
const account2 = tokenHash(connToken2);

const SECRET_MEMORY = 'The user chairs the Tuesday compliance QA/QI review at 0800.';
const ACCT2_MEMORY = 'Account two prefers the 8:05 ferry on inspection days.';

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

beforeAll(async () => {
  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  RESOURCE = `${base}/mcp`;
  [server] = await listen(createConnectorServer(storage), port);

  await storage.putEntry(account1, {
    entryId: 'a1-e1',
    scope: 'work',
    type: 'semantic',
    content: SECRET_MEMORY,
    createdAt: new Date().toISOString(),
  });
  await storage.putEntry(account2, {
    entryId: 'a2-e1',
    scope: 'personal',
    type: 'semantic',
    content: ACCT2_MEMORY,
    createdAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ---- helpers -----------------------------------------------------------

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

async function mcpCall(token: string, body: unknown): Promise<{ status: number; msg: any }> {
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

/** tools/call → the parsed structured envelope (the JSON echoed into content[0].text) + the raw result. */
async function toolCall(token: string, name: string, args: Record<string, unknown>): Promise<{ result: any; parsed: any }> {
  const { msg } = await mcpCall(token, {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e6),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = msg?.result;
  const raw = result?.content?.[0]?.text;
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { result, parsed };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Full OAuth: pair (connToken) → DCR → authorize+consent → token → access token. */
async function connect(connToken: string): Promise<string> {
  const pairResp = await fetch(`${base}/pair/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connToken}` },
    body: '{}',
  });
  const pairingCode = ((await pairResp.json()) as { pairing_code: string }).pairing_code;

  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const clientId = (
    await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'c4-e2e-client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp',
      }),
    }).then((r) => r.json())
  ).client_id as string;

  const { verifier, challenge } = pkce();
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
  const code = new URL(consent.headers.get('location') as string).searchParams.get('code') as string;
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
  }).then((r) => r.json());
  expect(tok.access_token).toBeTruthy();
  return tok.access_token as string;
}

// ---- tests -------------------------------------------------------------

describe('C4 ChatGPT search/fetch tools', () => {
  it('tools/list advertises search + fetch alongside the memory_* tools', async () => {
    const token = await connect(connToken1);
    const { msg } = await mcpCall(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = (msg?.result?.tools || []).map((t: any) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('fetch');
    // Claude's tools remain (additive, not a replacement).
    expect(names).toContain('memory_retrieve');
    expect(names).toContain('memory_list');
    expect(names).toContain('memory_remember');
    expect(names).toContain('memory_forget');
  });

  it('search → ids → fetch(id) returns the full account-scoped record', async () => {
    const token = await connect(connToken1);

    const { result, parsed } = await toolCall(token, 'search', { query: 'compliance review' });
    // Dual format: structuredContent AND the same value as a JSON string in content.
    expect(result.structuredContent?.results).toBeTruthy();
    expect(parsed?.results).toBeTruthy();
    expect(JSON.stringify(parsed.results)).toBe(JSON.stringify(result.structuredContent.results));

    const results = parsed.results as Array<{ id: string; title: string; snippet: string }>;
    expect(results.length).toBeGreaterThanOrEqual(1);
    const hit = results.find((r) => r.snippet.includes('compliance'));
    expect(hit).toBeTruthy();
    expect(hit!.id).toBe('a1-e1');
    expect(hit!.title).toContain('[work]');
    // Contract: results carry no fabricated url (private memory → no citation).
    expect((hit as any).url).toBeUndefined();

    const fetched = await toolCall(token, 'fetch', { id: hit!.id });
    expect(fetched.result.structuredContent?.id).toBe('a1-e1');
    expect(fetched.parsed.text).toBe(SECRET_MEMORY);
    expect(fetched.parsed.title).toContain('[work]');
    expect(fetched.parsed.metadata).toEqual({ scope: 'work', type: 'semantic' });
  });

  it('SCOPE ISOLATION: account 2 cannot see account 1 via search, nor fetch its id', async () => {
    const token2 = await connect(connToken2);

    // Its own memory is searchable...
    const own = await toolCall(token2, 'search', { query: 'ferry inspection' });
    expect(JSON.stringify(own.parsed.results)).toContain('ferry');
    // ...but account 1's secret never appears.
    const cross = await toolCall(token2, 'search', { query: 'compliance review Tuesday QA' });
    expect(JSON.stringify(cross.parsed?.results ?? [])).not.toContain('compliance QA/QI');
    expect(JSON.stringify(cross.parsed?.results ?? [])).not.toContain(SECRET_MEMORY);

    // Fetching account 1's id with account 2's token → not-found (getEntry is
    // account-scoped; the id simply does not exist in account 2's map).
    const stolen = await toolCall(token2, 'fetch', { id: 'a1-e1' });
    expect(stolen.result.isError).toBe(true);
    expect(JSON.stringify(stolen.result)).not.toContain(SECRET_MEMORY);
  });

  it('fetch of an unknown id → not-found error (no leak)', async () => {
    const token = await connect(connToken1);
    const missing = await toolCall(token, 'fetch', { id: 'does-not-exist' });
    expect(missing.result.isError).toBe(true);
  });

  it('audit rows for search/fetch are content-free (ids + counts only)', async () => {
    const token = await connect(connToken1);
    await toolCall(token, 'search', { query: 'compliance' });
    await toolCall(token, 'fetch', { id: 'a1-e1' });
    const rows = storage.auditRows().filter((a) => a.accountHash === account1 && (a.tool === 'search' || a.tool === 'fetch'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain(SECRET_MEMORY);
      expect(JSON.stringify(r)).not.toContain('compliance QA/QI');
    }
    const fetchRow = rows.find((r) => r.tool === 'fetch' && r.ok);
    expect(fetchRow?.resultIds).toContain('a1-e1');
  });
});

describe('C4 CORS for the ChatGPT connect flow', () => {
  it('preflight OPTIONS /register from the ChatGPT origin → 204 with reflected ACAO', async () => {
    const resp = await fetch(`${base}/register`, {
      method: 'OPTIONS',
      headers: {
        Origin: CHATGPT_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBe(CHATGPT_ORIGIN);
    expect((resp.headers.get('access-control-allow-methods') || '').toUpperCase()).toContain('POST');
    expect((resp.headers.get('access-control-allow-headers') || '').toLowerCase()).toContain('authorization');
    expect(resp.headers.get('vary') || '').toContain('Origin');
  });

  it('preflight OPTIONS /token from the ChatGPT origin → 204 with reflected ACAO', async () => {
    const resp = await fetch(`${base}/token`, {
      method: 'OPTIONS',
      headers: { Origin: CHATGPT_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBe(CHATGPT_ORIGIN);
  });

  it('GET the AS metadata is world-readable (ACAO *) and a GET carries the header', async () => {
    const resp = await fetch(`${base}/.well-known/oauth-authorization-server`, {
      headers: { Origin: 'https://example.com' },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('an UNKNOWN origin gets NO ACAO on /token (tight allowlist, not wildcard)', async () => {
    const resp = await fetch(`${base}/token`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    // Still answers the preflight, but with no allow-origin → browser blocks it.
    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('the bearer-protected /mcp is NOT in the connect-flow allowlist path (keeps its own reflect)', async () => {
    // /mcp handles OPTIONS in its own middleware and returns 204; the connect-flow
    // middleware must not have swallowed it. A ChatGPT-origin preflight still works.
    const resp = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: CHATGPT_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get('access-control-allow-origin')).toBe(CHATGPT_ORIGIN);
  });
});
