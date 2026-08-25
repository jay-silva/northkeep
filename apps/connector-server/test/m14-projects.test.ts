import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PROJECT_DOC_CAP_MESSAGE,
  PROJECT_DOC_MAX_CHARS,
  emptyProjectDoc,
  getProjectSection,
  mergeProjectDoc,
  parseProjectDoc,
  serializeProjectDoc,
} from '@northkeep/core/project-doc';
import { Vault, KDF_INTERACTIVE, generateDeviceSecret } from '@northkeep/core';
import { deriveConnectorToken, downSyncConnector, pushSharedScopes, startPairing, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { decryptedEntries, decryptedPendingEntries, seedEncryptedEntry } from './helpers.js';

/**
 * M14 — connector project tools + project-scope push cap + desktop fold
 * (ADR 0040). No rider, slug-exact validation, fail-closed create.
 */

it('keeps the local project-doc copy byte-identical to core', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const here = path.join(dir, '..', 'src', 'project-doc.ts');
  const core = path.join(dir, '..', '..', '..', 'packages', 'core', 'src', 'project-doc.ts');
  expect(fs.readFileSync(here, 'utf8')).toBe(fs.readFileSync(core, 'utf8'));
});

const b64url = (buf: Buffer): string => buf.toString('base64url');
const REDIRECT_URI = 'http://localhost:9999/callback';

const storage = new InMemoryConnectorStorage();
const deviceSecret = generateDeviceSecret();
const connToken = deriveConnectorToken(deviceSecret);
const account = tokenHash(connToken);
const passphrase = 'correct horse battery staple';

const STATUS_PHRASE = 'M14-STATUS-UNIQUE';
const LOG_PHRASE = 'M14-LOG-UNIQUE';

let server: Server;
let base = '';
let RESOURCE = '';
let tmpDir = '';
let vaultPath = '';

function sampleDoc(status: string): string {
  return serializeProjectDoc(
    mergeProjectDoc(emptyProjectDoc(), {
      whatWhy: 'Shared project handoff.',
      status,
      nextActions: '- [ ] Next',
      logEntry: 'Seeded the project.',
    }),
  );
}

async function listen(app: ReturnType<typeof createConnectorServer>, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
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

function withVault<T>(fn: (v: Vault) => T | Promise<T>): Promise<T> {
  const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
  return Promise.resolve(fn(vault)).finally(() => vault.close());
}

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
      client_name: 'm14-e2e-client',
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
    }),
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

async function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
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
  return {
    text: call?.result?.content?.[0]?.text || call?.error?.message || '',
    isError: call?.result?.isError === true || Boolean(call?.error),
  };
}

