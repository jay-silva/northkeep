import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportRefusal } from '../src/git-plumbing.js';
import {
  EXPORT_LOCK_NAME,
  JOURNAL_DEPTH,
  acquireExportLock,
  emptyExportState,
  journalPath,
  readExportSettings,
  readExportState,
  readJournal,
  recordJournalBlob,
  settingsPath,
  statePath,
  writeExportSettings,
  writeExportState,
  writeJournal,
  type ExportLock,
} from '../src/project-export-run.js';
import { ctxFor, fx, initRepo, makeLab, type Lab } from './git-fixture.js';

const VAULT = '11111111-2222-3333-4444-555555555555';
const MCP_DIR = path.resolve(__dirname, '..');
const RUN_DIST = path.join(MCP_DIR, 'dist', 'project-export-run.js');

function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}
const blob = (n: number) => n.toString(16).padStart(40, '0');

let lab: Lab;
let prevHome: string | undefined;
let repo: string;
let lock: ExportLock | null;

beforeEach(() => {
  prevHome = process.env.NORTHKEEP_HOME;
  lab = makeLab('nk-state-');
  repo = fs.realpathSync(initRepo(lab));
  lock = null;
});

afterEach(() => {
  lock?.release();
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  lab.cleanup();
});

async function take(): Promise<ExportLock> {
  lock = await acquireExportLock(ctxFor(lab, repo), { waitMs: 200, pollMs: 20 });
  return lock;
}

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe('the export lock', () => {
  it('lives in the common dir, holds pid and start time, and excludes a second export', async () => {
    const l = await take();
    expect(l.path).toBe(path.join(repo, '.git', EXPORT_LOCK_NAME));
    const body = JSON.parse(fs.readFileSync(l.path, 'utf8')) as { pid: number; started_at: string };
    expect(body.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(body.started_at))).toBe(false);
    expect(l.held()).toBe(true);
    const err = await acquireExportLock(ctxFor(lab, repo), { waitMs: 100, pollMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportRefusal);
    expect((err as ExportRefusal).code).toBe('export_busy');
    l.release();
    expect(fs.existsSync(l.path)).toBe(false);
  });

  it('is shared by a linked worktree', async () => {
    fs.writeFileSync(path.join(repo, 'a'), 'a');
    fx(lab, repo, ['add', 'a']);
    fx(lab, repo, ['commit', '-q', '-m', 'a']);
    const wt = path.join(lab.root, 'wt');
    fx(lab, repo, ['worktree', 'add', '-q', '-b', 'side', wt]);
    const l = await take();
    const err = await acquireExportLock(ctxFor(lab, wt), { waitMs: 100, pollMs: 20 }).catch((e: unknown) => e);
    expect((err as ExportRefusal).code).toBe('export_busy');
    expect(l.path).toBe(path.join(repo, '.git', EXPORT_LOCK_NAME));
  });

  it('steals a lock whose pid is dead', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const p = path.join(repo, '.git', EXPORT_LOCK_NAME);
    fs.writeFileSync(p, `${JSON.stringify({ pid: Number(dead.stdout), started_at: new Date().toISOString() })}\n`);
    const l = await take();
    expect(l.held()).toBe(true);
  });

  it('never steals a live owner by age, and reports since when it has been running (a5b)', async () => {
    const p = path.join(repo, '.git', EXPORT_LOCK_NAME);
    const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const body = `${JSON.stringify({ pid: process.ppid, started_at: since, nonce: '0123456789abcdef' })}\n`;
    fs.writeFileSync(p, body);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(p, old, old);
    const err = await acquireExportLock(ctxFor(lab, repo), { waitMs: 100, pollMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportRefusal);
    expect((err as ExportRefusal).code).toBe('export_busy');
    expect((err as ExportRefusal).message).toContain(`Another NorthKeep export has been running since ${since}`);
    expect((err as ExportRefusal).message).not.toContain(repo);
    expect(fs.readFileSync(p, 'utf8')).toBe(body);
  });

  it('never steals an unreadable lock, whatever its age, and says how to clear it', async () => {
    const p = path.join(repo, '.git', EXPORT_LOCK_NAME);
    fs.writeFileSync(p, 'not json, owner unknown\n');
    const old = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(p, old, old);
    const err = await acquireExportLock(ctxFor(lab, repo), { waitMs: 100, pollMs: 20 }).catch((e: unknown) => e);
    expect((err as ExportRefusal).code).toBe('lock_unreadable');
    expect((err as ExportRefusal).message).toContain('northkeep-export.lock');
    expect((err as ExportRefusal).message).not.toContain(repo);
    expect(fs.readFileSync(p, 'utf8')).toBe('not json, owner unknown\n');
  });

  it('16 contenders on a dead-owner lock never hold it at the same time (a5c)', async () => {
    expect(fs.existsSync(RUN_DIST), 'build @northkeep/mcp-server first').toBe(true);
    const child = `const run = await import(${JSON.stringify(RUN_DIST)});
const go = Number(process.argv[1]); while (Date.now() < go) {}
let lock;
try { lock = await run.acquireExportLock({ repo: ${JSON.stringify(repo)}, home: ${JSON.stringify(lab.home)}, vaultPath: '/nonexistent/v.nkv' }, { waitMs: 20000, pollMs: 5 }); }
catch (e) { console.log(JSON.stringify({ refused: e.code })); process.exit(0); }
const t0 = performance.timeOrigin + performance.now(); const until = Date.now() + 120; while (Date.now() < until) {}
const held = lock.held(); const t1 = performance.timeOrigin + performance.now(); lock.release();
console.log(JSON.stringify({ t0, t1, held }));`;
    const lockFile = path.join(repo, '.git', EXPORT_LOCK_NAME);
    let overlaps = 0;
    let lost = 0;
    let holds = 0;
    for (let round = 0; round < 6; round++) {
      fs.writeFileSync(lockFile, `${JSON.stringify({ pid: deadPid(), started_at: 'x', nonce: 'dead' })}\n`);
      const go = Date.now() + 900;
      const outs = await Promise.all(
        Array.from({ length: 16 }, () =>
          new Promise<string>((resolve) => {
            const c = spawn(process.execPath, ['--input-type=module', '-e', child, String(go)], { cwd: MCP_DIR, env: { PATH: '/usr/bin:/bin', NORTHKEEP_HOME: lab.home } });
            let o = '';
            c.stdout.on('data', (d: Buffer) => (o += d.toString()));
            c.on('close', () => resolve(o.trim()));
          }),
        ),
      );
      const iv = outs.filter(Boolean).map((l) => JSON.parse(l) as { t0?: number; t1?: number; held?: boolean }).filter((x) => x.t0 !== undefined);
      iv.sort((a, b) => a.t0! - b.t0!);
      for (let i = 1; i < iv.length; i++) if (iv[i]!.t0! < iv[i - 1]!.t1!) overlaps++;
      lost += iv.filter((x) => !x.held).length;
      holds += iv.length;
    }
    expect(holds).toBeGreaterThan(0);
    expect(overlaps).toBe(0);
    expect(lost).toBe(0);
  }, 90_000);

  it('refuses, and removes nothing, when a dead stealer left its steal guard behind', async () => {
    const p = path.join(repo, '.git', EXPORT_LOCK_NAME);
    const dead = `${JSON.stringify({ pid: deadPid(), started_at: 'x', nonce: 'dead' })}\n`;
    fs.writeFileSync(p, dead);
    fs.writeFileSync(`${p}.steal`, dead);
    const err = await acquireExportLock(ctxFor(lab, repo), { waitMs: 100, pollMs: 20 }).catch((e: unknown) => e);
    expect((err as ExportRefusal).code).toBe('lock_unreadable');
    expect((err as ExportRefusal).message).toContain('northkeep-export.lock.steal');
    expect(fs.readFileSync(p, 'utf8')).toBe(dead);
    expect(fs.existsSync(`${p}.steal`)).toBe(true);
  });

  it('never removes a lock it no longer holds', async () => {
    const l = await take();
    fs.writeFileSync(l.path, `${JSON.stringify({ pid: 1, started_at: new Date().toISOString() })}\n`);
    expect(l.held()).toBe(false);
    l.release();
    expect(fs.existsSync(l.path)).toBe(true);
    fs.rmSync(l.path);
  });
});

