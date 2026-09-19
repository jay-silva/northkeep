import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROJECT_DOC_CAP_MESSAGE, PROJECT_DOC_MAX_CHARS } from '@northkeep/core/project-doc';
import { deriveConnectorToken, startPairing, tokenHash } from '@northkeep/sync';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { TOMBSTONE_USER_MESSAGE } from '../src/tombstones.js';
import { decryptedEntries, seedEncryptedEntry } from './helpers.js';

/**
 * ADR 0050 claims that live in the connector: hosted project_create behind
 * fail-closed preconditions, memory_remember writability on the pending flag,
 * and the tombstone as an unconditional revoke across every hosted path.
 * Every refusal here also asserts that nothing was stored.
 */

const storage = new InMemoryConnectorStorage();
const deviceSecret = crypto.randomBytes(32);
const connToken = deriveConnectorToken(deviceSecret);
const account = tokenHash(connToken);
const REDIRECT_URI = 'http://localhost:9999/callback';
const b64url = (buf: Buffer): string => buf.toString('base64url');

let server: Server;
let base = '';
let RESOURCE = '';

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
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function connectAiApp(): Promise<string> {
  const pairingCode = await startPairing({ server: base, deviceSecret });
  const as = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'adr0050-client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    }),
  }).then((r) => r.json());
  const clientId = reg.client_id as string;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
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
  const code = location ? new URL(location).searchParams.get('code') : null;
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
    }),
  }).then((r) => r.json() as Promise<{ access_token?: string }>);
  expect(tok.access_token).toBeTruthy();
  return tok.access_token as string;
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

async function unshare(scope: string): Promise<Response> {
  return fetch(`${base}/client/scope/${encodeURIComponent(scope)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${connToken}` },
  });
}

async function rowsIn(scope: string) {
  return (await storage.listEntries(account)).filter((e) => e.scope === scope);
}

/** The deterministic create id the tool derives from the scope (Decision 3.4). */
function createIdFor(scope: string): string {
  return `conn_create_${crypto.createHash('sha256').update(scope).digest('hex').slice(0, 32)}`;
}

