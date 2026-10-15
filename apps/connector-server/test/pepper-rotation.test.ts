import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { KEK_LABEL_CONNECTOR_TOKEN, deriveKek, parseKekPepper, unwrapDek } from '../src/crypto.js';
import { seedReviewerAccount } from '../src/reviewer-seed.js';
import { sha256hex } from '../src/hash.js';
import { mcpToolCall } from './helpers.js';

const OLD = crypto.randomBytes(32).toString('base64');
const NEW = crypto.randomBytes(32).toString('base64');
const OTHER = crypto.randomBytes(32).toString('base64');

const savedEnv = { cur: process.env.CONNECTOR_KEK_PEPPER, next: process.env.CONNECTOR_KEK_PEPPER_NEXT };
afterEach(() => {
  restore('CONNECTOR_KEK_PEPPER', savedEnv.cur);
  restore('CONNECTOR_KEK_PEPPER_NEXT', savedEnv.next);
});
function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function serve(
  storage: InMemoryConnectorStorage,
  current: string,
  next: string | undefined,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  process.env.CONNECTOR_KEK_PEPPER = current;
  if (next === undefined) delete process.env.CONNECTOR_KEK_PEPPER_NEXT;
  else process.env.CONNECTOR_KEK_PEPPER_NEXT = next;
  const app = createConnectorServer(storage);
  const server = await new Promise<Server>((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
  });
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const pairStart = (base: string, token: string) =>
  fetch(`${base}/pair/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });

async function opensUnder(storage: InMemoryConnectorStorage, token: string, pepper: string): Promise<boolean> {
  const wrap = await storage.getAccountDekWrap(sha256hex(token));
  try {
    await unwrapDek(wrap!, await deriveKek(KEK_LABEL_CONNECTOR_TOKEN, token, parseKekPepper(pepper)!));
    return true;
  } catch {
    return false;
  }
}

describe('KEK pepper rotation', () => {
  it('opens an account locked under the old pepper and re-locks it under the new one', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    await serve(storage, OLD, undefined, async (base) => {
      expect((await pairStart(base, token)).status).toBe(200);
    });
    expect(await opensUnder(storage, token, OLD)).toBe(true);
    await serve(storage, OLD, NEW, async (base) => {
      expect((await pairStart(base, token)).status).toBe(200);
    });
    expect(await opensUnder(storage, token, NEW)).toBe(true);
    expect(await opensUnder(storage, token, OLD)).toBe(false);
    await serve(storage, NEW, undefined, async (base) => {
      expect((await pairStart(base, token)).status).toBe(200);
    });
  });

  it('without the rotation variable an old-pepper account is refused, not silently opened', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    await serve(storage, OLD, undefined, async (base) => {
      expect((await pairStart(base, token)).status).toBe(200);
    });
    await serve(storage, NEW, undefined, async (base) => {
      expect((await pairStart(base, token)).status).toBe(409);
    });
    expect(await opensUnder(storage, token, OLD)).toBe(true);
  });

  it('refuses a wrap that opens under neither pepper and leaves it unchanged', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    await serve(storage, OTHER, undefined, async (base) => {
      expect((await pairStart(base, token)).status).toBe(200);
    });
    const before = await storage.getAccountDekWrap(sha256hex(token));
    await serve(storage, OLD, NEW, async (base) => {
      expect((await pairStart(base, token)).status).toBe(409);
    });
    expect(await storage.getAccountDekWrap(sha256hex(token))).toBe(before);
  });

  it('refuses to boot with a malformed next pepper', () => {
    process.env.CONNECTOR_KEK_PEPPER = OLD;
    process.env.CONNECTOR_KEK_PEPPER_NEXT = 'too-short';
    expect(() => createConnectorServer(new InMemoryConnectorStorage())).toThrow(/CONNECTOR_KEK_PEPPER_NEXT is malformed/);
  });

  it('a reviewer code minted under the old pepper still connects, and re-seeding re-locks the account', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    const seeded = await seedReviewerAccount(storage, token, parseKekPepper(OLD)!);
    await serve(storage, OLD, NEW, async (base) => {
      const access = await connectWithCode(base, seeded.pairingCode);
      const projects = await mcpToolCall(base, access, 'project_list', {});
      expect(projects.text).toContain('lantern-gazette');
    });
    await seedReviewerAccount(storage, token, parseKekPepper(NEW)!, Date.now(), parseKekPepper(OLD)!);
    expect(await opensUnder(storage, token, NEW)).toBe(true);
  });

  it('an app token issued under the old pepper keeps working during the rotation', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    const seeded = await seedReviewerAccount(storage, token, parseKekPepper(OLD)!);
    // One listener; each phase swaps in an app built under different peppers.
    let handler: http.RequestListener = () => {};
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PUBLIC_URL = base;
    const phase = (current: string, next?: string): void => {
      process.env.CONNECTOR_KEK_PEPPER = current;
      if (next === undefined) delete process.env.CONNECTOR_KEK_PEPPER_NEXT;
      else process.env.CONNECTOR_KEK_PEPPER_NEXT = next;
      handler = createConnectorServer(storage);
    };
    try {
      phase(OLD);
      const access = await connectWithCode(base, seeded.pairingCode);
      phase(OLD, NEW);
      const during = await mcpToolCall(base, access, 'project_list', {});
      expect(during.isError).toBe(false);
      expect(during.text).toContain('lantern-gazette');
      phase(NEW);
      const after = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(after.status).toBe(401);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('a refresh token issued under the old pepper rotates into tokens that work on the new pepper alone', async () => {
    const storage = new InMemoryConnectorStorage();
    const token = crypto.randomBytes(24).toString('hex');
    const seeded = await seedReviewerAccount(storage, token, parseKekPepper(OLD)!);
    let handler: http.RequestListener = () => {};
    const server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PUBLIC_URL = base;
    const phase = (current: string, next?: string): void => {
      process.env.CONNECTOR_KEK_PEPPER = current;
      if (next === undefined) delete process.env.CONNECTOR_KEK_PEPPER_NEXT;
      else process.env.CONNECTOR_KEK_PEPPER_NEXT = next;
      handler = createConnectorServer(storage);
    };
    try {
      phase(OLD);
      const first = await connectWithCodeFull(base, seeded.pairingCode);
      phase(OLD, NEW);
      const refreshed = (await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: first.refresh, client_id: first.clientId, resource: `${base}/mcp`,
        }),
      }).then((r) => r.json())) as { access_token?: string };
      expect(refreshed.access_token).toBeTruthy();
      phase(NEW);
      const result = await mcpToolCall(base, refreshed.access_token!, 'project_list', {});
      expect(result.isError).toBe(false);
      expect(result.text).toContain('lantern-gazette');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function connectWithCode(base: string, pairingCode: string): Promise<string> {
  return (await connectWithCodeFull(base, pairingCode)).access;
}

async function connectWithCodeFull(base: string, pairingCode: string): Promise<{ access: string; refresh: string; clientId: string }> {
  const redirectUri = 'http://127.0.0.1:9999/callback';
  const resource = `${base}/mcp`;
  const as = (await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json())) as {
    registration_endpoint: string;
  };
  const reg = (await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'rotation-test',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const consent = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge,
      state: 'st', resource, pairing_code: pairingCode,
    }).toString(),
  });
  const code = new URL(consent.headers.get('location') ?? 'http://127.0.0.1/missing').searchParams.get('code');
  const tok = (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code ?? '', redirect_uri: redirectUri,
      client_id: reg.client_id, code_verifier: verifier, resource,
    }),
  }).then((r) => r.json())) as { access_token?: string; refresh_token?: string };
  if (!tok.access_token || !tok.refresh_token) throw new Error('token was not issued');
  return { access: tok.access_token, refresh: tok.refresh_token, clientId: reg.client_id };
}