describe('the write journal', () => {
  it('keeps ten blobs per path newest first, moves a repeat to the front, and writes 0o600', async () => {
    const l = await take();
    const j = readJournal(lab.home, repo, VAULT);
    expect(j.paths).toEqual({});
    for (let i = 1; i <= 12; i++) recordJournalBlob(j, 'projects/demo.md', blob(i));
    expect(j.paths['projects/demo.md']).toHaveLength(JOURNAL_DEPTH);
    expect(j.paths['projects/demo.md']?.[0]).toBe(blob(12));
    expect(j.paths['projects/demo.md']).not.toContain(blob(2));
    recordJournalBlob(j, 'projects/demo.md', blob(5));
    expect(j.paths['projects/demo.md']?.slice(0, 2)).toEqual([blob(5), blob(12)]);
    expect(j.paths['projects/demo.md']).toHaveLength(JOURNAL_DEPTH);
    writeJournal(lab.home, j, l);
    expect(mode(journalPath(lab.home, repo))).toBe(0o600);
    expect(readJournal(lab.home, repo, VAULT)).toEqual(j);
  });

  it('an unchanged run never evicts history', () => {
    const j = readJournal(lab.home, repo, VAULT);
    for (let i = 1; i <= 10; i++) recordJournalBlob(j, 'INDEX.md', blob(i));
    for (let i = 0; i < 20; i++) recordJournalBlob(j, 'INDEX.md', blob(10));
    expect(j.paths['INDEX.md']).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(blob));
  });

  it('reads as empty when unparseable, another version, another repository or another vault', async () => {
    const l = await take();
    const j = readJournal(lab.home, repo, VAULT);
    recordJournalBlob(j, 'INDEX.md', blob(1));
    writeJournal(lab.home, j, l);
    expect(readJournal(lab.home, repo, 'other-vault').paths).toEqual({});
    const file = journalPath(lab.home, repo);
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const bad of [{ ...body, version: 2 }, { ...body, repo: '/elsewhere' }, { ...body, paths: { x: ['HEAD'] } }]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      expect(readJournal(lab.home, repo, VAULT).paths).toEqual({});
    }
    fs.writeFileSync(file, '{not json');
    expect(readJournal(lab.home, repo, VAULT).paths).toEqual({});
  });

  it('refuses a write without the lock and a malformed blob', async () => {
    const l = await take();
    const j = readJournal(lab.home, repo, VAULT);
    l.release();
    expect(() => writeJournal(lab.home, j, l)).toThrow(ExportRefusal);
    expect(() => recordJournalBlob(j, 'INDEX.md', 'not-a-blob')).toThrow(ExportRefusal);
  });
});

