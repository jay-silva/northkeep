import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret, listProjectViews, withFileLock } from '@northkeep/core';
import { setGitSpawnObserver } from '../src/git-plumbing.js';
import { exportProjects, type VaultRunner } from '../src/project-export-run.js';
import { createServer } from '../src/server.js';
import { initRepo, makeLab, type Lab } from './git-fixture.js';

// ADR 0053 Decision 7: project_list and project_resume carry the mirror line.
const ENV = ['NORTHKEEP_HOME', 'NORTHKEEP_MASTER_KEY', 'NORTHKEEP_SCOPES', 'NORTHKEEP_NO_KEYCHAIN', 'NORTHKEEP_OLLAMA_URL'];
const LINE = /^mirror last exported \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \([^)]*\); \d+ projects? changed since$/;

let lab: Lab;
let saved: Record<string, string | undefined>;
let keyHex: string;
let client: Client | undefined;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  lab = makeLab('nk-mirror-status-');
  const deviceSecret = generateDeviceSecret();
  const passphrase = 'adr 0053 mirror status';
  Vault.create({ path: lab.vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(lab.vaultPath);
  keyHex = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf).toString('hex');
  process.env.NORTHKEEP_MASTER_KEY = keyHex;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  delete process.env.NORTHKEEP_SCOPES;
});

afterEach(async () => {
  setGitSpawnObserver(null);
  if (client) await client.close().catch(() => undefined);
  client = undefined;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  lab.cleanup();
});

const runner: VaultRunner = (fn) =>
  withFileLock(lab.vaultPath, async () => {
    const v = Vault.openWithKey(lab.vaultPath, Buffer.from(keyHex, 'hex'));
    try {
      return await fn(v);
    } finally {
      v.close();
    }
  });

function revision(v: Vault, slug: string): string {
  return listProjectViews(v).find((s) => s.project === slug)!.revision!;
}

async function seed(): Promise<void> {
  await runner((v) => {
    v.updateProject({ project: 'alpha', expected_revision: null, what_why: 'Alpha.', status: 'Starting.' });
    v.updateProject({ project: 'beta', expected_revision: null, what_why: 'Beta.', status: 'Starting.' });
    v.save();
  });
}

/** Configures a mirror in the temp home, then changes both projects after the export. */
async function exportThenChangeBoth(): Promise<number> {
  const repo = fs.realpathSync(initRepo(lab));
  let spawns = 0;
  setGitSpawnObserver(() => {
    spawns++;
  });
  await exportProjects({ home: lab.home, vaultPath: lab.vaultPath, withVault: runner, by: 'cli', repo });
  setGitSpawnObserver(null);
  await runner((v) => {
    v.updateProject({ project: 'alpha', expected_revision: revision(v, 'alpha'), status: 'Changed.' });
    v.updateProject({ project: 'beta', expected_revision: revision(v, 'beta'), status: 'Changed.' });
    v.save();
  });
  return spawns;
}

async function connect(): Promise<Client> {
  const server = createServer(lab.vaultPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'mirror-status-test', version: '1.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  client = mcp;
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await mcp.callTool({ name, arguments: args });
  expect(result.isError, name).toBeFalsy();
  return JSON.parse((result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')) as Record<string, unknown>;
}

describe('mirror_status on project_list and project_resume (ADR 0053 Decision 7)', () => {
  it('is absent from both when no mirror is configured', async () => {
    await seed();
    const mcp = await connect();
    expect(await call(mcp, 'project_list', {})).not.toHaveProperty('mirror_status');
    expect(await call(mcp, 'project_resume', { project: 'alpha' })).not.toHaveProperty('mirror_status');
  });

  it('carries the same line on both once a mirror is configured, with no path in it', async () => {
    await seed();
    await exportThenChangeBoth();
    const mcp = await connect();
    const listed = await call(mcp, 'project_list', {});
    const resumed = await call(mcp, 'project_resume', { project: 'alpha' });
    expect(listed.mirror_status).toMatch(LINE);
    expect(listed.mirror_status).toMatch(/; 2 projects changed since$/);
    expect(resumed.mirror_status).toBe(listed.mirror_status);
    expect(String(listed.mirror_status)).not.toContain(lab.root);
  });

  it('a resume never runs git, while the same counter sees the export that set the mirror up', async () => {
    await seed();
    expect(await exportThenChangeBoth()).toBeGreaterThan(0);
    const mcp = await connect();
    let spawns = 0;
    setGitSpawnObserver(() => {
      spawns++;
    });
    const resumed = await call(mcp, 'project_resume', { project: 'alpha' });
    const listed = await call(mcp, 'project_list', {});
    setGitSpawnObserver(null);
    // Present, so the zero is not a summary that failed and was dropped.
    expect(resumed.mirror_status).toMatch(LINE);
    expect(listed.mirror_status).toMatch(LINE);
    expect(spawns).toBe(0);
  });

  it('a narrow grant counts only the projects in its granted scopes', async () => {
    await seed();
    await exportThenChangeBoth();
    process.env.NORTHKEEP_SCOPES = 'project:alpha';
    const mcp = await connect();
    const listed = await call(mcp, 'project_list', {});
    const resumed = await call(mcp, 'project_resume', { project: 'alpha' });
    expect((listed.projects as unknown[]).length).toBe(1);
    expect(listed.mirror_status).toMatch(/; 1 project changed since$/);
    expect(resumed.mirror_status).toBe(listed.mirror_status);
    const denied = await mcp.callTool({ name: 'project_resume', arguments: { project: 'beta' } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).not.toContain('mirror');
  });
});