beforeAll(async () => {
  const port = await freePort();
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  base = process.env.PUBLIC_URL;
  RESOURCE = `${base}/mcp`;
  server = await new Promise<Server>((resolve) => {
    const srv = createConnectorServer(storage).listen(port, '127.0.0.1', () => resolve(srv));
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0050 hosted project_create', () => {
  it('advertises project_create in the tool inventory', async () => {
    const token = await connectAiApp();
    const resp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const msg = await readRpc(resp);
    const tools = (msg?.result?.tools || []) as Array<{ name: string; description?: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('project_create');
    expect(names).toContain('project_update');
    expect(names).toContain('project_get');
    expect(names).toContain('project_list');
    const create = tools.find((t) => t.name === 'project_create')!;
    expect(create.description).toContain('only when the user asks');
    expect(create.description).toMatch(/Shared with this app/i);
    expect(create.description).not.toContain('\u2014');
    // project_update no longer claims creation is impossible here.
    const update = tools.find((t) => t.name === 'project_update')!;
    expect(update.description).not.toMatch(/cannot create a project/i);
    expect(update.description).toContain('project_create');
  });

  it('creates one pending working row and stores only ciphertext', async () => {
    const token = await connectAiApp();
    const WHY = 'ADR0050-WHY-CANARY';
    const STATUS = 'ADR0050-STATUS-CANARY';
    const NEXT = 'ADR0050-NEXT-CANARY';
    const res = await mcpCall(token, 'project_create', {
      project: 'fresh',
      what_why: WHY,
      status: STATUS,
      next_actions: NEXT,
    });
    expect(res.isError).toBeFalsy();
    const id = createIdFor('project:fresh');
    expect(res.text).toBe(`Created project "fresh". It will sync into the vault. (id: ${id})`);

    const rows = await rowsIn('project:fresh');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entryId).toBe(id);
    expect(rows[0]!.origin).toBe('connector');
    expect(rows[0]!.pending).toBe(true);
    expect(rows[0]!.type).toBe('');
    expect(rows[0]!.content.startsWith('nkc1:')).toBe(true);
    for (const phrase of [WHY, STATUS, NEXT]) expect(storage.dumpState()).not.toContain(phrase);

    const plain = (await decryptedEntries(storage, account, connToken)).find((e) => e.entryId === id)!;
    expect(plain.type).toBe('working');
    expect(plain.content).toContain(WHY);
    expect(plain.content).toContain(STATUS);
    expect(plain.content).toContain(NEXT);

    // The created project is immediately readable and updatable by the app.
    const got = await mcpCall(token, 'project_get', { project: 'fresh' });
    expect(got.isError).toBeFalsy();
    expect(got.text).toContain(STATUS);
    const updated = await mcpCall(token, 'project_update', { project: 'fresh', status: 'Moved on.' });
    expect(updated.isError).toBeFalsy();
    expect(await rowsIn('project:fresh')).toHaveLength(1);
  });

  it('refuses a bad slug, a duplicate document, and an over-cap document; nothing is stored', async () => {
    const token = await connectAiApp();

    const bad = await mcpCall(token, 'project_create', {
      project: 'Not_A_Slug',
      what_why: 'why',
      status: 'status',
    });
    expect(bad.isError).toBe(true);
    expect((await storage.listEntries(account)).some((e) => e.scope.includes('Not_A_Slug'))).toBe(false);

    const dup = await mcpCall(token, 'project_create', {
      project: 'fresh',
      what_why: 'second attempt',
      status: 'second attempt',
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toBe('Project already exists; use project_update.');
    expect(await rowsIn('project:fresh')).toHaveLength(1);

    const over = await mcpCall(token, 'project_create', {
      project: 'toobig',
      what_why: 'why',
      status: 'z'.repeat(PROJECT_DOC_MAX_CHARS),
    });
    expect(over.isError).toBe(true);
    expect(over.text).toBe(PROJECT_DOC_CAP_MESSAGE);
    expect(await rowsIn('project:toobig')).toHaveLength(0);
  });

  it('a forget-queued working row still blocks a create', async () => {
    const token = await connectAiApp();
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'forgotten-doc',
      scope: 'project:forgotten',
      type: 'working',
      content: '## Current Status\n\nStill here.\n',
      createdAt: new Date().toISOString(),
    });
    const forgot = await mcpCall(token, 'memory_forget', { id: 'forgotten-doc' });
    expect(forgot.isError).toBeFalsy();
    // visibleEntries() hides it, so only a listEntries check can see it.
    const res = await mcpCall(token, 'project_create', {
      project: 'forgotten',
      what_why: 'why',
      status: 'status',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toBe('Project already exists; use project_update.');
    expect(await rowsIn('project:forgotten')).toHaveLength(1);
  });

  it('a scope holding only pending archives accepts a create', async () => {
    const token = await connectAiApp();
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'conn_orphan_archive',
      scope: 'project:archives-only',
      type: 'episodic',
      content: '## Log archive: archives-only\n\n- 2026-09-01 - older entry\n',
      origin: 'connector',
      pending: true,
      createdAt: new Date().toISOString(),
    });
    const res = await mcpCall(token, 'project_create', {
      project: 'archives-only',
      what_why: 'Recovering the slug.',
      status: 'Document rebuilt.',
    });
    expect(res.isError).toBeFalsy();
    const rows = await rowsIn('project:archives-only');
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.entryId === createIdFor('project:archives-only'))).toBe(true);
  });

  it('two concurrent creates collapse into one row under the deterministic id', async () => {
    const token = await connectAiApp();
    const results = await Promise.all([
      mcpCall(token, 'project_create', { project: 'racy', what_why: 'first', status: 'first' }),
      mcpCall(token, 'project_create', { project: 'racy', what_why: 'second', status: 'second' }),
    ]);
    // In-memory these serialized in practice, so the deterministic id is what
    // the claim rests on: whichever way they land there is one row under it,
    // and the only refusal allowed is the duplicate one.
    const rows = await rowsIn('project:racy');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entryId).toBe(createIdFor('project:racy'));
    for (const r of results) {
      if (r.isError) expect(r.text).toBe('Project already exists; use project_update.');
      else expect(r.text).toContain(createIdFor('project:racy'));
    }
  });

  it('unshare deletes a not-yet-delivered create', async () => {
    const token = await connectAiApp();
    const made = await mcpCall(token, 'project_create', {
      project: 'shortlived',
      what_why: 'why',
      status: 'status',
    });
    expect(made.isError).toBeFalsy();
    expect(await rowsIn('project:shortlived')).toHaveLength(1);

    expect((await unshare('project:shortlived')).status).toBe(200);
    expect(await rowsIn('project:shortlived')).toHaveLength(0);
    expect(
      (await storage.listPendingEntries(account)).some((e) => e.scope === 'project:shortlived'),
    ).toBe(false);
  });

  it('refuses a create into a tombstoned scope whatever the enforcement flag says', async () => {
    const token = await connectAiApp();
    // The server under test was built with no tombstoneEnforce override and the
    // env flag unset, so this is the flag-OFF state.
    expect(process.env.CONNECTOR_TOMBSTONE_ENFORCE).toBeUndefined();
    const tombs = await storage.listTombstones(account);
    expect(tombs.some((t) => t.scope === 'project:shortlived')).toBe(true);

    const res = await mcpCall(token, 'project_create', {
      project: 'shortlived',
      what_why: 'sneaking back in',
      status: 'sneaking back in',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(TOMBSTONE_USER_MESSAGE);
    expect(res.text).not.toContain('\u2014');
    expect(await rowsIn('project:shortlived')).toHaveLength(0);
  });
});

describe('ADR 0050 memory_remember writability', () => {
  it('refuses a scope whose only rows are pending, without calling it unshared', async () => {
    const token = await connectAiApp();
    const made = await mcpCall(token, 'project_create', {
      project: 'pendingonly',
      what_why: 'why',
      status: 'status',
    });
    expect(made.isError).toBeFalsy();
    const before = (await rowsIn('project:pendingonly')).length;

    const res = await mcpCall(token, 'memory_remember', {
      content: 'A note the app wants to slip in.',
      type: 'semantic',
      scope: 'project:pendingonly',
    });
    expect(res.text).toMatch(/Nothing was saved/);
    expect(res.text).toMatch(/no memory from the vault yet/);
    expect(res.text).not.toMatch(/is not a scope you have shared/);
    expect(res.text).not.toContain('\u2014');
    expect(await rowsIn('project:pendingonly')).toHaveLength(before);

    const unknown = await mcpCall(token, 'memory_remember', {
      content: 'note',
      type: 'semantic',
      scope: 'never-seen',
    });
    expect(unknown.text).toMatch(/is not a scope you have shared/);
  });

  it('accepts once the scope holds a non-pending row, including an acked connector row', async () => {
    const token = await connectAiApp();
    // An acked connector row keeps origin='connector' forever; only `pending`
    // distinguishes it, which is exactly what the check reads.
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'acked-connector-row',
      scope: 'project:acked',
      type: 'working',
      content: '## Current Status\n\nLanded in the vault.\n',
      origin: 'connector',
      pending: false,
      createdAt: new Date().toISOString(),
    });
    const res = await mcpCall(token, 'memory_remember', {
      content: 'A note beside the landed document.',
      type: 'semantic',
      scope: 'project:acked',
    });
    expect(res.text).toMatch(/Saved to shared scope/);
    expect((await rowsIn('project:acked')).length).toBe(2);
  });
});