describe('the state file', () => {
  it('round-trips the Decision 7 shape at 0o600 and rejects a mismatch', async () => {
    const l = await take();
    const s = emptyExportState(repo, VAULT);
    s.last_success = { at: '2026-09-22T10:00:00.000Z', commit: blob(7) };
    s.last_attempt = { at: '2026-09-22T10:00:00.000Z', by: 'schedule' };
    s.last_failure = { at: '2026-09-21T10:00:00.000Z', code: 'vault_locked' };
    s.refused = [{ path: 'projects/demo.md', reason: 'hand edit' }];
    s.projects = { demo: { revision: 'r1', exported_at: '2026-09-22T10:00:00.000Z' } };
    s.nk_commits = [blob(6), blob(7)];
    writeExportState(lab.home, s, l);
    expect(mode(statePath(lab.home, repo))).toBe(0o600);
    expect(readExportState(lab.home, repo, VAULT)).toEqual(s);
    expect(readExportState(lab.home, repo, 'other-vault')).toBeNull();
    const file = statePath(lab.home, repo);
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const bad of [
      { ...body, last_attempt: { at: 'x', by: 'agent' } },
      { ...body, nk_commits: ['HEAD'] },
      { ...body, projects: { demo: { revision: 1 } } },
      { ...body, version: 2 },
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      expect(readExportState(lab.home, repo, VAULT)).toBeNull();
    }
  });

  it('is absent before the first run and refuses a write without the lock', async () => {
    expect(readExportState(lab.home, repo, VAULT)).toBeNull();
    const l = await take();
    l.release();
    expect(() => writeExportState(lab.home, emptyExportState(repo, VAULT), l)).toThrow(ExportRefusal);
    expect(fs.existsSync(statePath(lab.home, repo))).toBe(false);
  });
});

describe('the settings file', () => {
  it('is missing when unconfigured, holds only the repository, and writes 0o600 under the lock', async () => {
    expect(readExportSettings(lab.home)).toBeNull();
    const l = await take();
    writeExportSettings(lab.home, { repo }, l);
    expect(JSON.parse(fs.readFileSync(settingsPath(lab.home), 'utf8'))).toEqual({ repo });
    expect(mode(settingsPath(lab.home))).toBe(0o600);
    expect(readExportSettings(lab.home)).toEqual({ repo });
    l.release();
    expect(() => writeExportSettings(lab.home, { repo: '/other' }, l)).toThrow(ExportRefusal);
    expect(readExportSettings(lab.home)).toEqual({ repo });
  });

  it('refuses an unreadable file with fixed text', () => {
    for (const bad of ['{not json', '{"repo": 3}', '{"repo": "/x", "token": "y"}', '[]']) {
      fs.writeFileSync(settingsPath(lab.home), bad);
      let err: unknown;
      try {
        readExportSettings(lab.home);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ExportRefusal);
      expect((err as ExportRefusal).code).toBe('settings_unreadable');
      expect((err as ExportRefusal).message).not.toContain(lab.home);
    }
  });
});
