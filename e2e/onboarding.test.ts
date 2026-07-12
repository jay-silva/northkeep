import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M7d acceptance — first-run onboarding. The consumer path: the server starts
 * with NO vault on disk (the future DMG double-click), the page detects it via
 * /api/status.vault_exists, and POST /api/setup/create builds the device
 * secret + vault exactly like `northkeep init`, then unlocks the session.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(repoRoot, 'apps', 'web', 'dist', 'server.js');
const PASSPHRASE = 'onboarding e2e passphrase';

let home: string;
let server: ChildProcess;
let baseUrl: string;
let token: string;

async function api(
  route: string,
  options: { method?: string; json?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers: {
      'X-NorthKeep-Token': token,
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeAll(async () => {
  expect(fs.existsSync(serverPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-onboarding-'));
  // NO `northkeep init` here — the whole point is starting from nothing.

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

describe('first-run onboarding', () => {
  it('starts with no vault and says so: vault_exists false, locked', async () => {
    const status = await api('/api/status');
    expect(status.status).toBe(200);
    expect(status.body.vault_exists).toBe(false);
    expect(status.body.unlocked).toBe(false);
    // No vault file, no device secret on disk yet.
    expect(fs.existsSync(path.join(home, 'vault.nkv'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'device.secret'))).toBe(false);
  });

  it('rejects a short passphrase and a bad confirmation without creating anything', async () => {
    const short = await api('/api/setup/create', { method: 'POST', json: { passphrase: 'short' } });
    expect(short.status).toBe(400);
    const mismatch = await api('/api/setup/create', {
      method: 'POST',
      json: { passphrase: PASSPHRASE, confirm: 'something else!' },
    });
    expect(mismatch.status).toBe(400);
    expect(fs.existsSync(path.join(home, 'vault.nkv'))).toBe(false);
  });

  it('creates the vault + device secret and unlocks the session', async () => {
    const created = await api('/api/setup/create', {
      method: 'POST',
      json: { passphrase: PASSPHRASE, confirm: PASSPHRASE },
    });
    expect(created.status).toBe(200);
    expect(created.body.created).toBe(true);
    expect(created.body.unlocked).toBe(true);
    // The passphrase (and no key material) must never come back.
    expect(JSON.stringify(created.body)).not.toContain(PASSPHRASE);

    expect(fs.existsSync(path.join(home, 'vault.nkv'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'device.secret'))).toBe(true);

    const status = await api('/api/status');
    expect(status.body.vault_exists).toBe(true);
    expect(status.body.unlocked).toBe(true);

    // The session is genuinely unlocked: vault reads work without a further unlock.
    const memories = await api('/api/memories');
    expect(memories.status).toBe(200);
    expect(Array.isArray(memories.body.memories)).toBe(true);
  });

  it('refuses to create over an existing vault (409)', async () => {
    const again = await api('/api/setup/create', {
      method: 'POST',
      json: { passphrase: 'another passphrase entirely' },
    });
    expect(again.status).toBe(409);
    // And the original passphrase still opens it after a lock.
    await api('/api/lock', { method: 'POST', json: {} });
    expect((await api('/api/memories')).status).toBe(423);
    const unlock = await api('/api/unlock', { method: 'POST', json: { passphrase: PASSPHRASE } });
    expect(unlock.status).toBe(200);
    expect((await api('/api/memories')).status).toBe(200);
  });
});
