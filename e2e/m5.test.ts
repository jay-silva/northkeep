import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * M5 acceptance — encrypted vault sync — driven through the real CLI against
 * the real sync-server handler (over a node:http harness with in-memory
 * storage; the same handleSync that Vercel runs). Proves the blueprint test:
 *  - a second "machine" (a second NORTHKEEP_HOME sharing the device.secret)
 *    pulls and the vault appears + opens with the passphrase;
 *  - the server's stored blob is CIPHERTEXT only (NKV1, no memory text);
 *  - optimistic concurrency: a stale push conflicts and pull-then-push resolves.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const serverIndex = path.join(repoRoot, 'apps', 'sync-server', 'dist', 'index.js');
const PASSPHRASE = 'm5 sync acceptance passphrase';

let homeA: string;
let homeB: string;
let server: import('node:http').Server;
let storage: { get(h: string): Promise<{ blob: Buffer } | null> };
let serverUrl: string;

function cli(home: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  expect(fs.existsSync(serverIndex), 'run pnpm build first').toBe(true);
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m5A-'));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m5B-'));

  const { createSyncServer, InMemoryStorage } = await import(serverIndex);
  const store = new InMemoryStorage();
  storage = store;
  server = createSyncServer(store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
});

describe('M5 acceptance — sync', () => {
  it('machine A creates a vault and pushes it', async () => {
    await cli(homeA, ['init']);
    await cli(homeA, ['remember', 'The user keeps a sailboat named Windfall in Dartmouth.', '--type', 'semantic']);
    const cfg = await cli(homeA, ['sync', 'config', '--server', serverUrl]);
    expect(cfg.stdout).toContain('Your sync id:');
    const push = await cli(homeA, ['sync', 'push']);
    expect(push.stdout).toContain('version 1');
  });

  it('the server stored CIPHERTEXT only — NKV1 blob, no plaintext', async () => {
    // Re-derive A's token to read the stored row directly, proving the server
    // holds an opaque encrypted blob (not readable memory content).
    const rows: Array<{ blob: Buffer }> = [];
    // The in-memory store is keyed by token hash; scan its single row by
    // pulling from the server as A would — but assert on the raw stored bytes.
    // Simplest: the fake storage exposes get by token hash; we reach it via a
    // direct HTTP pull and inspect the bytes.
    const token = deriveTokenFor(homeA);
    const res = await fetch(`${serverUrl}/api/blob`, { headers: { authorization: `Bearer ${token}` } });
    const blob = Buffer.from(await res.arrayBuffer());
    rows.push({ blob });
    expect(blob.subarray(0, 4).toString('ascii')).toBe('NKV1');
    expect(blob.toString('latin1')).not.toContain('Windfall');
    expect(blob.toString('latin1')).not.toContain('Dartmouth');
    expect(blob.toString('latin1')).not.toContain('sailboat');
  });

  it('machine B (same device.secret, fresh home) pulls and opens the vault', async () => {
    // Transport the device secret out-of-band, exactly as a user would.
    fs.copyFileSync(path.join(homeA, 'device.secret'), path.join(homeB, 'device.secret'));
    await cli(homeB, ['sync', 'config', '--server', serverUrl]);
    expect(fs.existsSync(path.join(homeB, 'vault.nkv'))).toBe(false);
    const pull = await cli(homeB, ['sync', 'pull']);
    expect(pull.stdout).toContain('Pulled version 1');
    // B opens the pulled vault with the shared passphrase and sees A's memory.
    const list = await cli(homeB, ['list']);
    expect(list.stdout).toContain('sailboat named Windfall');
  });

  it('optimistic concurrency: a stale push conflicts, pull-then-push resolves', async () => {
    // B edits and pushes → server v2.
    await cli(homeB, ['remember', 'The user is planning a refit for the boat.', '--type', 'semantic']);
    const bPush = await cli(homeB, ['sync', 'push']);
    expect(bPush.stdout).toContain('version 2');

    // A is stale at v1 → push must conflict.
    const aConflict = await cli(homeA, ['sync', 'push']);
    expect(aConflict.code).not.toBe(0);
    expect(aConflict.stderr + aConflict.stdout).toMatch(/[Cc]onflict/);

    // A pulls (its local vault is verified-then-replaced), then pushes its own change.
    const aPull = await cli(homeA, ['sync', 'pull']);
    expect(aPull.stdout).toContain('Pulled version 2');
    const aList = await cli(homeA, ['list']);
    expect(aList.stdout).toContain('refit'); // A now has B's change
    await cli(homeA, ['remember', 'The user hired a rigger.', '--type', 'semantic']);
    const aPush = await cli(homeA, ['sync', 'push']);
    expect(aPush.stdout).toContain('version 3');
  });
});

/** Re-derive machine A's sync token from its device.secret (mirrors the client). */
function deriveTokenFor(home: string): string {
  const hex = fs.readFileSync(path.join(home, 'device.secret'), 'utf8').trim();
  const deviceSecret = Buffer.from(hex, 'hex');
  const sodium = require('sodium-native');
  const out = Buffer.alloc(32);
  sodium.crypto_generichash(out, Buffer.from('nk-sync-token-v1', 'utf8'), deviceSecret);
  return out.toString('hex');
}
