import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Derive the connector account hash the same way the client does, without
// importing the workspace package (e2e runs from the repo root; it reaches the
// CJS-only sodium-native addon via an explicit require, mirroring m5b).
const nodeRequire = createRequire(import.meta.url);

/**
 * C2 acceptance (CLI end to end) — the REAL `northkeep share` commands drive the
 * hosted-connector push against a locally-started InMemoryStorage connector
 * server. Proves the plan's C2 acceptance from the CLI a user actually types:
 *   share server → share add work (loud, auto-push) → an AI app (OAuth+/mcp with
 *   the code from `share code`) answers a WORK question from REAL vault memory; a
 *   PERSONAL memory is NEVER disclosed; share remove work → the AI finds nothing
 *   and the server's shared_entries for the account is empty with a tombstone.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const connectorLib = path.join(repoRoot, 'apps', 'connector-server', 'dist', 'server.js');
const storageLib = path.join(repoRoot, 'apps', 'connector-server', 'dist', 'storage.js');

const PASSPHRASE = 'c2 cli acceptance passphrase';
const REDIRECT_URI = 'http://localhost:9999/callback';

const WORK_MEMORY = 'The Tuesday compliance QA/QI review starts at 0800 in the ops room.';
const PERSONAL_SECRET = 'The user takes a daily blood-pressure prescription.';

let home = '';
let server: import('node:http').Server;
let base = '';
let RESOURCE = '';
// The InMemory storage instance behind the server (for direct inspection).
let storage: {
  listEntries(a: string): Promise<Array<{ scope: string; content: string }>>;
  listTombstones(a: string): Promise<Array<{ scope: string }>>;
};

function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NORTHKEEP_HOME: home,
          NORTHKEEP_PASSPHRASE: PASSPHRASE,
          NORTHKEEP_NO_KEYCHAIN: '1',
        },
        encoding: 'utf8',
      },
      (err, stdout, stderr) =>
        resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
  });
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

/**
 * The account hash the server keys on, re-derived from this home's device.secret:
 * connector_token = keyed-BLAKE2b(key=device_secret, msg="nk-connector-token-v1"),
 * account_hash = sha256(token-hex-string). Mirrors deriveConnectorToken/tokenHash.
 */
function accountHash(): string {
  const hex = fs.readFileSync(path.join(home, 'device.secret'), 'utf8').trim();
  const deviceSecret = Buffer.from(hex, 'hex');
  const sodium = nodeRequire('sodium-native');
  const out = Buffer.alloc(32);
  sodium.crypto_generichash(out, Buffer.from('nk-connector-token-v1', 'utf8'), deviceSecret);
  return crypto.createHash('sha256').update(out.toString('hex'), 'utf8').digest('hex');
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  expect(fs.existsSync(connectorLib), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-c2cli-'));

  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  RESOURCE = `${base}/mcp`;

  const { createConnectorServer } = await import(connectorLib);
  const { InMemoryConnectorStorage } = await import(storageLib);
  const store = new InMemoryConnectorStorage();
  storage = store;
  const app = createConnectorServer(store);
  server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });

  // Real vault with a work and a personal memory.
  await cli(['init']);
  await cli(['remember', WORK_MEMORY, '--type', 'semantic', '--scope', 'work']);
  await cli(['remember', PERSONAL_SECRET, '--type', 'semantic', '--scope', 'personal']);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- OAuth + MCP (the AI app connecting with a pairing code) --------------

async function readRpc(resp: Response): Promise<any> {
  const ct = resp.headers.get('content-type') || '';
  const text = await resp.text();
  if (ct.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function accessTokenFor(pairingCode: string): Promise<string> {
  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const clientId = (await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'c2-cli-e2e',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    }),
  }).then((r) => r.json())).client_id as string;

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('base64url');

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
  const code = location ? new URL(location).searchParams.get('code') : null;
  expect(code).toBeTruthy();

  const tok = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }).toString(),
  }).then((r) => r.json());
  return tok.access_token as string;
}

async function mcpText(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const msg = await readRpc(resp);
  return msg?.result?.content?.[0]?.text || '';
}

/** The 8-char pairing code printed by `northkeep share code`. */
function parsePairingCode(stdout: string): string {
  const m = stdout.match(/Pairing code:\s*([A-Z2-9]{8})/);
  expect(m, `no pairing code in: ${stdout}`).toBeTruthy();
  return (m as RegExpMatchArray)[1];
}

describe('C2 acceptance (CLI) — share work → AI reads it; personal never leaks; unshare wipes it', () => {
  it('share add work is loud, writes the sidecar, and auto-pushes', async () => {
    const setSrv = await cli(['share', 'server', base]);
    expect(setSrv.code).toBe(0);

    const add = await cli(['share', 'add', 'work', '--yes']);
    expect(add.code).toBe(0);
    // Loud: the confirmation copy names the readable-storage consequence.
    expect(add.stdout).toContain("Scope 'work' is now Shared");

    // Sidecar written 0600 with the server + the shared scope (no secrets).
    const sidecar = JSON.parse(fs.readFileSync(path.join(home, 'connector.json'), 'utf8'));
    expect(sidecar.server).toBe(base);
    expect(sidecar.sharedScopes).toEqual(['work']);
    expect((fs.statSync(path.join(home, 'connector.json')).mode & 0o777)).toBe(0o600);

    // Server now holds exactly the work row (personal was never sent).
    const rows = await storage.listEntries(accountHash());
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('work');
    expect(rows.some((r) => r.content.includes('blood-pressure'))).toBe(false);
  });

  it('an AI app connects with the pairing code and answers from the WORK memory only', async () => {
    const codeOut = await cli(['share', 'code']);
    expect(codeOut.code).toBe(0);
    expect(codeOut.stdout).toContain('Enter this code when connecting NorthKeep');
    const token = await accessTokenFor(parsePairingCode(codeOut.stdout));

    const work = await mcpText(token, 'memory_retrieve', { query: 'when is the compliance review' });
    expect(work).toContain(WORK_MEMORY);

    // The personal memory is never disclosed (list shows only shared scopes).
    const list = await mcpText(token, 'memory_list', {});
    expect(list).toContain(WORK_MEMORY);
    expect(list).not.toContain('blood-pressure');
    expect(list).not.toContain(PERSONAL_SECRET);
  });

  it('share status reports the server and shared-scope counts', async () => {
    const status = await cli(['share', 'status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(base);
    expect(status.stdout).toMatch(/work\s+—\s+1 memory/);
  });

  it('share remove work → the AI finds nothing; the account has zero rows + a tombstone', async () => {
    const remove = await cli(['share', 'remove', 'work']);
    expect(remove.code).toBe(0);
    expect(remove.stdout).toContain("Scope 'work' unshared");

    // Sidecar no longer lists the scope.
    const sidecar = JSON.parse(fs.readFileSync(path.join(home, 'connector.json'), 'utf8'));
    expect(sidecar.sharedScopes).toEqual([]);

    // Server-side: zero rows for the account and a content-free tombstone.
    const account = accountHash();
    expect(await storage.listEntries(account)).toHaveLength(0);
    expect((await storage.listTombstones(account)).some((t) => t.scope === 'work')).toBe(true);

    // A freshly connected AI app now finds nothing.
    const codeOut = await cli(['share', 'code']);
    const token = await accessTokenFor(parsePairingCode(codeOut.stdout));
    expect(await mcpText(token, 'memory_list', {})).toBe('No shared memories yet.');
  });
});
