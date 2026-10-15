import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { SAMPLE_ROWS, seedReviewerAccount } from '../src/reviewer-seed.js';
import { sha256hex } from '../src/hash.js';
import { mcpToolCall } from './helpers.js';

describe('reviewer sample vault', () => {
  it('writes only fictional sample rows, and refuses an account that already has other data', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = 'reviewer-token-test-only';
    const first = await seedReviewerAccount(storage, token);
    expect(first.rowsWritten).toBe(SAMPLE_ROWS.length);
    expect(first.pairingCode).toMatch(/^[A-Z2-9]{8}$/);
    const rows = await storage.listEntries(first.accountHash);
    expect(rows.every((row) => row.entryId.startsWith('sample-'))).toBe(true);
    expect(rows.every((row) => row.content.startsWith('nkc1:'))).toBe(true);
    const dekWrap = await storage.getAccountDekWrap(first.accountHash);
    expect(dekWrap).toBeTruthy();
    const second = await seedReviewerAccount(storage, token);
    expect(second.accountHash).toBe(first.accountHash);
    expect((await storage.listEntries(first.accountHash)).length).toBe(SAMPLE_ROWS.length);
    await storage.putEntry(first.accountHash, {
      entryId: 'real-user-row',
      scope: 'work',
      type: '',
      content: 'nkc1:not-ours',
      createdAt: new Date().toISOString(),
    });
    await expect(seedReviewerAccount(storage, token)).rejects.toThrow(/Nothing was changed/);
    const after = await storage.listEntries(first.accountHash);
    expect(after.some((row) => row.entryId === 'real-user-row')).toBe(true);
  });

  it('a reviewer pairing code can read the sample project and memories', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    const seeded = await seedReviewerAccount(storage, token);
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    const app = createConnectorServer(storage);
    const server = await new Promise<Server>((resolve) => {
      const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    });
    try {
      const access = await connectWithCode(`http://127.0.0.1:${port}`, seeded.pairingCode);
      const search = await mcpToolCall(`http://127.0.0.1:${port}`, access, 'search', { query: 'Lantern Gazette' });
      expect(search.isError).toBe(false);
      expect(search.text).toContain('fictional');
      const projects = await mcpToolCall(`http://127.0.0.1:${port}`, access, 'project_list', {});
      expect(projects.text).toContain('lantern-gazette');
      const listed = await storage.listEntries(seeded.accountHash);
      expect(listed.some((row) => row.content.includes('Mara Quill'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(sha256hex(token)).toBe(seeded.accountHash);
  });
});

async function connectWithCode(base: string, pairingCode: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:9999/callback';
  const resource = `${base}/mcp`;
  const as = (await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json())) as {
    registration_endpoint: string;
  };
  const reg = (await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'reviewer-test',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = 'st';
  await fetch(`${base}/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource,
  })}`);
  const consent = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state,
      resource,
      pairing_code: pairingCode,
    }).toString(),
  });
  const code = new URL(consent.headers.get('location') ?? 'http://127.0.0.1/missing').searchParams.get('code');
  const tok = (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource,
    }),
  }).then((r) => r.json())) as { access_token?: string };
  if (!tok.access_token) throw new Error('reviewer token was not issued');
  return tok.access_token;
}

describe('sample copy', () => {
  it('stays fictional', () => {
    const blob = SAMPLE_ROWS.map((row) => row.content).join('\n');
    expect(blob).toContain('fictional');
    expect(blob).not.toMatch(/silvapeak|@northkeep\.ai|sk-|ghp_/);
  });
});

describe('operator reviewer seed route', () => {
  const secret = crypto.randomBytes(32).toString('base64url');

  async function withServer(
    env: string | undefined,
    run: (base: string, storage: InMemoryConnectorStorage) => Promise<void>,
  ): Promise<void> {
    const storage = new InMemoryConnectorStorage();
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const saved = process.env.NORTHKEEP_REVIEWER_SEED_SECRET;
    if (env === undefined) delete process.env.NORTHKEEP_REVIEWER_SEED_SECRET;
    else process.env.NORTHKEEP_REVIEWER_SEED_SECRET = env;
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    const app = createConnectorServer(storage);
    if (saved === undefined) delete process.env.NORTHKEEP_REVIEWER_SEED_SECRET;
    else process.env.NORTHKEEP_REVIEWER_SEED_SECRET = saved;
    const server = await new Promise<Server>((resolve) => {
      const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    });
    try {
      await run(`http://127.0.0.1:${port}`, storage);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const seedCall = (base: string, bearer: string | null, connectorToken: string) =>
    fetch(`${base}/operator/reviewer-seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ connectorToken }),
    });

  it('does not exist when the secret is unset or shorter than 32 characters', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    for (const env of [undefined, '', 'short-secret-under-32-chars']) {
      await withServer(env, async (base, storage) => {
        const resp = await seedCall(base, env || secret, token);
        expect(resp.status).toBe(404);
        expect(await storage.listEntries(sha256hex(token))).toEqual([]);
      });
    }
  });

  it('refuses a missing or wrong secret and writes nothing', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await withServer(secret, async (base, storage) => {
      expect((await seedCall(base, null, token)).status).toBe(401);
      expect((await seedCall(base, `${secret}x`, token)).status).toBe(401);
      expect(await storage.listEntries(sha256hex(token))).toEqual([]);
      expect(await storage.getAccountDekWrap(sha256hex(token))).toBeFalsy();
    });
  });

  it('seeds with the right secret, and the returned code connects an app to the sample vault', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await withServer(secret, async (base, storage) => {
      const resp = await seedCall(base, secret, token);
      expect(resp.status).toBe(201);
      expect(resp.headers.get('cache-control')).toBe('no-store');
      const body = (await resp.json()) as { rows_written: number; pairing_code: string; expires_at: string };
      expect(body.rows_written).toBe(SAMPLE_ROWS.length);
      expect(body.pairing_code).toMatch(/^[A-Z2-9]{8}$/);
      expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
      const rows = await storage.listEntries(sha256hex(token));
      expect(rows.map((r) => r.entryId).sort()).toEqual(SAMPLE_ROWS.map((r) => r.entryId).sort());
      const access = await connectWithCode(base, body.pairing_code);
      const projects = await mcpToolCall(base, access, 'project_list', {});
      expect(projects.text).toContain('lantern-gazette');
    });
  });

  it('refuses an account that holds real rows and leaves them alone', async () => {
    const token = crypto.randomBytes(24).toString('hex');
    await withServer(secret, async (base, storage) => {
      await storage.upsertAccount(sha256hex(token));
      await storage.putEntry(sha256hex(token), {
        entryId: 'real-user-row',
        scope: 'work',
        type: '',
        content: 'nkc1:not-ours',
        createdAt: new Date().toISOString(),
      });
      const resp = await seedCall(base, secret, token);
      expect(resp.status).toBe(409);
      const rows = await storage.listEntries(sha256hex(token));
      expect(rows.map((r) => r.entryId)).toEqual(['real-user-row']);
    });
  });

  it('rejects a short connector token', async () => {
    await withServer(secret, async (base) => {
      expect((await seedCall(base, secret, 'too-short')).status).toBe(400);
    });
  });
});