async function pushEntries(
  scopes: string[],
  entries: Array<{ entry_id: string; scope: string; type: string; content: string }>,
): Promise<Response> {
  return fetch(`${base}/client/entries`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${connToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      scopes,
      entries: entries.map((e) => ({ entry_hash: '', ...e })),
    }),
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m14-'));
  vaultPath = path.join(tmpDir, 'vault.nkv');
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  vault.remember({ content: sampleDoc('Initial status.'), type: 'working', scope: 'project:northkeep' });
  vault.remember({ content: 'Ordinary work note.', type: 'semantic', scope: 'work' });
  vault.setScopeShared('project:northkeep', true);
  vault.setScopeShared('work', true);
  vault.save();
  vault.close();

  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  RESOURCE = `${base}/mcp`;
  server = await listen(createConnectorServer(storage), port);

  await withVault((v) =>
    pushSharedScopes({ server: base, deviceSecret, scopes: ['project:northkeep', 'work'], vault: v }),
  );
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('M14 push-path cap (step 3)', () => {
  it('413 names both caps; ordinary 8 KiB still applies outside slug-valid project working rows', async () => {
    const nineK = 'x'.repeat(9 * 1024);

    const ordinary = await pushEntries(
      ['work'],
      [{ entry_id: 'ord-big', scope: 'work', type: 'semantic', content: nineK }],
    );
    expect(ordinary.status).toBe(413);
    const ordinaryBody = (await ordinary.json()) as { error: string };
    expect(ordinaryBody.error).toContain('8192');
    expect(ordinaryBody.error).toContain('65536');

    const projectSemantic = await pushEntries(
      ['project:northkeep'],
      [{ entry_id: 'proj-sem', scope: 'project:northkeep', type: 'semantic', content: nineK }],
    );
    expect(projectSemantic.status).toBe(413);

    const prefixOnly = await pushEntries(
      ['project:foo_bar'],
      [{ entry_id: 'prefix', scope: 'project:foo_bar', type: 'working', content: nineK }],
    );
    expect(prefixOnly.status).toBe(413);

    expect((await storage.listEntries(account)).some((r) => r.entryId === 'ord-big')).toBe(false);
    expect((await storage.listEntries(account)).some((r) => r.entryId === 'proj-sem')).toBe(false);
    expect((await storage.listEntries(account)).some((r) => r.entryId === 'prefix')).toBe(false);
  });

  it('allows a 9 KiB working document in a slug-valid project scope and refuses 64 KiB + 1', async () => {
    const nineK = `# Current Status\n\n${'y'.repeat(9 * 1024 - 20)}`;
    const ok = await pushEntries(
      ['project:capok'],
      [{ entry_id: 'proj-ok', scope: 'project:capok', type: 'working', content: nineK }],
    );
    expect(ok.status).toBe(200);

    const tooBig = 'z'.repeat(64 * 1024 + 1);
    const refused = await pushEntries(
      ['project:capok'],
      [{ entry_id: 'proj-huge', scope: 'project:capok', type: 'working', content: tooBig }],
    );
    expect(refused.status).toBe(413);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('8192');
    expect(body.error).toContain('65536');
    expect((await storage.listEntries(account)).some((r) => r.entryId === 'proj-huge')).toBe(false);
  });
});

describe('M14 connector project tools (step 4)', () => {
  it('lists and gets the shared project; prefix-only scopes are not projects', async () => {
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'not-a-project',
      scope: 'project:foo_bar',
      type: 'working',
      content: '## Current Status\n\nShould not list.\n',
      createdAt: new Date().toISOString(),
    });

    const token = await connectAiApp();
    const listed = await mcpCall(token, 'project_list', {});
    expect(listed.isError).toBe(false);
    const payload = JSON.parse(listed.text) as { projects: Array<{ project: string; status: string; scope: string }> };
    expect(payload.projects.some((p) => p.project === 'northkeep')).toBe(true);
    expect(payload.projects.some((p) => p.scope === 'project:foo_bar')).toBe(false);
    expect(payload.projects.find((p) => p.project === 'northkeep')?.status).toContain('Initial status.');

    const got = await mcpCall(token, 'project_get', { project: 'northkeep' });
    expect(got.isError).toBe(false);
    expect(got.text).toContain('Shared project handoff.');
    expect(got.text).toContain('Initial status.');

    const invalid = await mcpCall(token, 'project_get', { project: 'foo_bar' });
    expect(invalid.isError).toBe(true);
    expect(invalid.text.toLowerCase()).toMatch(/invalid|slug/);

    const audit = storage.auditRows().filter((a) => a.tool === 'project_list' || a.tool === 'project_get');
    const dumped = JSON.stringify(audit);
    expect(dumped).not.toContain('Should not list.');
    expect(dumped).not.toContain(STATUS_PHRASE);
  });

  it('updates in place, refuses create, and keeps ciphertext at rest', async () => {
    const token = await connectAiApp();
    const first = await mcpCall(token, 'project_update', {
      project: 'northkeep',
      status: STATUS_PHRASE,
      log_entry: LOG_PHRASE,
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('Updated project "northkeep"');
    const firstId = /id: (conn_[0-9a-f]+)/.exec(first.text)?.[1];
    expect(firstId).toBeTruthy();

    const pending1 = await storage.listPendingEntries(account);
    const projectPending = pending1.filter((e) => e.scope === 'project:northkeep');
    expect(projectPending).toHaveLength(1);
    expect(projectPending[0]!.entryId).toBe(firstId);
    expect(projectPending[0]!.content.startsWith('nkc1:')).toBe(true);
    expect(projectPending[0]!.type).toBe('');
    expect(storage.dumpState()).not.toContain(STATUS_PHRASE);
    expect(storage.dumpState()).not.toContain(LOG_PHRASE);

    const plain = await decryptedPendingEntries(storage, account, connToken);
    const doc = plain.find((e) => e.entryId === firstId);
    expect(doc?.type).toBe('working');
    expect(doc?.content).toContain(STATUS_PHRASE);
    expect(doc?.content).toContain(LOG_PHRASE);
    expect(doc?.content).toContain('Shared project handoff.');

    const second = await mcpCall(token, 'project_update', {
      project: 'northkeep',
      status: 'Second status.',
      log_entry: 'Second log.',
    });
    expect(second.isError).toBe(false);
    const secondId = /id: (conn_[0-9a-f]+)/.exec(second.text)?.[1];
    expect(secondId).toBe(firstId);
    expect((await storage.listPendingEntries(account)).filter((e) => e.scope === 'project:northkeep')).toHaveLength(1);

    const after = (await decryptedPendingEntries(storage, account, connToken)).find((e) => e.entryId === firstId);
    const parsed = parseProjectDoc(after!.content);
    expect(getProjectSection(parsed, 'Current Status')).toBe('Second status.');
    expect(getProjectSection(parsed, 'Log')).toContain('Second log.');
    expect(getProjectSection(parsed, 'Log')).toContain(LOG_PHRASE);
    expect(getProjectSection(parsed, 'What & Why')).toContain('Shared project handoff.');

    const listed = JSON.parse((await mcpCall(token, 'project_list', {})).text) as {
      projects: Array<{ project: string; status: string }>;
    };
    expect(listed.projects.find((p) => p.project === 'northkeep')?.status).toBe('Second status.');
  });

  it('refuses unshared, never-shared, empty update, and over-cap merge; nothing is stored', async () => {
    const token = await connectAiApp();
    const before = (await storage.listPendingEntries(account)).length;

    const neverShared = await mcpCall(token, 'project_update', { project: 'never-shared', status: 'nope' });
    expect(neverShared.isError).toBe(true);
    expect(neverShared.text).toMatch(/no live project document/);

    const empty = await mcpCall(token, 'project_update', { project: 'northkeep' });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/at least one/);

    const over = await mcpCall(token, 'project_update', {
      project: 'northkeep',
      status: 'z'.repeat(PROJECT_DOC_MAX_CHARS),
    });
    expect(over.isError).toBe(true);
    expect(over.text).toBe(PROJECT_DOC_CAP_MESSAGE);

    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'semantic-only',
      scope: 'project:semantic-only',
      type: 'semantic',
      content: 'Not a working project doc.',
      createdAt: new Date().toISOString(),
    });
    const noWorking = await mcpCall(token, 'project_update', { project: 'semantic-only', status: 'nope' });
    expect(noWorking.isError).toBe(true);
    expect(noWorking.text).toMatch(/no live project document/);

    expect(await storage.listPendingEntries(account)).toHaveLength(before);
    expect((await storage.listEntries(account)).some((r) => r.scope === 'project:never-shared')).toBe(false);
  });

  it('memory_remember stays at 8 KiB even in a project scope', async () => {
    const token = await connectAiApp();
    const huge = await mcpCall(token, 'memory_remember', {
      content: 'x'.repeat(9 * 1024),
      type: 'semantic',
      scope: 'project:northkeep',
    });
    expect(huge.text).toMatch(/8192|8/);
    expect(huge.text).toMatch(/Nothing was saved/);
  });

  it('unshare deletes a not-yet-delivered project update', async () => {
    const token = await connectAiApp();
    await mcpCall(token, 'project_update', { project: 'northkeep', status: 'About to unshare.' });
    expect((await storage.listPendingEntries(account)).some((e) => e.scope === 'project:northkeep')).toBe(true);

    const res = await fetch(`${base}/client/scope/${encodeURIComponent('project:northkeep')}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${connToken}` },
    });
    expect(res.status).toBe(200);
    expect((await storage.listEntries(account)).some((e) => e.scope === 'project:northkeep')).toBe(false);
    expect((await storage.listPendingEntries(account)).some((e) => e.scope === 'project:northkeep')).toBe(false);
  });
});

