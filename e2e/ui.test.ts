import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * GUI acceptance: drives the real UI server binary over HTTP the way the
 * page (and the Tauri shell) does — token auth, unlock, browse, forget,
 * import job, disclosure log, export.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const serverPath = path.join(repoRoot, 'apps', 'web', 'dist', 'server.js');
const PASSPHRASE = 'ui e2e passphrase';

let home: string;
let server: ChildProcess;
let baseUrl: string;
let token: string;

function cliAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
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
      (error, stdout, stderr) => (error ? reject(new Error(stderr || stdout)) : resolve(stdout)),
    );
  });
}

async function api(
  route: string,
  options: { method?: string; json?: unknown; body?: Buffer; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers: {
      'X-Northkeep-Token': options.token ?? token,
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body:
      options.json !== undefined
        ? JSON.stringify(options.json)
        : (options.body as BodyInit | undefined),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  expect(fs.existsSync(serverPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-ui-'));
  await cliAsync(['init']);
  await cliAsync(['remember', 'The user owns a rental in Dartmouth', '--type', 'semantic']);
  await cliAsync(['remember', 'The user prefers direct answers', '--type', 'procedural', '--scope', 'work']);

  // Server starts LOCKED: no passphrase env, no keychain.
  server = spawn(process.execPath, [serverPath], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NORTHKEEP_HOME: home,
      NORTHKEEP_NO_KEYCHAIN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readyLine: string = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`UI server never announced. ${buffer}`)), 20_000);
    server.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /NORTHKEEP_UI_URL=(\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    server.on('exit', (code) => reject(new Error(`server exited early (${code}) ${buffer}`)));
  });
  const url = new URL(readyLine);
  token = url.searchParams.get('token')!;
  baseUrl = `${url.protocol}//${url.host}`;
}, 60_000);

afterAll(() => {
  server?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('GUI server', () => {
  it('serves the page, but the API requires the session token', async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Northkeep');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");

    expect((await api('/api/status', { token: '' })).status).toBe(401);
    expect((await api('/api/status', { token: 'f'.repeat(64) })).status).toBe(401);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    // fetch() refuses to forge Host, so speak raw HTTP like an attacker would.
    const { request } = await import('node:http');
    const port = Number(new URL(baseUrl).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/status',
          headers: { host: 'evil.example.com', 'X-Northkeep-Token': token },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('starts locked; wrong passphrase fails; right passphrase unlocks', async () => {
    const before = await api('/api/status');
    expect(before.body.unlocked).toBe(false);
    expect((await api('/api/memories')).status).toBe(423);

    const wrong = await api('/api/unlock', { method: 'POST', json: { passphrase: 'nope nope nope' } });
    expect(wrong.status).toBe(401);

    const right = await api('/api/unlock', { method: 'POST', json: { passphrase: PASSPHRASE } });
    expect(right.status).toBe(200);
    const after = await api('/api/status');
    expect(after.body.unlocked).toBe(true);
    expect(after.body.total).toBe(2);
  });

  it('browses, searches, and forgets', async () => {
    const all = await api('/api/memories');
    expect((all.body.memories as unknown[]).length).toBe(2);

    const search = await api('/api/memories?q=rental+Dartmouth');
    const hits = search.body.memories as Array<{ id: string; content: string }>;
    expect(hits[0]!.content).toContain('Dartmouth');

    const scoped = await api('/api/memories?scope=work');
    expect((scoped.body.memories as unknown[]).length).toBe(1);

    const forget = await api('/api/forget', { method: 'POST', json: { id: hits[0]!.id } });
    expect(forget.status).toBe(200);
    const remaining = await api('/api/memories');
    expect((remaining.body.memories as unknown[]).length).toBe(1);
  });

  it('runs a paste import end-to-end: upload → candidates → commit', async () => {
    const pasteBody = Buffer.from(
      '- [identity] The user is a firefighter paramedic.\n- [semantic] The user has two kids.\n',
    );
    const upload = await api('/api/import/upload?source=paste&filename=mem.md', {
      method: 'POST',
      body: pasteBody,
    });
    expect(upload.status).toBe(200);
    const jobId = upload.body.job_id as string;

    const candidates = await api(`/api/import/${jobId}/candidates`);
    expect(candidates.status).toBe(200);
    expect((candidates.body.candidates as unknown[]).length).toBe(2);

    const commit = await api(`/api/import/${jobId}/commit`, {
      method: 'POST',
      json: { approved: [0, 1], scope: 'personal' },
    });
    expect(commit.body.imported).toBe(2);

    const after = await api('/api/memories?q=firefighter');
    expect((after.body.memories as unknown[]).length).toBe(1);

    // No upload temp file left behind.
    const leftovers = fs.readdirSync(home).filter((f) => f.startsWith('.upload-'));
    expect(leftovers).toEqual([]);
  });

  it('export matches the schema and the log endpoint answers', async () => {
    const exported = await api('/api/export');
    expect((exported.body.northkeep_export as { schema_version: string }).schema_version).toBe('0.2');
    const log = await api('/api/log');
    expect(Array.isArray(log.body.calls)).toBe(true);
  });

  it('lock revokes access until re-unlocked', async () => {
    await api('/api/lock', { method: 'POST', json: {} });
    expect((await api('/api/memories')).status).toBe(423);
    await api('/api/unlock', { method: 'POST', json: { passphrase: PASSPHRASE } });
    expect((await api('/api/memories')).status).toBe(200);
  });

  it('lock is honest and effective even when an env passphrase grants access', async () => {
    // A second server started WITH the env grant — the case the main server
    // (no passphrase env) can't exercise.
    const envServer = spawn(process.execPath, [serverPath], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NORTHKEEP_HOME: home,
        NORTHKEEP_NO_KEYCHAIN: '1',
        NORTHKEEP_PASSPHRASE: PASSPHRASE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const line: string = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no announce')), 15_000);
        envServer.stdout!.on('data', (c: Buffer) => {
          const m = /NORTHKEEP_UI_URL=(\S+)/.exec(c.toString('utf8'));
          if (m) { clearTimeout(t); resolve(m[1]!); }
        });
      });
      const u = new URL(line);
      const t = u.searchParams.get('token')!;
      const base = `${u.protocol}//${u.host}`;
      const call = async (route: string, method = 'GET') =>
        fetch(`${base}${route}`, { method, headers: { 'X-Northkeep-Token': t, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });

      // Env grant means it starts unlocked without a passphrase POST.
      expect((await (await call('/api/status')).json()).unlocked).toBe(true);
      // Lock is effective within the process (explicit-lock beats the ambient
      // env grant) AND honest about the env var that would re-open on restart.
      const lockBody = await (await call('/api/lock', 'POST')).json();
      expect(lockBody.envGrant).toBe(true);
      expect(lockBody.unlocked).toBe(false);
      // It actually takes effect: data is refused after lock.
      expect((await call('/api/memories')).status).toBe(423);
    } finally {
      envServer.kill();
    }
  });
});
