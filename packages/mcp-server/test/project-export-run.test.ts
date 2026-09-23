import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  KDF_INTERACTIVE,
  Vault,
  deriveMasterKey,
  generateDeviceSecret,
  listProjectViews,
  withFileLock,
} from '@northkeep/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportRefusal, readRemotes, setGitSpawnObserver } from '../src/git-plumbing.js';
import {
  classifyTarget,
  exportProjects,
  importProjects,
  installSchedule,
  readExportSettings,
  readExportState,
  readMirrorSummary,
  removeSchedule,
  schedulePlistPath,
  verifyMirror,
  type ExportRunResult,
  type VaultRunner,
  type VerifyResult,
} from '../src/project-export-run.js';
import { ctxFor, fx, initRepo, makeLab, type Lab } from './git-fixture.js';

const MCP_DIR = path.resolve(__dirname, '..');
const RUN_DIST = path.join(MCP_DIR, 'dist', 'project-export-run.js');
const CODE = { host: 'claude-code', session_id: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e' };

let lab: Lab;
let prevHome: string | undefined;
let keyHex: string;
let repo: string;

beforeEach(() => {
  prevHome = process.env.NORTHKEEP_HOME;
  lab = makeLab('nk-export-');
  const deviceSecret = generateDeviceSecret();
  const passphrase = 'adr 0053 export test';
  Vault.create({ path: lab.vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(lab.vaultPath);
  keyHex = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf).toString('hex');
  repo = fs.realpathSync(initRepo(lab));
});

afterEach(() => {
  setGitSpawnObserver(null);
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
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

async function write(fn: (v: Vault) => void): Promise<void> {
  await runner((v) => {
    fn(v);
    v.save();
  });
}

function revision(v: Vault, slug: string): string {
  return listProjectViews(v).find((s) => s.project === slug)!.revision!;
}

async function seed(): Promise<void> {
  await write((v) => {
    let cur = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: 'Starting.', log_entry: 'Created.', writer: CODE });
    for (let i = 0; i < 12; i++) cur = v.updateProject({ project: 'demo', expected_revision: cur.revision, log_entry: `Entry ${i} ${'z'.repeat(1500)}`, writer: CODE });
    v.updateProject({ project: 'other', expected_revision: null, what_why: 'Other.', status: 'Fine.' });
  });
}

function exportOnce(extra: { repo?: string; by?: 'cli' | 'schedule' } = {}): Promise<ExportRunResult> {
  return exportProjects({ home: lab.home, vaultPath: lab.vaultPath, withVault: runner, by: extra.by ?? 'cli', repo: extra.repo });
}

/** Every file under a directory: path, type, mode, size, mtime and content hash. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isDirectory()) {
        out.push(`d ${rel} ${st.mode} ${st.mtimeMs}`);
        walk(p);
      } else {
        const h = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : fs.readlinkSync(p);
        out.push(`f ${rel} ${st.mode} ${st.size} ${st.mtimeMs} ${h}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

/** Opens the vault without the vault file lock, so the snapshot below can include the home folder's own mtime. */
const lockFreeRunner: VaultRunner = async (fn) => {
  const v = Vault.openWithKey(lab.vaultPath, Buffer.from(keyHex, 'hex'));
  try {
    return await fn(v);
  } finally {
    v.close();
  }
};

function withRoot(dir: string): string {
  const st = fs.lstatSync(dir);
  return `root ${st.mode} ${st.mtimeMs}\n${snapshot(dir)}`;
}

/** verifyMirror itself, asserting it changed nothing in the repository, its git dir or the NorthKeep home. */
async function verifyReadOnly(): Promise<VerifyResult> {
  const before = withRoot(repo) + withRoot(lab.home);
  const verbs: string[][] = [];
  setGitSpawnObserver((_v, a) => verbs.push([...a]));
  const res = await verifyMirror({ home: lab.home, vaultPath: lab.vaultPath, withVault: lockFreeRunner });
  setGitSpawnObserver(null);
  expect(withRoot(repo) + withRoot(lab.home)).toBe(before);
  for (const a of verbs) {
    expect(['rev-parse', 'hash-object', 'ls-tree']).toContain(a[0]);
    expect(a).not.toContain('-w');
  }
  return res;
}

function statusOf(res: VerifyResult): Record<string, string> {
  return Object.fromEntries(res.entries.map((e) => [e.path, e.status]));
}

function commits(): number {
  return Number(fx(lab, repo, ['rev-list', '--count', 'HEAD']));
}

describe('exportProjects end to end', () => {
  it('first export into an empty git init folder: marker, INDEX, projects, one commit, settings, clean status', async () => {
    await seed();
    const res = await exportOnce({ repo });
    expect(res.status).toBe('committed');
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.northkeep-mirror', 'INDEX.md', 'projects']);
    expect(fs.readdirSync(path.join(repo, 'projects')).sort()).toEqual(['demo.log.1.md', 'demo.md', 'other.md']);
    expect(commits()).toBe(1);
    expect(fx(lab, repo, ['log', '-1', '--format=%s'])).toBe('export: 2 projects (northkeep-cli)');
    expect(fx(lab, repo, ['log', '-1', '--format=%b'])).toContain('demo (claude-code, model not exposed)');
    expect(fx(lab, repo, ['status', '--short'])).toBe('');
    expect(readExportSettings(lab.home)).toEqual({ repo });
    const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
    expect(state?.nk_commits).toEqual([res.commit]);
    expect(Object.keys(state!.projects).sort()).toEqual(['demo', 'other']);
    expect(fs.statSync(path.join(repo, 'projects', 'demo.md')).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(repo, 'projects', 'demo.md'), 'utf8')).toMatch(/^<!-- northkeep: vault \S+ project demo revision/);
    const v = await verifyReadOnly();
    expect(v.ok).toBe(true);
    expect(new Set(Object.values(statusOf(v)))).toEqual(new Set(['matches']));
  });

  it('refuses a first export into a non-empty folder and an unconfigured run', async () => {
    await seed();
    await expect(exportOnce()).rejects.toMatchObject({ code: 'not_configured' });
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'mine\n');
    await expect(exportOnce({ repo })).rejects.toMatchObject({ code: 'not_owned' });
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', 'notes.txt']);
    expect(readExportSettings(lab.home)).toBeNull();
  });

  it('a second export of an unchanged vault is byte-identical and makes no commit', async () => {
    await seed();
    await exportOnce({ repo });
    const before = snapshot(path.join(repo, 'projects')) + fs.readFileSync(path.join(repo, 'INDEX.md'), 'hex');
    const res = await exportOnce();
    expect(res.status).toBe('unchanged');
    expect(res.written).toEqual([]);
    expect(snapshot(path.join(repo, 'projects')) + fs.readFileSync(path.join(repo, 'INDEX.md'), 'hex')).toBe(before);
    expect(commits()).toBe(1);
    expect(fx(lab, repo, ['status', '--short'])).toBe('');
  });

  it('a vault update makes exactly one commit touching only that project and the INDEX', async () => {
    await seed();
    await exportOnce({ repo });
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Moved on.', writer: CODE }));
    expect((await verifyReadOnly()).entries).toContainEqual({ path: 'projects/other.md', status: 'stale' });
    const res = await exportOnce();
    expect(res.status).toBe('committed');
    expect(commits()).toBe(2);
    expect(fx(lab, repo, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').sort()).toEqual(['INDEX.md', 'projects/other.md']);
    expect(fx(lab, repo, ['log', '-1', '--format=%B']).trimEnd()).toBe('export: 1 project (northkeep-cli)\n\nother (claude-code, model not exposed)');
    expect((await verifyReadOnly()).ok).toBe(true);
  });

  it('a hand edit is refused by name and kept, while other projects still export', async () => {
    await seed();
    await exportOnce({ repo });
    const demo = path.join(repo, 'projects', 'demo.md');
    fs.appendFileSync(demo, 'note\n');
    const edited = fs.readFileSync(demo, 'utf8');
    const v1 = await verifyReadOnly();
    expect(statusOf(v1)['projects/demo.md']).toBe('hand edit');
    expect(v1.ok).toBe(false);
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Still going.' }));
    const res = await exportOnce();
    expect(res.refused).toContainEqual({ path: 'projects/demo.md', reason: 'hand edit' });
    expect(res.written).toContain('projects/other.md');
    expect(fs.readFileSync(demo, 'utf8')).toBe(edited);
    expect(fx(lab, repo, ['diff', '--name-only', 'HEAD~1', 'HEAD'])).not.toContain('projects/demo.md');
    const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
    expect(state?.refused).toContainEqual({ path: 'projects/demo.md', reason: 'hand edit' });
    // Restoring the committed bytes makes the file NorthKeep's again.
    fx(lab, repo, ['checkout', '--', 'projects/demo.md']);
    expect((await exportOnce()).refused).toEqual([]);
    expect((await verifyReadOnly()).ok).toBe(true);
  });

  it('a project deleted from the vault has its files removed in the same commit', async () => {
    await seed();
    await exportOnce({ repo });
    await write((v) => {
      v.deleteProject('demo');
    });
    const v1 = await verifyReadOnly();
    expect(statusOf(v1)['projects/demo.md']).toBe('extra');
    expect(statusOf(v1)['projects/demo.log.1.md']).toBe('extra');
    const res = await exportOnce();
    expect(res.removed.sort()).toEqual(['projects/demo.log.1.md', 'projects/demo.md']);
    expect(fs.readdirSync(path.join(repo, 'projects'))).toEqual(['other.md']);
    expect(fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'projects'])).toBe('projects/other.md');
    expect(fx(lab, repo, ['log', '-1', '--format=%B'])).toContain('removed projects/demo.md');
    expect(commits()).toBe(2);
    const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
    expect(Object.keys(state!.projects)).toEqual(['other']);
    expect((await verifyReadOnly()).ok).toBe(true);
  });

  it('never removes a hand-written file for a deleted project', async () => {
    await seed();
    await exportOnce({ repo });
    fs.writeFileSync(path.join(repo, 'projects', 'demo.md'), '# my own notes\n');
    await write((v) => {
      v.deleteProject('demo');
    });
    const res = await exportOnce();
    expect(res.refused).toContainEqual({ path: 'projects/demo.md', reason: 'hand edit' });
    expect(fs.readFileSync(path.join(repo, 'projects', 'demo.md'), 'utf8')).toBe('# my own notes\n');
  });

  it('verify reports missing, extra, uncommitted export and render failed; a bad document fails alone', async () => {
    await seed();
    await exportOnce({ repo });
    fs.rmSync(path.join(repo, 'projects', 'other.md'));
    fs.writeFileSync(path.join(repo, 'projects', 'zzz.md'), 'stray\n');
    let s = statusOf(await verifyReadOnly());
    expect(s['projects/other.md']).toBe('missing');
    expect(s['projects/zzz.md']).toBe('extra');
    fs.rmSync(path.join(repo, 'projects', 'zzz.md'));
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Second.' }));
    await exportOnce();
    fx(lab, repo, ['reset', '-q', '--soft', 'HEAD~1']);
    s = statusOf(await verifyReadOnly());
    expect(s['projects/other.md']).toBe('uncommitted export');
    await exportOnce();

    await write((v) => {
      v.remember({ type: 'working', scope: 'project:broken', content: '## Current Status\n\nOne.\n\n## Current Status\n\nTwo.' });
      v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Broken neighbour.' });
    });
    const res = await exportOnce();
    expect(res.refused).toContainEqual({ path: 'projects/broken.md', reason: 'render failed' });
    expect(res.written).toContain('projects/other.md');
    expect(fs.existsSync(path.join(repo, 'projects', 'broken.md'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'INDEX.md'), 'utf8')).toContain('| broken | active | render failed; not exported |');
    const v = await verifyReadOnly();
    expect(statusOf(v)['projects/broken.md']).toBe('render failed');
    expect(v.ok).toBe(false);
    expect(v.entries.filter((e) => e.status !== 'render failed').every((e) => e.status === 'matches')).toBe(true);
  });

  it('verify creates and chmods nothing under NORTHKEEP_HOME when its git files are missing or loosened (a1)', async () => {
    await seed();
    await exportOnce({ repo });
    fs.chmodSync(path.join(lab.home, 'export'), 0o755);
    fs.rmSync(path.join(lab.home, 'hooks'), { recursive: true });
    fs.rmSync(path.join(lab.home, 'empty.gitconfig'));
    const res = await verifyReadOnly();
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(lab.home, 'hooks'))).toBe(false);
    expect(fs.statSync(path.join(lab.home, 'export')).mode & 0o777).toBe(0o755);
  });

  it('verify reports a HEAD-only project file as missing on disk and a mode change as a hand edit (a9)', async () => {
    await seed();
    await exportOnce({ repo });
    fs.writeFileSync(path.join(repo, 'projects', 'zzz.md'), 'user file\n');
    fx(lab, repo, ['add', 'projects/zzz.md']);
    fx(lab, repo, ['commit', '-q', '-m', 'zzz']);
    fs.rmSync(path.join(repo, 'projects', 'zzz.md'));
    const v1 = await verifyReadOnly();
    expect(statusOf(v1)['projects/zzz.md']).toBe('missing on disk');
    expect(v1.ok).toBe(false);
    fx(lab, repo, ['rm', '-q', '--cached', 'projects/zzz.md']);
    fx(lab, repo, ['commit', '-q', '-m', 'rm zzz']);
    expect((await verifyReadOnly()).ok).toBe(true);
    fs.chmodSync(path.join(repo, 'projects', 'demo.md'), 0o755);
    const v2 = await verifyReadOnly();
    expect(statusOf(v2)['projects/demo.md']).toBe('hand edit');
    expect(v2.ok).toBe(false);
  });

  it('an unreadable mirror file refuses only that target; a scheduled run records a partial run, not an error (a2)', async () => {
    await seed();
    await exportOnce({ repo });
    const demo = path.join(repo, 'projects', 'demo.md');
    fs.chmodSync(demo, 0o000);
    try {
      await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Past the bad file.' }));
      const res = await exportProjects({ home: lab.home, vaultPath: lab.vaultPath, withVault: runner, by: 'schedule' });
      expect(res.refused).toContainEqual({ path: 'projects/demo.md', reason: 'unreadable' });
      expect(res.written).toContain('projects/other.md');
      expect(res.status).toBe('committed');
      expect(JSON.stringify(res.refused)).not.toContain(lab.root);
      const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
      expect(state?.last_failure).toBeNull();
      expect(state?.last_success?.commit).toBe(res.commit);
      expect(state?.last_attempt?.by).toBe('schedule');
      expect(state?.refused).toContainEqual({ path: 'projects/demo.md', reason: 'unreadable' });
    } finally {
      fs.chmodSync(demo, 0o644);
    }
  });

  it('a scheduled run where every project is refused records nothing_exported, not a success alone (a2)', async () => {
    await seed();
    await exportOnce({ repo });
    const files = ['demo.md', 'demo.log.1.md', 'other.md'].map((n) => path.join(repo, 'projects', n));
    for (const f of files) fs.chmodSync(f, 0o000);
    try {
      const res = await exportProjects({ home: lab.home, vaultPath: lab.vaultPath, withVault: runner, by: 'schedule' });
      expect(res.refused.map((r) => r.reason)).toEqual(['unreadable', 'unreadable', 'unreadable']);
      const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
      expect(state?.last_failure?.code).toBe('nothing_exported');
    } finally {
      for (const f of files) fs.chmodSync(f, 0o644);
    }
  });

  it('a run that cannot open its vault records nothing in another vault state file (a3)', async () => {
    await seed();
    await exportOnce({ repo });
    const exp = path.join(lab.home, 'export');
    const file = path.join(exp, fs.readdirSync(exp).find((n) => n.endsWith('.state.json'))!);
    const before = fs.readFileSync(file, 'utf8');
    const locked: VaultRunner = () => Promise.reject(new ExportRefusal('vault_locked', 'The vault is locked'));
    const absent = path.join(lab.root, 'absent.nkv');
    await expect(exportProjects({ home: lab.home, vaultPath: absent, withVault: locked, by: 'schedule' })).rejects.toBeInstanceOf(ExportRefusal);
    const otherPath = path.join(lab.root, 'other.nkv');
    Vault.create({ path: otherPath, passphrase: 'second vault', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE }).close();
    await expect(exportProjects({ home: lab.home, vaultPath: otherPath, withVault: locked, by: 'schedule' })).rejects.toBeInstanceOf(ExportRefusal);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a symlinked projects folder without writing or listing through it', async () => {
    await seed();
    await exportOnce({ repo });
    const outside = path.join(lab.root, 'outside');
    fs.mkdirSync(outside);
    fs.renameSync(path.join(repo, 'projects'), path.join(lab.root, 'moved'));
    fs.symlinkSync(outside, path.join(repo, 'projects'));
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Now.' }));
    const res = await exportOnce();
    expect(res.refused.map((r) => r.path)).toEqual(expect.arrayContaining(['projects/demo.md', 'projects/other.md']));
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(statusOf(await verifyReadOnly())['projects/other.md']).toBe('hand edit');
  });

  it('records a scheduled run that finds the vault locked, and the summary shows it', async () => {
    await seed();
    await exportOnce({ repo });
    const locked: VaultRunner = () => Promise.reject(new ExportRefusal('vault_locked', 'The vault is locked'));
    await expect(
      exportProjects({ home: lab.home, vaultPath: lab.vaultPath, withVault: locked, by: 'schedule', now: () => new Date(Date.now() + 60_000) }),
    ).rejects.toMatchObject({ code: 'vault_locked' });
    const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
    expect(state?.last_failure?.code).toBe('vault_locked');
    expect(state?.last_attempt?.by).toBe('schedule');
    const line = await runner((v) => readMirrorSummary(v, undefined, lab.home, new Date(Date.now() + 120_000)));
    expect(line).toMatch(/^mirror last exported .*; 0 projects changed since; last export failed /);
  });

  it('a refused run from another vault leaves the mirror owner state file intact', async () => {
    await seed();
    await exportOnce({ repo });
    const before = fs.readFileSync(path.join(lab.home, 'export', fs.readdirSync(path.join(lab.home, 'export')).find((n) => n.endsWith('.state.json'))!), 'utf8');
    const otherPath = path.join(lab.root, 'other.nkv');
    const otherSecret = generateDeviceSecret();
    Vault.create({ path: otherPath, passphrase: 'second vault', deviceSecret: otherSecret, kdf: KDF_INTERACTIVE }).close();
    const h = Vault.readHeader(otherPath);
    const otherKey = deriveMasterKey('second vault', otherSecret, h.salt, h.kdf);
    const otherRunner: VaultRunner = (fn) =>
      withFileLock(otherPath, async () => {
        const v = Vault.openWithKey(otherPath, Buffer.from(otherKey));
        try { return await fn(v); } finally { v.close(); }
      });
    await expect(exportProjects({ home: lab.home, vaultPath: otherPath, withVault: otherRunner, by: 'cli' })).rejects.toBeInstanceOf(ExportRefusal);
    const statePath = path.join(lab.home, 'export', fs.readdirSync(path.join(lab.home, 'export')).find((n) => n.endsWith('.state.json'))!);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
    const state = await runner((v) => readExportState(lab.home, repo, v.getVaultId()));
    expect(state?.last_success).not.toBeNull();
    expect(state?.nk_commits.length).toBeGreaterThan(0);
  });

  it('commits with a remote configured and pushes nothing', async () => {
    await seed();
    const bare = path.join(lab.root, 'bare.git');
    fx(lab, lab.root, ['init', '-q', '--bare', bare]);
    await exportOnce({ repo });
    fx(lab, repo, ['remote', 'add', 'origin', bare]);
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Again.' }));
    const verbs = new Set<string>();
    setGitSpawnObserver((v) => verbs.add(v));
    expect((await exportOnce()).status).toBe('committed');
    setGitSpawnObserver(null);
    expect([...verbs].every((v) => !['push', 'fetch', 'ls-remote'].includes(v))).toBe(true);
    expect(fx(lab, bare, ['rev-list', '--all'])).toBe('');
    expect(await readRemotes(ctxFor(lab, repo))).toEqual([{ name: 'origin', url: bare }]);
  });
});

