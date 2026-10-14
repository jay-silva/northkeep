import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault, deriveMasterKey, loadDeviceSecret } from '@northkeep/core';

/**
 * ADR 0065 K1: the real server binary over stdio and the real CLI, on a temp
 * home. An AI app proposes and reports; only the user's typed yes confirms.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const PASSPHRASE = 'k1 milestones e2e passphrase';
const PLAN = 'M1 Define the buy box | test: buy box written and agreed\nM2 Shortlist 3 markets | test: 3 markets with comps';

let home: string;
let env: Record<string, string>;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* a plain-text refusal */ }
  return { isError: result.isError === true, text, json };
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [cliPath, ...args], { env: { ...env, NORTHKEEP_PASSPHRASE: PASSPHRASE }, input: 'yes\n', encoding: 'utf8' });
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-k1-'));
  process.env.NORTHKEEP_HOME = home;
  execFileSync(process.execPath, [cliPath, 'init'], { env: { ...process.env, NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE }, stdio: 'ignore' });
  const header = Vault.readHeader(path.join(home, 'vault.nkv'));
  const key = deriveMasterKey(PASSPHRASE, loadDeviceSecret(), header.salt, header.kdf).toString('hex');
  env = { PATH: process.env.PATH ?? '', NORTHKEEP_HOME: home, NORTHKEEP_NO_KEYCHAIN: '1', NORTHKEEP_OLLAMA_URL: 'http://127.0.0.1:9' };
  client = new Client({ name: 'northkeep-e2e-k1', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath, 'serve'], env: { ...env, NORTHKEEP_MASTER_KEY: key }, stderr: 'ignore' }));
}, 120_000);

afterAll(async () => {
  await client?.close();
  delete process.env.NORTHKEEP_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ADR 0065 K1: project milestones end to end', () => {
  let vaultId = '';
  let revision = '';

  it('tells the model the milestone rule in the handshake', () => {
    expect(client.getInstructions()).toBe('When the user asks to create a project, propose its milestones and create it only after the user agrees to them. Report a milestone passed only when the user says its acceptance test passed. Never mark a milestone passed on your own judgment.');
  });

  it('refuses a project without milestones, then creates one with the agreed plan', async () => {
    const missing = await call('project_create', { project: 'rental', what_why: 'A first rental.', status: 'Starting.' });
    expect(missing.isError).toBe(true);
    expect(missing.json.error.code).toBe('invalid_request');
    const created = await call('project_create', { project: 'rental', what_why: 'A first rental.', status: 'Starting.', milestones: PLAN });
    expect(created.isError, created.text).toBe(false);
    vaultId = created.json.vault_id;
    revision = created.json.revision;
  });

  it('lets the AI app report the current milestone passed, stamped (agent)', async () => {
    const saved = await call('project_checkpoint', { project: 'rental', vault_id: vaultId, expected_revision: revision, operation_id: randomUUID(), status: 'Buy box agreed.', completed: 'Wrote it.', next_actions: '- [x] Wrote the buy box', milestone_passed: 'M1' });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.json.current.milestones.items[0]).toMatchObject({ id: 'M1', state: 'passed', by: 'agent' });
    revision = saved.json.receipt.result_revision;
  });

  it('refuses every AI app route that would change or remove the pass', async () => {
    const doc = (await call('project_get', { project: 'rental' })).json as { id: string; content: string };
    const passedLine = doc.content.split('\n').find((line) => line.startsWith('- [x] M1'))!;
    expect((await call('memory_edit', { id: doc.id, content: doc.content.replace(`${passedLine}\n`, '') })).text).toBe('M1 has passed, so its line cannot be changed, moved out of Milestones or removed.');
    expect((await call('memory_edit', { id: doc.id, content: doc.content.replace('(agent)', '(you)') })).isError).toBe(true);
    expect((await call('memory_edit', { id: doc.id, type: 'semantic' })).text).toBe('This memory is a project document, so an AI app cannot change its type or move it. Change the project with project_update.');
    expect((await call('memory_forget', { id: doc.id })).text).toBe('This memory is a project document. An AI app cannot forget it; the user can delete the project in the NorthKeep app or with northkeep projects delete.');
    const update = await call('project_update', { project: 'rental', expected_revision: revision, milestones: 'M1 Something else | test: x' });
    expect(update.json.error.message).toBe('M1 has already passed. Passed milestones cannot be changed; send only the milestones still to do.');
    expect((await call('project_get', { project: 'rental' })).json.id).toBe(doc.id);
  });

  it('shows the plan in the CLI, and refuses to confirm without a terminal', () => {
    const shown = cli(['projects', 'milestones', 'rental']);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('Project rental: 1 of 2 milestones passed.');
    expect(shown.stdout).toContain('not confirmed by you');
    expect(shown.stdout).toContain('To confirm: northkeep projects pass rental M1');
    const pass = cli(['projects', 'pass', 'rental', 'M1']);
    expect(pass.status).toBe(1);
    expect(pass.stderr).toContain('This command asks you to type yes, so it runs only in a terminal you are typing in. Nothing was changed.');
    expect(cli(['projects', 'milestones', 'rental']).stdout).toContain('not confirmed by you');
  });
});
