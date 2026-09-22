import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../src/projectsApi.js';
import { KDF_INTERACTIVE, ProjectHandoffError, Vault, deriveMasterKey, generateDeviceSecret, listProjectViews, withFileLock } from '@northkeep/core';
import { exportProjects, type VaultRunner } from '@northkeep/mcp-server';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const APP_WRITER = { host: 'northkeep-app', host_version: null, session_id: SESSION_ID };

describe('project API uncertain persistence', () => {
  it('does not return a receipt if saving fails, and does not save an exact replay again', async () => {
    const payload = Buffer.from(JSON.stringify({ vault_id: 'synthetic', operation_id: 'synthetic', expected_revision: 'synthetic', status: 'Ready', completed: 'Checked', next_actions: '' }));
    let saves = 0;
    const result = { replayed: false, receipt: { operation_id: 'synthetic' }, current: {} };
    const vault = { checkpointProject: () => result, save: () => { saves++; throw Object.assign(new Error('synthetic failure'), { code: 'EIO' }); } };
    const session = { isUnlocked: () => true, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
    const response = await handleProjectsApi(session, 'POST', '/api/projects/sample/checkpoint', payload);
    expect(response?.status).toBe(500); expect(response?.body).not.toHaveProperty('receipt'); expect(saves).toBe(1);
    result.replayed = true;
    expect((await handleProjectsApi(session, 'POST', '/api/projects/sample/checkpoint', payload))?.status).toBe(200);
    expect(saves).toBe(1);
  });
});

describe('project edit and delete routes (owner requests 2026-09-13)', () => {
  function sessionFor(vault: Record<string, unknown>) {
    return { isUnlocked: () => true, sessionId: SESSION_ID, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
  }
  it('updates title and summary through a revision-bound plain update and saves once', async () => {
    const calls: unknown[] = []; let saves = 0;
    const vault = { updateProject: (request: unknown) => { calls.push(request); return { project: 'sample', title: 'Sample', status: 'Fixed' }; }, save: () => { saves++; } };
    const body = Buffer.from(JSON.stringify({ expected_revision: '11111111-1111-4111-8111-111111111111', title: 'Sample', status: 'Fixed' }));
    const response = await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/update', body);
    expect(response?.status).toBe(200); expect(saves).toBe(1);
    expect(calls[0]).toEqual({ project: 'sample', expected_revision: '11111111-1111-4111-8111-111111111111', title: 'Sample', status: 'Fixed', writer: APP_WRITER });
  });
  it('refuses unknown fields, a missing revision, and non-string values without touching the vault', async () => {
    let touched = 0;
    const vault = { updateProject: () => { touched++; return {}; }, save: () => { touched++; } };
    for (const payload of [{ expected_revision: 'x', log_entry: 'nope' }, { title: 'No revision' }, { expected_revision: 'x', title: 5 }]) {
      const response = await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/update', Buffer.from(JSON.stringify(payload)));
      expect(response?.status).toBe(400);
    }
    expect(touched).toBe(0);
  });
  it('deletes a project and reports the count; a missing project is 404', async () => {
    let saves = 0;
    const vault = { deleteProject: (project: string) => { if (project === 'gone') throw new ProjectHandoffError('not_found', 'Project was not found.'); return 3; }, save: () => { saves++; } };
    const ok = await handleProjectsApi(sessionFor(vault), 'DELETE', '/api/projects/sample', Buffer.alloc(0));
    expect(ok?.status).toBe(200); expect(ok?.body).toEqual({ project: 'sample', forgotten: 3 }); expect(saves).toBe(1);
    const missing = await handleProjectsApi(sessionFor(vault), 'DELETE', '/api/projects/gone', Buffer.alloc(0));
    expect(missing?.status).toBe(404); expect(saves).toBe(1);
    expect((await handleProjectsApi(sessionFor(vault), 'DELETE', '/api/projects/sample/checkpoint', Buffer.alloc(0)))?.status).toBe(405);
  });
});

describe('project compaction route (ADR 0051)', () => {
  const result = { projects: [{ project: 'demo', candidates: 9, kept: 5, blanked: 4, bytes_freed: 4096 }], blanked: 4, bytes_freed: 4096 };
  function vaultFor(calls: unknown[], saves: { count: number }, vaultPath = '') {
    return { path: vaultPath, compactProjectHistory: (options: unknown) => { calls.push(options); return result; }, save: () => { saves.count++; } };
  }
  function sessionFor(vault: Record<string, unknown>, unlocked = true) {
    return { isUnlocked: () => unlocked, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
  }

  it('is 423 when the vault is locked, without touching it', async () => {
    const calls: unknown[] = []; const saves = { count: 0 };
    const response = await handleProjectsApi(sessionFor(vaultFor(calls, saves), false), 'POST', '/api/projects/compact', Buffer.from('{}'));
    expect(response?.status).toBe(423);
    expect(calls).toHaveLength(0); expect(saves.count).toBe(0);
  });

  it('previews by default and does not save', async () => {
    const calls: unknown[] = []; const saves = { count: 0 };
    const response = await handleProjectsApi(sessionFor(vaultFor(calls, saves)), 'POST', '/api/projects/compact', Buffer.from(JSON.stringify({ project: 'demo', keep: 5 })));
    expect(response?.status).toBe(200);
    expect(response?.body).toEqual(result);
    expect(calls[0]).toEqual({ project: 'demo', keep: 5, dryRun: true });
    expect(saves.count).toBe(0);
  });

  it('saves on a real run and reports the vault file size after', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-compact-'));
    const vaultPath = path.join(directory, 'vault.nkv');
    fs.writeFileSync(vaultPath, Buffer.alloc(2048));
    const calls: unknown[] = []; const saves = { count: 0 };
    const response = await handleProjectsApi(sessionFor(vaultFor(calls, saves, vaultPath)), 'POST', '/api/projects/compact', Buffer.from(JSON.stringify({ dry_run: false })));
    expect(response?.status).toBe(200);
    expect(response?.body).toEqual({ ...result, file_bytes_after: 2048 });
    expect(calls[0]).toEqual({ dryRun: false });
    expect(saves.count).toBe(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('refuses a bad keep, an unknown field and a non-POST without touching the vault', async () => {
    const calls: unknown[] = []; const saves = { count: 0 };
    const session = sessionFor(vaultFor(calls, saves));
    for (const payload of [{ keep: 0 }, { keep: 1001 }, { keep: '5' }, { project: 'Not A Slug' }, { surprise: true }, { dry_run: 'no' }]) {
      expect((await handleProjectsApi(session, 'POST', '/api/projects/compact', Buffer.from(JSON.stringify(payload))))?.status).toBe(400);
    }
    expect((await handleProjectsApi(session, 'GET', '/api/projects/compact', Buffer.alloc(0)))?.status).toBe(405);
    expect(calls).toHaveLength(0); expect(saves.count).toBe(0);
  });
});

describe('project writer attribution (ADR 0052 Decision 1)', () => {
  function sessionFor(vault: Record<string, unknown>) {
    return { isUnlocked: () => true, sessionId: SESSION_ID, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
  }

  it('sends this app as the writer with the session id on checkpoint, wrap and update', async () => {
    const calls: Record<string, unknown>[] = [];
    const vault = {
      checkpointProject: (request: Record<string, unknown>) => { calls.push(request); return { replayed: false, receipt: {}, current: {} }; },
      updateProject: (request: Record<string, unknown>) => { calls.push(request); return {}; },
      save: () => {},
    };
    const handoff = Buffer.from(JSON.stringify({ vault_id: 'v', operation_id: 'o', expected_revision: 'r', status: 'Ready', completed: 'Done', next_actions: '' }));
    expect((await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/checkpoint', handoff))?.status).toBe(200);
    expect((await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/wrap', handoff))?.status).toBe(200);
    const edit = Buffer.from(JSON.stringify({ expected_revision: 'r', status: 'Fixed' }));
    expect((await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/update', edit))?.status).toBe(200);
    expect(calls).toHaveLength(3);
    for (const request of calls) expect(request.writer).toEqual(APP_WRITER);
    expect(calls[0]!.mode).toBe('checkpoint');
    expect(calls[1]!.mode).toBe('wrap');
  });

  it('refuses a body that carries writer or draft on every write route, without touching the vault', async () => {
    let touched = 0;
    const vault = {
      checkpointProject: () => { touched++; return { replayed: false, receipt: {}, current: {} }; },
      updateProject: () => { touched++; return {}; },
      save: () => { touched++; },
    };
    const session = sessionFor(vault);
    const forged = [
      { vault_id: 'v', operation_id: 'o', expected_revision: 'r', status: 'S', completed: 'C', next_actions: '', writer: { host: 'claude-code', host_version: null, session_id: SESSION_ID } },
      { vault_id: 'v', operation_id: 'o', expected_revision: 'r', status: 'S', completed: 'C', next_actions: '', draft: true },
    ];
    for (const route of ['/api/projects/sample/checkpoint', '/api/projects/sample/wrap']) {
      for (const payload of forged) {
        const response = await handleProjectsApi(session, 'POST', route, Buffer.from(JSON.stringify(payload)));
        expect(response?.status).toBe(400);
        expect(response?.body).toMatchObject({ code: 'invalid_request' });
      }
    }
    for (const payload of [{ expected_revision: 'r', status: 'S', writer: { host: 'claude-code' } }, { expected_revision: 'r', draft: false }]) {
      const response = await handleProjectsApi(session, 'POST', '/api/projects/sample/update', Buffer.from(JSON.stringify(payload)));
      expect(response?.status).toBe(400);
      expect(response?.body).toMatchObject({ code: 'invalid_request' });
    }
    expect(touched).toBe(0);
  });
});

describe('project list mirror line (ADR 0053 Decision 7)', () => {
  const gitEnv = (home: string) => ({ PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig') });
  let root: string; let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.NORTHKEEP_HOME;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-mirror-')));
    process.env.NORTHKEEP_HOME = path.join(root, 'home');
    fs.mkdirSync(process.env.NORTHKEEP_HOME);
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME; else process.env.NORTHKEEP_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is null when no mirror is configured', async () => {
    const vault = { getVaultId: () => 'synthetic', list: () => [] };
    const session = { isUnlocked: () => true, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
    const response = await handleProjectsApi(session, 'GET', '/api/projects', Buffer.alloc(0));
    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({ vault_id: 'synthetic', projects: [], mirror: null });
  });

  it('carries the summary line once a mirror is configured, with no path in it', async () => {
    const home = process.env.NORTHKEEP_HOME!; const vaultPath = path.join(home, 'vault.nkv');
    const deviceSecret = generateDeviceSecret();
    Vault.create({ path: vaultPath, passphrase: 'adr 0053 web', deviceSecret, kdf: KDF_INTERACTIVE }).close();
    const header = Vault.readHeader(vaultPath);
    const key = deriveMasterKey('adr 0053 web', deviceSecret, header.salt, header.kdf);
    const runner: VaultRunner = (fn) => withFileLock(vaultPath, async () => {
      const v = Vault.openWithKey(vaultPath, Buffer.from(key));
      try { return await fn(v); } finally { v.close(); }
    });
    await runner((v) => { v.updateProject({ project: 'alpha', expected_revision: null, status: 'Starting.' }); v.save(); });
    const repo = path.join(root, 'mirror'); const gitHome = path.join(root, 'githome');
    fs.mkdirSync(repo); fs.mkdirSync(gitHome); fs.writeFileSync(path.join(gitHome, 'empty.gitconfig'), '');
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Tester'], ['config', 'user.email', 'tester@example.invalid']]) {
      execFileSync('/usr/bin/git', ['-C', repo, ...args], { env: gitEnv(gitHome), stdio: 'pipe' });
    }
    await exportProjects({ home, vaultPath, withVault: runner, by: 'cli', repo });
    await runner((v) => {
      v.updateProject({ project: 'alpha', expected_revision: listProjectViews(v)[0]!.revision!, status: 'Changed.' });
      v.save();
    });
    const session = { isUnlocked: () => true, withVault: runner } as never;
    const response = await handleProjectsApi(session, 'GET', '/api/projects', Buffer.alloc(0));
    const body = response?.body as { mirror: string };
    expect(response?.status).toBe(200);
    expect(body.mirror).toMatch(/^mirror last exported \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \([^)]*\); 1 project changed since$/);
    expect(body.mirror).not.toContain(root);
  });
});