/** A second process running exportProjects from dist with the default runner; resolves with its one output line. */
function childExport(opts: { lockWaitMs?: number } = {}): Promise<string> {
  const script = `import { nodePlatform } from '@northkeep/platform-node';
import { setPlatform } from '@northkeep/core';
setPlatform(nodePlatform());
const { exportProjects } = await import(${JSON.stringify(RUN_DIST)});
try {
  const r = await exportProjects({ home: ${JSON.stringify(lab.home)}, vaultPath: ${JSON.stringify(lab.vaultPath)}, by: 'cli', lockWaitMs: ${opts.lockWaitMs ?? 20_000} });
  console.log(JSON.stringify({ status: r.status }));
} catch (e) { console.log(JSON.stringify({ refused: e.code ?? 'error' })); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: MCP_DIR,
      env: { PATH: '/usr/bin:/bin', NORTHKEEP_HOME: lab.home, NORTHKEEP_MASTER_KEY: keyHex, NORTHKEEP_NO_KEYCHAIN: '1' },
    });
    let o = '';
    c.stdout.on('data', (d: Buffer) => (o += d.toString()));
    c.on('close', () => resolve(o.trim()));
  });
}

function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}

/** Every commit after `since` keeps notes.txt and is never an empty tree. */
function assertHistoryKeeps(since: string): void {
  const ids = fx(lab, repo, ['rev-list', `${since}..HEAD`]).split('\n').filter(Boolean);
  for (const c of ids) {
    const names = fx(lab, repo, ['ls-tree', '-r', '--name-only', c]).split('\n');
    expect(names, `commit ${c}`).toContain('notes.txt');
    expect(names, `commit ${c}`).toContain('.northkeep-mirror');
  }
  expect(fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).toContain('notes.txt');
}

describe('concurrent exports', () => {
  async function seedWithUserFile(): Promise<string> {
    expect(fs.existsSync(RUN_DIST), 'build @northkeep/mcp-server first').toBe(true);
    await seed();
    await exportOnce({ repo });
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'user notes\n');
    fx(lab, repo, ['add', 'notes.txt']);
    fx(lab, repo, ['commit', '-q', '-m', 'user: add notes.txt']);
    return fx(lab, repo, ['rev-parse', 'HEAD']);
  }

  it('an aged lock held by a paused live export is not stolen, and the paused export keeps the user file (a5b)', async () => {
    const userHead = await seedWithUserFile();
    const lockFile = path.join(repo, '.git', 'northkeep-export.lock');
    let other = '';
    let fired = false;
    setGitSpawnObserver((v) => {
      if (v !== 'update-index' || fired) return;
      fired = true;
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(lockFile, old, old);
      // Blocks this run mid-commit while a second process tries to export.
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { nodePlatform } from '@northkeep/platform-node';
import { setPlatform } from '@northkeep/core';
setPlatform(nodePlatform());
const { exportProjects } = await import(${JSON.stringify(RUN_DIST)});
try { const r = await exportProjects({ home: ${JSON.stringify(lab.home)}, vaultPath: ${JSON.stringify(lab.vaultPath)}, by: 'schedule', lockWaitMs: 300 }); console.log(r.status); }
catch (e) { console.log(e.code); }`], {
        cwd: MCP_DIR,
        env: { PATH: '/usr/bin:/bin', NORTHKEEP_HOME: lab.home, NORTHKEEP_MASTER_KEY: keyHex, NORTHKEEP_NO_KEYCHAIN: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      other = r.stdout.trim();
    });
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'During the race.' }));
    const res = await exportOnce();
    setGitSpawnObserver(null);
    expect(fired).toBe(true);
    expect(other).toBe('export_busy');
    expect(res.status).toBe('committed');
    assertHistoryKeeps(userHead);
  }, 90_000);

  /** Replaces the export lock with a live foreign owner's token when `verb` first spawns (with `arg` when given). */
  function stealLockOn(verb: string, arg?: string): () => boolean {
    const lockFile = path.join(repo, '.git', 'northkeep-export.lock');
    let fired = false;
    setGitSpawnObserver((v, a) => {
      if (fired || v !== verb || (arg !== undefined && !a.includes(arg))) return;
      fired = true;
      fs.writeFileSync(lockFile, `${JSON.stringify({ pid: process.ppid, started_at: new Date().toISOString(), nonce: 'fedcba9876543210' })}\n`);
    });
    return () => fired;
  }

  it('a run that loses the lock before update-ref commits nothing', async () => {
    await seed();
    await exportOnce({ repo });
    const head = fx(lab, repo, ['rev-parse', 'HEAD']);
    await write((v) => v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Lock stolen.' }));
    const fired = stealLockOn('commit-tree');
    const err = await exportOnce().catch((e: unknown) => e);
    setGitSpawnObserver(null);
    fs.rmSync(path.join(repo, '.git', 'northkeep-export.lock'), { force: true });
    expect(fired()).toBe(true);
    expect((err as ExportRefusal).code).toBe('lock_lost');
    expect((err as ExportRefusal).message).toContain('lost the export lock');
    expect(fx(lab, repo, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('a lock lost mid-run ends the run: no removal and no commit', async () => {
    await seed();
    await exportOnce({ repo });
    const head = fx(lab, repo, ['rev-parse', 'HEAD']);
    await write((v) => {
      v.deleteProject('demo');
      v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Lock lost early.' });
    });
    const fired = stealLockOn('hash-object', '-w');
    const err = await exportOnce().catch((e: unknown) => e);
    setGitSpawnObserver(null);
    fs.rmSync(path.join(repo, '.git', 'northkeep-export.lock'), { force: true });
    expect(fired()).toBe(true);
    expect(err).toBeInstanceOf(ExportRefusal);
    expect(fs.existsSync(path.join(repo, 'projects', 'demo.md'))).toBe(true);
    expect(fx(lab, repo, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('three and six plain exports racing a dead-owner lock never commit a tree missing a user file (a5d, a5g, a5h)', async () => {
    const userHead = await seedWithUserFile();
    const lockFile = path.join(repo, '.git', 'northkeep-export.lock');
    const outs: string[] = [];
    for (const n of [3, 3, 3, 6, 6]) {
      fs.writeFileSync(lockFile, `${JSON.stringify({ pid: deadPid(), started_at: 'x', nonce: 'dead' })}\n`);
      outs.push(...(await Promise.all(Array.from({ length: n }, () => childExport()))));
      assertHistoryKeeps(userHead);
    }
    expect(outs.some((o) => o.includes('"status"'))).toBe(true);
    expect(fx(lab, repo, ['status', '--short'])).toBe('');
  }, 120_000);
});

describe('a killed first export heals', () => {
  it('leaves only a marker temp beside .git after SIGKILL, and the next run exports cleanly', async () => {
    expect(fs.existsSync(RUN_DIST), 'build @northkeep/mcp-server first').toBe(true);
    await seed();
    const script = `import { nodePlatform } from '@northkeep/platform-node';
import { setPlatform } from '@northkeep/core';
setPlatform(nodePlatform());
const { exportProjects } = await import(${JSON.stringify(RUN_DIST)});
await exportProjects({ home: ${JSON.stringify(lab.home)}, vaultPath: ${JSON.stringify(lab.vaultPath)}, repo: ${JSON.stringify(repo)}, by: 'cli' });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: MCP_DIR,
      env: {
        PATH: '/usr/bin:/bin',
        NORTHKEEP_HOME: lab.home,
        NORTHKEEP_MASTER_KEY: keyHex,
        NORTHKEEP_NO_KEYCHAIN: '1',
        NORTHKEEP_EXPORT_CRASH_WRITE: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.signal, r.stderr).toBe('SIGKILL');
    const names = fs.readdirSync(repo).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('.git');
    expect(names[1]).toMatch(/^\.northkeep-mirror\.northkeep-tmp-[0-9a-f]{16}$/);
    expect(() => fx(lab, repo, ['rev-parse', '--verify', '-q', 'HEAD'])).toThrow();

    const res = await exportOnce({ repo });
    expect(res.status).toBe('committed');
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.northkeep-mirror', 'INDEX.md', 'projects']);
    expect(commits()).toBe(1);
    expect((await verifyReadOnly()).ok).toBe(true);
  });
});

describe('classifyTarget', () => {
  const V = '11111111-2222-3333-4444-555555555555';
  const R = '99999999-2222-3333-4444-555555555555';
  const doc = (vault: string, slug: string) =>
    Buffer.from(`<!-- northkeep: vault ${vault} project ${slug} revision ${R} kind document\n     The vault is canonical. This file is regenerated. Edits here are not read back. -->\n\nbody\n`);
  const b = 'a'.repeat(40);

  it('is ours only with this vault, this slug, the right kind and a journaled blob', () => {
    const ok = { diskBlob: b, journalBlobs: [b], vaultId: V, slug: 'demo' };
    expect(classifyTarget({ bytes: null, kind: 'document' }, { ...ok, diskBlob: null })).toBe('missing');
    expect(classifyTarget({ bytes: doc(V, 'demo'), kind: 'document' }, ok)).toBe('ours');
    expect(classifyTarget({ bytes: doc(R, 'demo'), kind: 'document' }, ok)).toBe('hand edit');
    expect(classifyTarget({ bytes: doc(V, 'other'), kind: 'document' }, ok)).toBe('hand edit');
    expect(classifyTarget({ bytes: doc(V, 'demo'), kind: 'log' }, ok)).toBe('hand edit');
    expect(classifyTarget({ bytes: doc(V, 'demo'), kind: 'document' }, { ...ok, journalBlobs: ['b'.repeat(40)] })).toBe('hand edit');
    expect(classifyTarget({ bytes: Buffer.from('# no header\n'), kind: 'document' }, ok)).toBe('hand edit');
  });
});

describe('readMirrorSummary', () => {
  it('is null unconfigured, counts only granted projects, and never runs git', async () => {
    await seed();
    expect(await runner((v) => readMirrorSummary(v, undefined, lab.home))).toBeNull();
    await exportOnce({ repo });
    await write((v) => {
      v.updateProject({ project: 'other', expected_revision: revision(v, 'other'), status: 'Changed.' });
      v.updateProject({ project: 'demo', expected_revision: revision(v, 'demo'), status: 'Changed too.' });
    });
    setGitSpawnObserver(() => {
      throw new Error('readMirrorSummary ran git');
    });
    const all = await runner((v) => readMirrorSummary(v, undefined, lab.home));
    const narrow = await runner((v) => readMirrorSummary(v, ['project:other'], lab.home));
    expect(all).toMatch(/^mirror last exported .*; 2 projects changed since$/);
    expect(narrow).toMatch(/; 1 project changed since$/);
    expect(all).not.toContain(repo);
  });
});

describe('importProjects', () => {
  function commandRepo(): string {
    const dir = path.join(lab.root, 'cr', 'projects');
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'alpha.md'),
      '# Alpha\n\n## What & Why\n\nA thing.\n\n## Current Status\n\nGoing.\n\n## Open Questions / Risks\n\nNone yet.\n\n## Log\n\n- 2026-09-01: Started.\n',
    );
    fs.writeFileSync(path.join(dir, 'beta.md'), '## Current Status\n\nBeta is fine.\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n');
    fs.writeFileSync(path.join(dir, 'nested', 'gamma.md'), '## Current Status\n\nnested\n');
    fs.writeFileSync(path.join(lab.root, 'cr', 'outside.md'), '## Current Status\n\nlinked\n');
    fs.symlinkSync(path.join(lab.root, 'cr', 'outside.md'), path.join(dir, 'linked.md'));
    return dir;
  }

  it('dry run lists the plan and writes nothing; write imports once and refuses an existing slug; the source is unchanged', async () => {
    const dir = commandRepo();
    const before = snapshot(path.join(lab.root, 'cr'));
    const dry = await importProjects(dir, { write: false, vaultPath: lab.vaultPath, withVault: runner });
    expect(dry.files).toEqual([
      { name: 'README.md', slug: null, status: 'skipped', reason: expect.stringContaining('not a project slug') },
      { name: 'alpha.md', slug: 'alpha', status: 'would import', reason: null },
      { name: 'beta.md', slug: 'beta', status: 'would import', reason: null },
    ]);
    expect(dry.plan.projects.find((p) => p.slug === 'alpha')?.sections.map((s) => s.to)).toContain('Open Questions');
    expect(await runner((v) => listProjectViews(v).length)).toBe(0);

    const wrote = await importProjects(dir, { write: true, vaultPath: lab.vaultPath, withVault: runner });
    expect(wrote.files.filter((f) => f.status === 'imported').map((f) => f.slug)).toEqual(['alpha', 'beta']);
    expect(await runner((v) => listProjectViews(v).map((s) => s.project))).toEqual(['alpha', 'beta']);
    const again = await importProjects(dir, { write: true, vaultPath: lab.vaultPath, withVault: runner });
    expect(again.files.filter((f) => f.status === 'refused').map((f) => f.slug)).toEqual(['alpha', 'beta']);
    expect(snapshot(path.join(lab.root, 'cr'))).toBe(before);
  });

  it('round trip: an exported mirror imports into a fresh vault with no header in any stored document', async () => {
    await seed();
    await exportOnce({ repo });
    await write((v) => {
      v.deleteProject('demo');
      v.deleteProject('other');
    });
    const before = snapshot(repo);
    const res = await importProjects(path.join(repo, 'projects'), { write: true, vaultPath: lab.vaultPath, withVault: runner });
    expect(res.files.map((f) => [f.name, f.status])).toEqual([
      ['demo.md', 'imported'],
      ['other.md', 'imported'],
    ]);
    expect(res.plan.projects.find((p) => p.slug === 'demo')?.log_files).toEqual(['demo.log.1.md']);
    const contents = await runner((v) => v.list({ type: 'working' }).map((e) => e.content));
    expect(contents.length).toBe(2);
    for (const c of contents) expect(c).not.toMatch(/<!--\s*northkeep:/);
    expect(snapshot(repo)).toBe(before);
  });
});

describe('the schedule', () => {
  it('writes a 0o644 LaunchAgent with the scheduled arguments into the given folder only, and removes it', async () => {
    if (process.platform !== 'darwin') return;
    const plistDir = path.join(lab.root, 'LaunchAgents');
    const file = await installSchedule('hourly', { cliEntry: '/opt/nk/cli.js', plistDir, load: false, northkeepHome: lab.home });
    expect(file).toBe(schedulePlistPath(plistDir));
    expect(file.startsWith(lab.root)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(text).toContain('<string>com.northkeep.mirror-export</string>');
    expect(text).toContain('<string>/opt/nk/cli.js</string>\n    <string>projects</string>\n    <string>export</string>\n    <string>--scheduled</string>');
    expect(text).toContain('<key>StartInterval</key>\n  <integer>3600</integer>');
    expect(text).toContain(`<key>NORTHKEEP_HOME</key>\n    <string>${lab.home}</string>`);
    expect(text).toContain('<string>/dev/null</string>');
    await installSchedule('daily', { cliEntry: '/opt/nk/cli.js', plistDir, load: false, northkeepHome: lab.home });
    expect(fs.readFileSync(file, 'utf8')).toContain('<key>StartCalendarInterval</key>');
    expect(fs.readdirSync(plistDir)).toEqual(['com.northkeep.mirror-export.plist']);
    expect(await removeSchedule({ plistDir, load: false })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(await removeSchedule({ plistDir, load: false })).toBe(false);
  });
});
