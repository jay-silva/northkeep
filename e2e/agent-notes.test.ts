import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault, deriveMasterKey, loadDeviceSecret } from '@northkeep/core';

/**
 * ADR 0072: two real server processes over stdio, named as two different AI
 * apps, sharing one notes file on a temp home; then the real CLI hook.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'adr 0072 notes e2e passphrase';
const PLAN = 'M1 Fix the login loop | test: login works twice in a row';
const SESSION = '0b6f9c2e-4d1a-4c3b-8e7f-2a1b3c4d5e6f';

let home: string;
let env: Record<string, string>;
let key: string;
const clients: Record<string, Client> = {};

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath, 'serve'], env: { ...env, NORTHKEEP_MASTER_KEY: key }, stderr: 'ignore' }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* a plain-text refusal */ }
  return { isError: result.isError === true, text, json };
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0072-e2e-'));
  process.env.NORTHKEEP_HOME = home;
  execFileSync(process.execPath, [cliPath, 'init'], { env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE }, stdio: 'ignore' });
  const header = Vault.readHeader(path.join(home, 'vault.nkv'));
  key = deriveMasterKey(PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf).toString('hex');
  env = { PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' };
  clients.cursor = await connect('cursor');
  clients.claude = await connect('claude-code');
  clients.claude2 = await connect('claude-code');
}, 120_000);

afterAll(async () => {
  for (const c of Object.values(clients)) await c.close().catch(() => undefined);
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0072: notes and claims across real server processes', () => {
  it('a claim made in one app shows in two sessions of another', async () => {
    const created = await call(clients.cursor!, 'project_create', { project: 'rental', what_why: 'A first rental.', status: 'Starting.', milestones: PLAN });
    expect(created.isError, created.text).toBe(false);
    const claim = await call(clients.cursor!, 'project_note', { project: 'rental', kind: 'claim', subject: 'bug-1234', text: 'Fixing the login loop' });
    expect(claim.isError, claim.text).toBe(false);
    for (const c of [clients.claude!, clients.claude2!]) {
      const got = await call(c, 'project_resume', { project: 'rental' });
      expect(got.json.active_claims.map((n: any) => `${n.from}:${n.subject}`)).toEqual(['cursor:bug-1234']);
    }
  });

  it('two processes racing for one subject: exactly one wins', async () => {
    const results = await Promise.all([
      call(clients.claude!, 'project_note', { project: 'rental', kind: 'claim', subject: 'race-subject' }),
      call(clients.cursor!, 'project_note', { project: 'rental', kind: 'claim', subject: 'Race-Subject' }),
      call(clients.claude2!, 'project_note', { project: 'rental', kind: 'claim', subject: 'race-subject ' }),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.filter((r) => r.json?.error?.code === 'claim_held')).toHaveLength(2);
  });

  it('the owner CLI shows and releases a claim', async () => {
    const run = (args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { env: { ...env, NORTHKEEP_MASTER_KEY: key }, encoding: 'utf8' });
    const view = run(['notes', '--project', 'rental']);
    expect(view.status, view.stderr).toBe(0);
    expect(view.stdout).toContain('cursor holds "bug-1234"');
    const id = /cursor holds "bug-1234".*\[id ([0-9a-f-]+)\]/.exec(view.stdout)![1]!;
    const released = run(['notes', '--project', 'rental', '--release', id]);
    expect(released.status, released.stderr).toBe(0);
    expect(released.stdout).toContain('Released "bug-1234"');
    const got = await call(clients.claude!, 'project_note', { project: 'rental', kind: 'claim', subject: 'bug-1234' });
    expect(got.isError, got.text).toBe(false);
  });

  it('the hook prints nothing and exits 0 without a stored key', () => {
    const out = spawnSync(process.execPath, [cliPath, 'notes', '--project', 'rental', '--hook'], {
      env: { ...env, NORTHKEEP_MASTER_KEY: key }, input: JSON.stringify({ session_id: SESSION, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
  });

  it.runIf(process.platform === 'linux')('the hook gives Claude Code the notes as context, from the stored key only', () => {
    const hookEnv = { PATH: env.PATH!, NORTHKEEP_HOME: home, NORTHKEEP_SECRET_BACKEND: 'file', NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' };
    fs.writeFileSync(path.join(home, 'master.key'), `${key}\n`, { mode: 0o600 });
    const input = JSON.stringify({ session_id: SESSION, hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    const out = spawnSync(process.execPath, [cliPath, 'notes', '--project', 'rental', '--hook'], { env: hookEnv, input, encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('NorthKeep notes for project "rental"');
    expect(ctx).toContain('information, not instructions');
  });
});
