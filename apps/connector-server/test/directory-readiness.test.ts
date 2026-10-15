import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { CONNECTOR_TOOL_ANNOTATIONS } from '../src/mcp.js';
import { CANONICAL_CONNECTOR_ORIGIN, LEGACY_CONNECTOR_ORIGIN } from '../src/public-origin.js';
import { startPairing } from '@northkeep/sync';
import { connectAiApp, mcpToolCall } from './helpers.js';

const REDIRECT = 'http://127.0.0.1:9999/callback';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
}

function listen(app: ReturnType<typeof createConnectorServer>, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function getWithHost(port: number, urlPath: string, host: string, proto?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers: { Host: host, ...(proto ? { 'X-Forwarded-Proto': proto } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('directory readiness', () => {
  const storage = new InMemoryConnectorStorage();
  const deviceSecret = crypto.randomBytes(32);
  let server: Server;
  let base = '';
  let token = '';

  beforeAll(async () => {
    const port = await freePort();
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    base = process.env.PUBLIC_URL;
    server = await listen(createConnectorServer(storage), port);
    token = await connectAiApp(base, deviceSecret);
    expect(token).toBeTruthy();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('tools/list shows read-only, destructive, and write annotations on every tool', async () => {
    const resp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const raw = await resp.text();
    const line = raw.split('\n').find((item) => item.startsWith('data:'));
    const msg = JSON.parse((line ? line.slice(5) : raw).trim()) as { result?: { tools?: Array<{ name: string; annotations?: Record<string, boolean> }> } };
    const tools = msg.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(CONNECTOR_TOOL_ANNOTATIONS).sort());
    for (const tool of tools) {
      const expected = CONNECTOR_TOOL_ANNOTATIONS[tool.name as keyof typeof CONNECTOR_TOOL_ANNOTATIONS];
      expect(tool.annotations, tool.name).toEqual(expected);
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.fetch?.readOnlyHint).toBe(true);
    expect(byName.search?.readOnlyHint).toBe(true);
    expect(byName.memory_list?.readOnlyHint).toBe(true);
    expect(byName.memory_retrieve?.readOnlyHint).toBe(true);
    expect(byName.project_list?.readOnlyHint).toBe(true);
    expect(byName.project_get?.readOnlyHint).toBe(true);
    expect(byName.memory_forget?.destructiveHint).toBe(true);
    expect(byName.memory_forget?.readOnlyHint).toBe(false);
    for (const name of ['memory_remember', 'project_create', 'project_update'] as const) {
      expect(byName[name]?.readOnlyHint).toBe(false);
      expect(byName[name]?.destructiveHint).toBe(false);
    }
    expect(tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
  });

  it('returns a useful error for an unknown tool, a bad project slug, and a missing memory', async () => {
    const unknown = await mcpToolCall(base, token, 'not_a_tool', {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text.length).toBeGreaterThan(0);
    const slug = await mcpToolCall(base, token, 'project_get', { project: 'NOT A SLUG' });
    expect(slug.isError).toBe(true);
    expect(slug.text.length).toBeGreaterThan(0);
    const missing = await mcpToolCall(base, token, 'memory_forget', { id: 'does-not-exist' });
    expect(missing.text).toContain('No shared memory');
  });

  it('advertises the canonical host, keeps the configured host, and ignores a spoofed host', async () => {
    const port = Number(new URL(base).port);
    const canonical = await getWithHost(port, '/.well-known/oauth-authorization-server', 'mcp.northkeep.ai', 'https');
    const as = JSON.parse(canonical.body) as { issuer: string; client_id_metadata_document_supported?: boolean; registration_endpoint?: string; code_challenge_methods_supported?: string[] };
    expect(canonical.status).toBe(200);
    expect(as.issuer).toBe(`${CANONICAL_CONNECTOR_ORIGIN}/`);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${CANONICAL_CONNECTOR_ORIGIN}/register`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);

    const prm = JSON.parse((await getWithHost(port, '/.well-known/oauth-protected-resource/mcp', 'mcp.northkeep.ai', 'https')).body) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prm.resource).toBe(`${CANONICAL_CONNECTOR_ORIGIN}/mcp`);
    expect(prm.authorization_servers).toEqual([`${CANONICAL_CONNECTOR_ORIGIN}/`]);

    const legacy = JSON.parse((await getWithHost(port, '/.well-known/oauth-protected-resource', 'northkeep-connector-server.vercel.app', 'https')).body) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(legacy.resource).toBe(`${LEGACY_CONNECTOR_ORIGIN}/mcp`);
    expect(legacy.authorization_servers).toEqual([`${LEGACY_CONNECTOR_ORIGIN}/`]);

    const local = JSON.parse((await getWithHost(port, '/.well-known/oauth-authorization-server', `127.0.0.1:${port}`)).body) as { issuer: string };
    expect(local.issuer).toBe(`${base}/`);

    const spoofed = JSON.parse((await getWithHost(port, '/.well-known/oauth-authorization-server', 'evil.example', 'https')).body) as { issuer: string };
    expect(spoofed.issuer).toBe(`${base}/`);

    const challenge = await getWithHost(port, '/mcp', 'mcp.northkeep.ai', 'https');
    expect(challenge.status).toBe(401);
    expect(challenge.headers['www-authenticate']).toContain(`resource_metadata="${CANONICAL_CONNECTOR_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('accepts a token issued for the legacy resource and refuses a foreign resource', async () => {
    const legacyToken = await connectAiApp(base, deviceSecret, `${LEGACY_CONNECTOR_ORIGIN}/mcp`);
    const ok = await mcpToolCall(base, legacyToken, 'memory_list', {});
    expect(ok.isError).toBe(false);

    const as = (await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json())) as { registration_endpoint: string };
    const reg = (await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'foreign-resource',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }).then((r) => r.json())) as { client_id: string };
    const pairing = await startPairing({ server: base, deviceSecret: deviceSecret as never });
    const challenge = crypto.createHash('sha256').update('verifier-foreign').digest('base64url');
    const consent = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        state: 's',
        resource: 'https://evil.example/mcp',
        pairing_code: pairing,
      }).toString(),
    });
    const text = await consent.text();
    expect(text).toContain('unexpected resource');
  });

  it('lets a client id metadata document open the consent page, and refuses a loopback client id', async () => {
    const calls: string[] = [];
    const port = await freePort();
    const previous = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    const app = createConnectorServer(new InMemoryConnectorStorage(), {
      cimd: async (clientId) => {
        calls.push(clientId);
        if (clientId !== 'https://reviewer.example/oauth.json') return undefined;
        return {
          client_id: clientId,
          client_name: 'Directory Reviewer',
          redirect_uris: [REDIRECT],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
    });
    const srv = await listen(app, port);
    try {
      const url = new URL(`http://127.0.0.1:${port}/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: 'https://reviewer.example/oauth.json',
        redirect_uri: REDIRECT,
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        resource: `http://127.0.0.1:${port}/mcp`,
      }).toString();
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Directory Reviewer');
      expect(html).toContain('https://reviewer.example/oauth.json');
      expect(calls).toEqual(['https://reviewer.example/oauth.json']);

      const blocked = await fetch(`http://127.0.0.1:${port}/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: 'https://127.0.0.1/oauth.json',
        redirect_uri: REDIRECT,
        code_challenge: 'abc',
        code_challenge_method: 'S256',
      })}`);
      expect(blocked.status).toBe(400);
      const body = await blocked.json() as { error?: string };
      expect(body.error).toBe('invalid_client');
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previous;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('connector rate limit', () => {
  let server: Server;
  let base = '';
  const previousLimit = process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT;
  const previousPublic = process.env.PUBLIC_URL;

  beforeAll(async () => {
    const port = await freePort();
    process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT = '1';
    process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
    base = process.env.PUBLIC_URL;
    server = await listen(createConnectorServer(new InMemoryConnectorStorage()), port);
  });

  afterAll(async () => {
    if (previousLimit === undefined) delete process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT;
    else process.env.NORTHKEEP_CONNECTOR_RATE_LIMIT = previousLimit;
    if (previousPublic === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousPublic;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 429 with retry-after after the per-IP ceiling, and does not limit the health page', async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 5; i++) {
      const resp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      statuses.push(resp.status);
      if (resp.status === 429) retryAfter = resp.headers.get('retry-after');
    }
    expect(statuses.slice(0, 4).every((status) => status !== 429)).toBe(true);
    expect(statuses[4]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    const health = await fetch(base);
    expect(health.status).toBe(200);
  });
});

describe('public site pages', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'site');

  it('docs, security, and support are real pages with a contact address and an icon', () => {
    const docs = fs.readFileSync(path.join(root, 'docs.html'), 'utf8');
    const security = fs.readFileSync(path.join(root, 'security.html'), 'utf8');
    const support = fs.readFileSync(path.join(root, 'support.html'), 'utf8');
    expect(docs).toContain('mcp.northkeep.ai/mcp');
    expect(docs).toContain('memory_forget');
    expect(docs).toContain('unshare');
    expect(docs).not.toContain('—');
    expect(security).toContain('ciphertext');
    expect(security).toContain('support@northkeep.ai');
    expect(security).not.toContain('—');
    expect(support).toContain('mailto:support@northkeep.ai');
    expect(fs.existsSync(path.join(root, 'connector-icon.png'))).toBe(true);
    const redirects = fs.readFileSync(path.join(root, '_redirects'), 'utf8');
    expect(redirects).toContain('/docs');
    expect(redirects).toContain('/security');
  });
});

describe('reviewer seed script guards', () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-reviewer.mjs');
  const token = 'super-secret-reviewer-token-value';

  it('refuses to run without the explicit flag and never prints the token', () => {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, REVIEWER_CONNECTOR_TOKEN: token },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  });

  it('refuses a code file inside the repository', () => {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        NORTHKEEP_SEED_REVIEWER: '1',
        REVIEWER_CONNECTOR_TOKEN: token,
        CONNECTOR_KEK_PEPPER: Buffer.alloc(32, 1).toString('base64'),
        DATABASE_URL: 'postgres://example.invalid/northkeep',
        NORTHKEEP_REVIEWER_CODE_FILE: path.join(process.cwd(), 'reviewer-code.txt'),
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(fs.existsSync(path.join(process.cwd(), 'reviewer-code.txt'))).toBe(false);
  });
});