describe('M14 desktop fold (step 5)', () => {
  it('supersedes the local live working doc; old-client remember-fold leaves the prior doc live', async () => {
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'fold-base',
      scope: 'project:foldme',
      type: 'working',
      content: sampleDoc('Local live.'),
      createdAt: new Date().toISOString(),
    });
    await withVault((v) => {
      v.remember({ content: sampleDoc('Local live.'), type: 'working', scope: 'project:foldme' });
      v.setScopeShared('project:foldme', true);
      v.save();
    });

    const token = await connectAiApp();
    const updated = await mcpCall(token, 'project_update', {
      project: 'foldme',
      status: 'Cloud wrote this.',
      log_entry: 'Fold acceptance.',
    });
    expect(updated.isError).toBe(false);

    const down = await withVault((v) => downSyncConnector({ server: base, deviceSecret, vault: v }));
    expect(down.added).toBeGreaterThanOrEqual(1);

    await withVault((v) => {
      const live = v.list({ scope: 'project:foldme', type: 'working' });
      expect(live).toHaveLength(1);
      expect(live[0]!.content).toContain('Cloud wrote this.');
      expect(live[0]!.content).toContain('Fold acceptance.');
      const all = v.list({ scope: 'project:foldme', type: 'working', includeSuperseded: true });
      expect(all.length).toBeGreaterThanOrEqual(2);
      expect(all.some((e) => e.content.includes('Local live.') && e.superseded_at !== null)).toBe(true);
      expect(v.verifyChain().ok).toBe(true);
    });

    // Old-client residual: remember-fold, newest-wins shows the folded doc,
    // prior document remains live.
    await withVault((v) => {
      const prior = sampleDoc('Prior local remains.');
      v.remember({ content: prior, type: 'working', scope: 'project:oldclient' });
      const folded = sampleDoc('Old-client folded.');
      v.remember({ content: folded, type: 'working', scope: 'project:oldclient' });
      v.save();
      const live = v.list({ scope: 'project:oldclient', type: 'working' });
      expect(live).toHaveLength(2);
      const newest = live[live.length - 1]!;
      expect(newest.content).toContain('Old-client folded.');
      expect(live.some((e) => e.content.includes('Prior local remains.') && e.superseded_at === null)).toBe(true);
    });
  });
});