describe('ADR 0050 the lost race to an unshare', () => {
  it('is invisible, unwritable, undeliverable, and drained', async () => {
    const token = await connectAiApp();
    // Share a scope, let the app write into it, then unshare.
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'vault-row-lostrace',
      scope: 'project:lostrace',
      type: 'working',
      content: '## Current Status\n\nShared and live.\n',
      createdAt: new Date().toISOString(),
    });
    expect((await mcpCall(token, 'project_get', { project: 'lostrace' })).isError).toBeFalsy();
    expect((await unshare('project:lostrace')).status).toBe(200);

    // The write that lost the race lands after the tombstone.
    const LATE = 'ADR0050-LATE-CANARY';
    await seedEncryptedEntry(storage, account, connToken, {
      entryId: 'conn_late_lostrace',
      scope: 'project:lostrace',
      type: 'working',
      content: `## Current Status\n\n${LATE}\n`,
      origin: 'connector',
      pending: true,
      createdAt: new Date().toISOString(),
    });
    expect(await rowsIn('project:lostrace')).toHaveLength(1);

    // Invisible to every hosted read tool.
    const got = await mcpCall(token, 'project_get', { project: 'lostrace' });
    expect(got.isError).toBe(true);
    expect(got.text).toMatch(/no live project document/i);
    const listed = JSON.parse((await mcpCall(token, 'project_list', {})).text) as {
      projects: Array<{ project: string }>;
    };
    expect(listed.projects.some((p) => p.project === 'lostrace')).toBe(false);
    expect((await mcpCall(token, 'memory_list', {})).text).not.toContain('project:lostrace');
    // memory_retrieve and search echo the query, so assert on the results only.
    const retrieved = await mcpCall(token, 'memory_retrieve', { query: LATE });
    expect(retrieved.text).not.toContain('project:lostrace');
    const searched = await mcpCall(token, 'search', { query: LATE });
    expect(searched.text).not.toContain('project:lostrace');
    expect(searched.text).not.toContain('conn_late_lostrace');
    // fetch reads by id and must not inherit visibility from the search result.
    const fetched = await mcpCall(token, 'fetch', { id: 'conn_late_lostrace' });
    expect(fetched.isError).toBe(true);
    expect(fetched.text).not.toContain(LATE);

    // Unwritable.
    const upd = await mcpCall(token, 'project_update', { project: 'lostrace', status: 'still here?' });
    expect(upd.isError).toBe(true);
    expect(upd.text).toBe(TOMBSTONE_USER_MESSAGE);

    // Undelivered, and the row is gone after the call.
    const pending = await fetch(`${base}/client/pending`, {
      headers: { authorization: `Bearer ${connToken}` },
    });
    expect(pending.status).toBe(200);
    const body = (await pending.json()) as { entries: Array<{ scope: string; content: string }> };
    expect(body.entries.some((e) => e.scope === 'project:lostrace')).toBe(false);
    expect(JSON.stringify(body)).not.toContain(LATE);
    expect(await rowsIn('project:lostrace')).toHaveLength(0);
  });
});
