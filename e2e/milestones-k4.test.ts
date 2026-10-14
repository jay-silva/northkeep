import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * ADR 0065 K4: the real connector server (in-memory storage) and the real CLI
 * on a temp home, with an AI app connected over OAuth and /mcp, as claude.ai
 * would be. This is acceptance Part 2 without claude.ai's model: the app here
 * sends the tool calls directly, so it proves what the connector refuses, not
 * whether a host shows the standing instruction to its model.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const connectorLib = path.join(repoRoot, 'apps', 'connector-server', 'dist', 'create-server.js');
const storageLib = path.join(repoRoot, 'apps', 'connector-server', 'dist', 'storage.js');

const PASSPHRASE = 'k4 milestones e2e passphrase';
const REDIRECT_URI = 'http://localhost:9999/callback';
const PLAN = 'M1 Pick the beds | test: three beds marked out\nM2 Order seeds | test: seed order confirmed';
const INSTRUCTION =
  'When the user asks to create a project, propose its milestones and create it only after the user agrees to them. Report a milestone passed only when the user says its acceptance test passed. Never mark a milestone passed on your own judgment.';

let home = '';
let server: import('node:http').Server;
let base = '';
let token = '';

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NORTHKEEP_HOME: home,
    NORTHKEEP_PASSPHRASE: PASSPHRASE,
    NORTHKEEP_NO_KEYCHAIN: '1',
    NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9',
  };
}

function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { env: env(), encoding: 'utf8' }, (err, stdout, stderr) =>
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
  const resource = `${base}/mcp`;
  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const clientId = (await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'k4-e2e',
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
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'mcp', state, resource,
  }).toString();
  await fetch(authUrl);
  const consent = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT_URI, code_challenge: challenge, state, scope: 'mcp', resource, pairing_code: pairingCode,
    }).toString(),
  });
  const location = consent.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  expect(code).toBeTruthy();
  const tok = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code as string, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource,
    }).toString(),
  }).then((r) => r.json());
  return tok.access_token as string;
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return readRpc(resp);
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const msg = await rpc('tools/call', { name, arguments: args });
  return { text: msg?.result?.content?.[0]?.text ?? '', isError: msg?.result?.isError === true };
}

function revisionOf(getText: string): string {
  const m = /Revision: (\S+) \(pass it/.exec(getText);
  expect(m, getText).toBeTruthy();
  return m![1]!;
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  expect(fs.existsSync(connectorLib), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-k4-'));
  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  const { createConnectorServer } = await import(connectorLib);
  const { InMemoryConnectorStorage } = await import(storageLib);
  const app = createConnectorServer(new InMemoryConnectorStorage());
  server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  expect((await cli(['init'])).code).toBe(0);
  expect((await cli(['share', 'server', base])).code).toBe(0);
  const codeOut = await cli(['share', 'code']);
  const pairing = /Pairing code:\s*([A-Z2-9]{8})/.exec(codeOut.stdout);
  expect(pairing, codeOut.stdout).toBeTruthy();
  token = await accessTokenFor(pairing![1]!);
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0065 K4: milestones through the Cloud connector, end to end', () => {
  it('sends the standing milestone instruction in the handshake', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'k4-e2e', version: '0.0.0' } });
    expect(init.result.instructions).toBe(INSTRUCTION);
  });

  it('refuses a cloud project without milestones or with a pass, then creates one with the agreed plan', async () => {
    const missing = await tool('project_create', { project: 'k4-test', what_why: 'Plan a garden.', status: 'Starting.' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('milestones is required');
    const forged = await tool('project_create', { project: 'k4-test', what_why: 'Plan a garden.', status: 'Starting.', milestones: 'M1 Pick the beds | test: ok | passed 2026-10-01 (you)' });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain('checkbox or a pass stamp');
    const created = await tool('project_create', { project: 'k4-test', what_why: 'Plan a garden.', status: 'Starting.', milestones: PLAN });
    expect(created.isError, created.text).toBe(false);
  });

  it('down-syncs the new project to the Mac with nothing passed (acceptance Part 2 step 2)', async () => {
    const sync = await cli(['share', 'sync', '--yes']);
    expect(sync.code, sync.stderr).toBe(0);
    const shown = await cli(['projects', 'milestones', 'k4-test']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('Project k4-test: 0 of 2 milestones passed.');
  });

  it('the owner passes M1 on the Mac, and the connector then refuses to change or forge a pass (step 3)', async () => {
    // `projects pass` needs a terminal; `script` supplies one, as KNOWN-LIMITS says a program can.
    const passed = spawnSync('script', ['-qec', `${process.execPath} ${cliPath} projects pass k4-test M1`, '/dev/null'], { env: env(), input: 'yes\n', encoding: 'utf8' });
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
    expect((await cli(['share', 'sync', '--yes'])).code).toBe(0);

    const got = await tool('project_get', { project: 'k4-test' });
    expect(got.text).toMatch(/- \[x\] M1 Pick the beds \| test: three beds marked out \| passed \d{4}-\d{2}-\d{2} \(you\)/);
    const rev = revisionOf(got.text);

    const change = await tool('project_update', { project: 'k4-test', expected_revision: rev, milestones: 'M1 Pick two beds | test: two beds' });
    expect(change.text).toBe('Nothing was saved: M1 has already passed. Passed milestones cannot be changed; send only the milestones still to do.');
    const forgeM2 = await tool('project_update', { project: 'k4-test', expected_revision: rev, milestones: '- [x] M2 Order seeds | test: seed order confirmed | passed 2026-10-14 (you)' });
    expect(forgeM2.isError).toBe(true);
    const forgeInStatus = await tool('project_update', { project: 'k4-test', expected_revision: rev, status: '- [x] M2 Order seeds | test: seed order confirmed | passed 2026-10-14 (you)' });
    expect(forgeInStatus.isError).toBe(true);
    expect(revisionOf((await tool('project_get', { project: 'k4-test' })).text)).toBe(rev);
  });

  it('refuses to forget the project document (step 4)', async () => {
    const got = await tool('project_get', { project: 'k4-test' });
    const forget = await tool('memory_forget', { id: revisionOf(got.text) });
    expect(forget.isError).toBe(true);
    expect(forget.text).toBe('Nothing was forgotten: this is the project document of "project:k4-test". An AI app cannot forget a project. The user can remove it in the NorthKeep app.');
  });

  it('accepts an ordinary update that keeps the pass, and the Mac applies it with M1 still confirmed by you', async () => {
    const rev = revisionOf((await tool('project_get', { project: 'k4-test' })).text);
    const update = await tool('project_update', { project: 'k4-test', expected_revision: rev, status: 'Beds marked out.', milestones: 'M2 Order seeds | test: seed order confirmed\nPlant | test: seedlings in' });
    expect(update.isError, update.text).toBe(false);
    const sync = await cli(['share', 'sync', '--yes']);
    expect(sync.code, sync.stderr).toBe(0);
    expect(sync.stdout).not.toContain('Conflict');
    const shown = await cli(['projects', 'milestones', 'k4-test']);
    expect(shown.stdout).toContain('Project k4-test: 1 of 3 milestones passed.');
    expect(shown.stdout).not.toContain('not confirmed by you');
  });
});
