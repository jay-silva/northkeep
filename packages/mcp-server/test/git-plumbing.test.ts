import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from '@northkeep/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeMirrorFile } from '../src/fs-safe.js';
import {
  ExportRefusal,
  INDEX_NOT_REFRESHED,
  assertAllowedGitArgs,
  checkTargetContainment,
  gitEnv,
  gitPins,
  hashFile,
  hashObjectWrite,
  headBlob,
  plumbingCommit,
  preflightRepository,
  readRemotes,
  removeStaleRunIndexes,
  repoKey,
  requireCommitIdentity,
  runGit,
  setGitSpawnObserver,
  type GitContext,
  type RepoInfo,
} from '../src/git-plumbing.js';
import { ctxFor, fx, initRepo, makeLab, markerBytes, parseMarkerStub, type Lab } from './git-fixture.js';

const VAULT = '11111111-2222-3333-4444-555555555555';
const REPO_ROOT = path.resolve(__dirname, '../../..');

let lab: Lab;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.NORTHKEEP_HOME;
  lab = makeLab();
});

afterEach(() => {
  setGitSpawnObserver(null);
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  lab.cleanup();
});

function preflight(repo: string, vaultId = VAULT) {
  return preflightRepository({
    repo,
    home: lab.home,
    vaultPath: lab.vaultPath,
    vaultId,
    parseMarker: parseMarkerStub,
  });
}

/** One export the way exportProjects will do it: contain, hash, write, commit. */
async function exportFiles(ctx: GitContext, info: RepoInfo, files: Record<string, string | Buffer>) {
  const add = [];
  for (const [rel, body] of Object.entries(files)) {
    await checkTargetContainment(ctx, rel, info.head);
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    const blob = await hashObjectWrite(ctx, bytes);
    fs.mkdirSync(path.dirname(path.join(ctx.repo, rel)), { recursive: true });
    writeMirrorFile(path.join(ctx.repo, rel), bytes);
    add.push({ path: rel, blob });
  }
  return plumbingCommit(ctx, info, { add, message: 'export: test\n' });
}

async function firstExport(repo: string) {
  const { ctx, info } = await preflight(repo);
  expect(info.ownership).toBe('fresh');
  const res = await exportFiles(ctx, info, {
    '.northkeep-mirror': markerBytes(VAULT),
    'projects/demo.md': '# demo\n',
    'INDEX.md': '# index\n',
  });
  return { ctx, res };
}

async function expectRefusal(p: Promise<unknown>, code: string): Promise<ExportRefusal> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExportRefusal);
  expect((err as ExportRefusal).code).toBe(code);
  return err as ExportRefusal;
}

describe('runGit environment and allowlist', () => {
  it('builds exactly the canary environment and -c pins', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/adr-0053-canary.sh'), 'utf8');
    const block = (name: string) => {
      const m = new RegExp(`^${name}=\\(([\\s\\S]*?)\\)`, 'm').exec(script);
      if (!m) throw new Error(`no ${name} block`);
      return (m[1] as string).match(/"[^"]*"|\S+/g)!.map((t) => t.replace(/^"|"$/g, ''));
    };
    const N = '/nk';
    const sub = (t: string) => t.replace(/\$N/g, N);
    const pins = block('PINS').map(sub);
    expect(gitPins(N)).toEqual(pins);
    const envb = block('ENVB').map(sub);
    const envp = [...envb, 'GIT_NO_REPLACE_OBJECTS=1'];
    expect(script).toMatch(/^ENVP=\("\$\{ENVB\[@\]\}" GIT_NO_REPLACE_OBJECTS=1\)/m);
    const asList = (e: Record<string, string>) => Object.entries(e).map(([k, v]) => `${k}=${v}`);
    expect(asList(gitEnv(N, null))).toEqual(envp);
    expect(asList(gitEnv(N, '/nk/export/k.index'))).toEqual([...envp, 'GIT_INDEX_FILE=/nk/export/k.index']);
  });

  it('refuses every verb outside the allowlist, including prefixed options', () => {
    const bad = [
      ['push'],
      ['fetch'],
      ['ls-remote', 'origin'],
      ['add', '.'],
      ['commit', '-m', 'x'],
      ['status'],
      ['diff'],
      ['checkout', '.'],
      ['init'],
      ['config', 'user.name'],
      ['worktree', 'add', 'x'],
      ['worktree', 'list'],
      ['worktree', 'list', '--porcelain', 'extra'],
      ['remote', 'add', 'x', 'y'],
      ['remote', '-v', 'extra'],
      ['remote'],
      ['-c', 'core.pager=x', 'rev-parse'],
      ['--exec-path=/tmp', 'rev-parse'],
      [],
    ];
    for (const args of bad) expect(() => assertAllowedGitArgs(args), args.join(' ')).toThrow(ExportRefusal);
    for (const args of [['rev-parse', 'HEAD'], ['worktree', 'list', '--porcelain'], ['remote', '-v'], ['var', 'GIT_COMMITTER_IDENT']]) {
      expect(() => assertAllowedGitArgs(args)).not.toThrow();
    }
  });

  it('refuses a disallowed verb before spawning anything', async () => {
    const repo = initRepo(lab);
    const seen: string[] = [];
    setGitSpawnObserver((v) => seen.push(v));
    await expectRefusal(runGit(ctxFor(lab, repo), ['push', 'origin']), 'git_verb_refused');
    expect(seen).toEqual([]);
  });

  it('refuses to run git while this process holds the vault lock', async () => {
    const repo = initRepo(lab);
    const ctx = ctxFor(lab, repo);
    fs.writeFileSync(lab.vaultPath, '');
    await withFileLock(lab.vaultPath, async () => {
      await expectRefusal(runGit(ctx, ['rev-parse', '--is-bare-repository']), 'vault_lock_held');
    });
    expect((await runGit(ctx, ['rev-parse', '--is-bare-repository'])).stdout.trim()).toBe('false');
  });

  it('creates an owned empty hooks folder and zero-byte global config, and refuses planted ones', async () => {
    const repo = initRepo(lab);
    const ctx = ctxFor(lab, repo);
    await runGit(ctx, ['rev-parse', '--git-dir']);
    expect(fs.readdirSync(path.join(lab.home, 'hooks'))).toEqual([]);
    expect(fs.statSync(path.join(lab.home, 'empty.gitconfig')).size).toBe(0);
    expect(fs.statSync(path.join(lab.home, 'export')).mode & 0o777).toBe(0o700);
    fs.writeFileSync(path.join(lab.home, 'hooks', 'post-index-change'), '#!/bin/sh\n');
    await expectRefusal(runGit(ctx, ['rev-parse', '--git-dir']), 'hooks_dir_invalid');
    fs.rmSync(path.join(lab.home, 'hooks', 'post-index-change'));
    fs.writeFileSync(path.join(lab.home, 'empty.gitconfig'), '[core]\n\thooksPath = /tmp\n');
    await expectRefusal(runGit(ctx, ['rev-parse', '--git-dir']), 'gitconfig_invalid');
  });

  it('removes stale run indexes only when their pid is dead, plus the old shared one', async () => {
    const repo = fs.realpathSync(initRepo(lab));
    const exp = path.join(lab.home, 'export');
    fs.mkdirSync(exp, { recursive: true });
    const key = repoKey(repo);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    const names = [`${key}.index`, `${key}.${dead}.0123456789abcdef.index`, `${key}.${process.ppid}.0123456789abcdef.index`, `${'f'.repeat(64)}.${dead}.0123456789abcdef.index`, `${key}.json`];
    for (const n of names) fs.writeFileSync(path.join(exp, n), '');
    removeStaleRunIndexes(lab.home, repo);
    expect(fs.readdirSync(exp).sort()).toEqual([names[2], names[3], names[4]].sort());
  });

  it('does not pass the parent environment to git', async () => {
    const repo = initRepo(lab);
    process.env.GIT_DIR = path.join(lab.root, 'elsewhere');
    process.env.GIT_INDEX_FILE = path.join(lab.root, 'elsewhere.index');
    try {
      const gd = (await runGit(ctxFor(lab, repo), ['rev-parse', '--path-format=absolute', '--git-dir'])).stdout.trim();
      expect(gd).toBe(path.join(fs.realpathSync(repo), '.git'));
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_INDEX_FILE;
    }
  });
});

describe('preflightRepository', () => {
  it('accepts an empty folder with an unborn HEAD as fresh, and a marked folder as owned', async () => {
    const repo = initRepo(lab);
    const { res } = await firstExport(repo);
    expect(res.status).toBe('committed');
    const again = await preflight(repo);
    expect(again.info.ownership).toBe('owned');
    expect(again.info.head).toBe(res.commit);
  });

  it('treats a folder holding only Finder\'s .DS_Store file as fresh and never commits it', async () => {
    const repo = initRepo(lab);
    fs.writeFileSync(path.join(repo, '.DS_Store'), 'finder');
    const { res } = await firstExport(repo);
    expect(res.status).toBe('committed');
    expect(fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')).not.toContain('.DS_Store');
    const dirRepo = initRepo(lab, 'dsdir');
    fs.mkdirSync(path.join(dirRepo, '.DS_Store'));
    await expectRefusal(preflight(dirRepo), 'not_owned');
  });

  it('refuses a missing folder, a non-repository and a subfolder of a work tree', async () => {
    await expectRefusal(preflight(path.join(lab.root, 'absent')), 'repo_missing');
    const plain = path.join(lab.root, 'plain');
    fs.mkdirSync(plain);
    await expectRefusal(preflight(plain), 'not_work_tree');
    const repo = initRepo(lab);
    fs.mkdirSync(path.join(repo, 'sub'));
    await expectRefusal(preflight(path.join(repo, 'sub')), 'not_toplevel');
  });

  it('refuses a bare repository', async () => {
    const bare = path.join(lab.root, 'bare.git');
    fx(lab, lab.root, ['init', '-q', '--bare', bare]);
    await expectRefusal(preflight(bare), 'not_work_tree');
  });

  it('refuses a repository inside the NorthKeep home or the vault folder', async () => {
    const inHome = path.join(lab.home, 'mirror');
    fs.mkdirSync(inHome, { recursive: true });
    fx(lab, inHome, ['init', '-q']);
    await expectRefusal(preflight(inHome), 'repo_in_home');
    const vaultDir = path.join(lab.root, 'vaultdir');
    const inVault = path.join(vaultDir, 'mirror');
    fs.mkdirSync(inVault, { recursive: true });
    fx(lab, inVault, ['init', '-q']);
    await expectRefusal(
      preflightRepository({
        repo: inVault,
        home: lab.home,
        vaultPath: path.join(vaultDir, 'vault.nkv'),
        vaultId: VAULT,
        parseMarker: parseMarkerStub,
      }),
      'repo_in_home',
    );
  });

  it('refuses a NorthKeep source checkout', async () => {
    const repo = initRepo(lab);
    fs.mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'core', 'package.json'), '{"name":"@northkeep/core"}');
    await expectRefusal(preflight(repo), 'repo_is_northkeep');
    const root = initRepo(lab, 'rootpkg');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"northkeep"}');
    await expectRefusal(preflight(root), 'repo_is_northkeep');
  });

  it('refuses a first export into a non-empty folder or a born HEAD', async () => {
    const repo = initRepo(lab);
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'mine\n');
    await expectRefusal(preflight(repo), 'not_owned');
    const repo2 = initRepo(lab, 'born');
    fs.writeFileSync(path.join(repo2, 'a.txt'), 'a\n');
    fx(lab, repo2, ['add', 'a.txt']);
    fx(lab, repo2, ['commit', '-q', '-m', 'a']);
    fs.rmSync(path.join(repo2, 'a.txt'));
    await expectRefusal(preflight(repo2), 'not_owned');
  });

  it('refuses when the marker is gone, unparseable, another vault, or a symlink', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const marker = path.join(repo, '.northkeep-mirror');
    await expectRefusal(preflight(repo, 'another-vault'), 'marker_mismatch');
    fs.writeFileSync(marker, 'garbage\n');
    await expectRefusal(preflight(repo), 'marker_mismatch');
    fs.rmSync(marker);
    await expectRefusal(preflight(repo), 'not_owned');
    fs.writeFileSync(path.join(lab.root, 'm'), markerBytes(VAULT));
    fs.symlinkSync(path.join(lab.root, 'm'), marker);
    await expectRefusal(preflight(repo), 'marker_invalid');
  });

  it("refuses while git's index.lock exists and never removes it", async () => {
    const repo = initRepo(lab);
    const lock = path.join(repo, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const err = await expectRefusal(preflight(repo), 'index_locked');
    expect(err.message).not.toContain(repo);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("refuses when HEAD's branch is checked out in another worktree", async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const wt = path.join(lab.root, 'wt');
    fx(lab, repo, ['worktree', 'add', '-q', '--detach', wt]);
    // A detached worktree shares no branch with main, so both are accepted.
    expect((await preflight(wt)).info.ownership).toBe('owned');
    fx(lab, wt, ['checkout', '-q', '--ignore-other-worktrees', 'main']);
    await expectRefusal(preflight(repo), 'branch_elsewhere');
    await expectRefusal(preflight(wt), 'branch_elsewhere');
  });
});

describe('checkTargetContainment', () => {
  async function ownedRepo() {
    const repo = initRepo(lab);
    const { ctx } = await firstExport(repo);
    const { info } = await preflight(repo);
    return { repo, ctx, info };
  }

  it('refuses a path NorthKeep does not write', async () => {
    const { ctx, info } = await ownedRepo();
    for (const rel of ['notes.txt', 'projects/../x.md', 'projects/sub/x.md', 'projects/Demo.md', '.git/config', 'projects/a.md.bak']) {
      await expectRefusal(checkTargetContainment(ctx, rel, info.head), 'path_not_mirror');
    }
  });

  it('refuses a symlinked projects folder and a symlinked target, writing nothing outside', async () => {
    const { repo, ctx, info } = await ownedRepo();
    const outside = path.join(lab.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.md'), 'OUTSIDE\n');
    fs.symlinkSync(path.join(outside, 'x.md'), path.join(repo, 'projects', 'link.md'));
    const e = await expectRefusal(checkTargetContainment(ctx, 'projects/link.md', info.head), 'containment_symlink');
    expect(e.message).toBe(
      'projects/link.md is a symlink; NorthKeep exports only into a real directory inside the repository',
    );
    fs.rmSync(path.join(repo, 'projects'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'projects'));
    await expectRefusal(checkTargetContainment(ctx, 'projects/x.md', info.head), 'containment_symlink');
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('OUTSIDE\n');
  });

  it('refuses a hard-linked target and a non-regular target', async () => {
    const { repo, ctx, info } = await ownedRepo();
    fs.linkSync(path.join(repo, 'projects', 'demo.md'), path.join(lab.root, 'hardlink'));
    await expectRefusal(checkTargetContainment(ctx, 'projects/demo.md', info.head), 'containment_not_regular');
    fs.mkdirSync(path.join(repo, 'projects', 'dir.md'));
    await expectRefusal(checkTargetContainment(ctx, 'projects/dir.md', info.head), 'containment_not_regular');
  });

  it('refuses a nested .git under projects and a projects file where the folder should be', async () => {
    const { repo, ctx, info } = await ownedRepo();
    fs.mkdirSync(path.join(repo, 'projects', '.git'));
    await expectRefusal(checkTargetContainment(ctx, 'projects/demo.md', info.head), 'containment_nested_git');
    fs.rmSync(path.join(repo, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'projects'), 'a file\n');
    await expectRefusal(checkTargetContainment(ctx, 'projects/demo.md', info.head), 'containment_not_dir');
  });

  it('refuses a projects gitlink committed in HEAD', async () => {
    const { repo, ctx } = await ownedRepo();
    const head = fx(lab, repo, ['rev-parse', 'HEAD']);
    const tree = fx(lab, repo, ['mktree'], `160000 commit ${head}\tprojects\n`);
    const c = fx(lab, repo, ['commit-tree', tree, '-p', head], 'projects gitlink\n');
    fx(lab, repo, ['update-ref', 'HEAD', c]);
    await expectRefusal(checkTargetContainment(ctx, 'projects/demo.md', c), 'containment_gitlink');
  });

  it('accepts a missing projects folder and missing target', async () => {
    const repo = initRepo(lab);
    const { ctx, info } = await preflight(repo);
    await expect(checkTargetContainment(ctx, 'projects/new.md', info.head)).resolves.toBeUndefined();
  });
});

describe('plumbingCommit', () => {
  it('makes a root commit on an unborn HEAD with exactly the given paths, and a clean index', async () => {
    const repo = initRepo(lab);
    const { res } = await firstExport(repo);
    expect(res.status).toBe('committed');
    expect(fx(lab, repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort()).toEqual(
      ['.northkeep-mirror', 'INDEX.md', 'projects/demo.md'].sort(),
    );
    expect(fx(lab, repo, ['status', '--short'])).toBe('');
    expect(res.indexRefreshed).toBe(true);
  });

  it('stops before commit-tree when the tree equals HEAD, and still reconciles', async () => {
    const repo = initRepo(lab);
    const { res: first } = await firstExport(repo);
    const { ctx, info } = await preflight(repo);
    const seen: string[] = [];
    setGitSpawnObserver((v) => seen.push(v));
    const res = await exportFiles(ctx, info, { 'projects/demo.md': '# demo\n', 'INDEX.md': '# index\n' });
    expect(res.status).toBe('unchanged');
    expect(res.commit).toBeNull();
    expect(seen).not.toContain('commit-tree');
    expect(seen).not.toContain('update-ref');
    expect(fx(lab, repo, ['rev-parse', 'HEAD'])).toBe(first.commit);
  });

  it("never commits the user's staged or untracked files, and leaves the staged one staged", async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'tax notes\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    fx(lab, repo, ['add', 'staged.txt']);
    const { ctx, info } = await preflight(repo);
    const res = await exportFiles(ctx, info, { 'projects/demo.md': '# demo v2\n' });
    expect(res.status).toBe('committed');
    const names = fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
    expect(names).not.toContain('mine.txt');
    expect(names).not.toContain('staged.txt');
    expect(fx(lab, repo, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(fx(lab, repo, ['status', '--short']).split('\n').sort()).toEqual(['?? mine.txt', 'A  staged.txt']);
  });

  it('removes a path it is told to remove', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const { ctx, info } = await preflight(repo);
    fs.rmSync(path.join(repo, 'projects', 'demo.md'));
    const res = await plumbingCommit(ctx, info, { add: [], remove: ['projects/demo.md'], message: 'export: rm\n' });
    expect(res.status).toBe('committed');
    expect(fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('projects/demo.md');
    expect(fx(lab, repo, ['status', '--short'])).toBe('');
  });

  it('never commits a tree missing a HEAD file it was not told to remove, even when a temp index vanishes mid-run (a5)', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'user notes\n');
    fx(lab, repo, ['add', 'notes.txt']);
    fx(lab, repo, ['commit', '-q', '-m', 'user: notes']);
    const userHead = fx(lab, repo, ['rev-parse', 'HEAD']);
    const { ctx, info } = await preflight(repo);
    // What a concurrent run did in a5b: remove the index files under export/ after this run's read-tree.
    let fired = false;
    setGitSpawnObserver((v) => {
      if (v !== 'update-index' || fired) return;
      fired = true;
      for (const n of fs.readdirSync(path.join(lab.home, 'export'))) {
        if (n.endsWith('.index')) fs.rmSync(path.join(lab.home, 'export', n));
      }
    });
    await exportFiles(ctx, info, { 'projects/demo.md': '# demo v2\n' }).catch((e: unknown) => {
      expect((e as ExportRefusal).code).toBe('tree_check_failed');
    });
    expect(fired).toBe(true);
    const names = fx(lab, repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
    expect(names).toContain('notes.txt');
    expect(names).toContain('.northkeep-mirror');
    expect(fx(lab, repo, ['rev-list', '--count', `${userHead}..HEAD`])).toMatch(/^[01]$/);
  });

  it('uses a private temp index per run and removes only its own', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const { ctx, info } = await preflight(repo);
    const indexes = new Set<string>();
    const exp = path.join(lab.home, 'export');
    setGitSpawnObserver((v) => {
      if (v === 'write-tree') for (const n of fs.readdirSync(exp)) if (n.endsWith('.index')) indexes.add(n);
    });
    await exportFiles(ctx, info, { 'projects/demo.md': '# demo v5\n' });
    const { ctx: c2, info: i2 } = await preflight(repo);
    await exportFiles(c2, i2, { 'projects/demo.md': '# demo v6\n' });
    expect(indexes.size).toBe(2);
    for (const n of indexes) expect(n).toMatch(/^[0-9a-f]{64}\.\d+\.[0-9a-f]{16}\.index$/);
    expect(fs.readdirSync(exp).filter((n) => n.endsWith('.index'))).toEqual([]);
  });

  it('runs the guard before update-ref and leaves HEAD unmoved when it throws', async () => {
    const repo = initRepo(lab);
    const { res: first } = await firstExport(repo);
    const { ctx, info } = await preflight(repo);
    const blob = await hashObjectWrite(ctx, Buffer.from('# demo v7\n'));
    const seen: string[] = [];
    setGitSpawnObserver((v) => seen.push(v));
    const guard = () => {
      throw new ExportRefusal('lock_lost', 'lost');
    };
    await expectRefusal(plumbingCommit(ctx, info, { add: [{ path: 'projects/demo.md', blob }], message: 'x\n', guard }), 'lock_lost');
    expect(seen).toContain('commit-tree');
    expect(seen).not.toContain('update-ref');
    expect(fx(lab, repo, ['rev-parse', 'HEAD'])).toBe(first.commit);
  });

  it('refuses a commit of a non-mirror path or a malformed blob', async () => {
    const repo = initRepo(lab);
    const { ctx, info } = await preflight(repo);
    const blob = await hashObjectWrite(ctx, Buffer.from('x'));
    await expectRefusal(plumbingCommit(ctx, info, { add: [{ path: 'mine.txt', blob }], message: 'x' }), 'path_not_mirror');
    await expectRefusal(
      plumbingCommit(ctx, info, { add: [{ path: 'INDEX.md', blob: 'HEAD' }], message: 'x' }),
      'bad_blob',
    );
  });

  it('stops before update-ref when index.lock appears after preflight, HEAD unmoved', async () => {
    const repo = initRepo(lab);
    const { res: first } = await firstExport(repo);
    const { ctx, info } = await preflight(repo);
    setGitSpawnObserver((v) => {
      if (v === 'commit-tree') fs.writeFileSync(path.join(info.gitDir, 'index.lock'), '');
    });
    await expectRefusal(exportFiles(ctx, info, { 'projects/demo.md': '# demo v3\n' }), 'index_locked');
    expect(fx(lab, repo, ['rev-parse', 'HEAD'])).toBe(first.commit);
    expect(fs.existsSync(path.join(info.gitDir, 'index.lock'))).toBe(true);
  });

  it('reports "committed; working index not refreshed" when the reconcile cannot take the index', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const { ctx, info } = await preflight(repo);
    setGitSpawnObserver((v) => {
      if (v === 'update-ref') fs.writeFileSync(path.join(info.gitDir, 'index.lock'), '');
    });
    const res = await exportFiles(ctx, info, { 'projects/demo.md': '# demo v4\n' });
    expect(res.status).toBe('committed');
    expect(res.indexRefreshed).toBe(false);
    expect(res.note).toBe(INDEX_NOT_REFRESHED);
    expect(fx(lab, repo, ['rev-parse', 'HEAD'])).toBe(res.commit);
    // The next run, once the lock is gone, refreshes the index even with nothing to commit.
    fs.rmSync(path.join(info.gitDir, 'index.lock'));
    setGitSpawnObserver(null);
    const { ctx: c2, info: i2 } = await preflight(repo);
    const again = await exportFiles(c2, i2, { 'projects/demo.md': '# demo v4\n' });
    expect(again.status).toBe('unchanged');
    expect(again.indexRefreshed).toBe(true);
    expect(fx(lab, repo, ['status', '--short'])).toBe('');
  });

  it('commits from a linked worktree into its own branch and reconciles its own index', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const wt = path.join(lab.root, 'wt');
    fx(lab, repo, ['worktree', 'add', '-q', '-b', 'side', wt]);
    const { ctx, info } = await preflight(wt);
    expect(info.gitDir).toBe(path.join(fs.realpathSync(repo), '.git', 'worktrees', 'wt'));
    expect(info.commonDir).toBe(path.join(fs.realpathSync(repo), '.git'));
    const res = await exportFiles(ctx, info, { 'projects/demo.md': '# from wt\n' });
    expect(res.status).toBe('committed');
    expect(fx(lab, wt, ['rev-parse', 'side'])).toBe(res.commit);
    expect(fx(lab, repo, ['rev-list', '--count', 'main'])).toBe('1');
    expect(fx(lab, wt, ['status', '--short'])).toBe('');
  });

  it('spawns only allowlisted verbs across preflight, identity, containment, commit and reconcile', async () => {
    const repo = initRepo(lab);
    const verbs = new Set<string>();
    const calls: string[][] = [];
    setGitSpawnObserver((v, a) => {
      verbs.add(v);
      calls.push([...a]);
    });
    const { ctx, info } = await preflight(repo);
    await requireCommitIdentity(ctx);
    await readRemotes(ctx);
    await exportFiles(ctx, info, { '.northkeep-mirror': markerBytes(VAULT), 'projects/demo.md': '# d\n' });
    const { ctx: c2, info: i2 } = await preflight(repo);
    await exportFiles(c2, i2, { 'projects/demo.md': '# d2\n' });
    expect([...verbs].sort()).toEqual(
      ['commit-tree', 'hash-object', 'ls-tree', 'read-tree', 'remote', 'rev-parse', 'update-index', 'update-ref', 'var', 'worktree', 'write-tree'].sort(),
    );
    for (const a of calls) {
      expect(['push', 'fetch', 'ls-remote', 'add', 'commit', 'status', 'diff', 'checkout']).not.toContain(a[0]);
      if (a[0] === 'hash-object') expect(a).toContain('--no-filters');
    }
  });
});

describe('requireCommitIdentity and readRemotes', () => {
  it('refuses a repository with no identity, naming the two commands to run inside the mirror', async () => {
    const repo = initRepo(lab, 'noid', false);
    const ctx = ctxFor(lab, repo);
    const err = await expectRefusal(requireCommitIdentity(ctx), 'no_identity');
    expect(err.message).toContain('ignores your global git settings');
    expect(err.message).toContain(`git -C '${ctx.repo}' config user.name`);
    expect(err.message).toContain(`git -C '${ctx.repo}' config user.email`);
  });

  it('lists remotes read-only and drops credentials from an https URL', async () => {
    const repo = initRepo(lab);
    fx(lab, repo, ['remote', 'add', 'origin', 'https://user:secret-token@example.invalid/o/m.git']);
    fx(lab, repo, ['remote', 'add', 'backup', path.join(lab.root, 'bare.git')]);
    const remotes = await readRemotes(ctxFor(lab, repo));
    expect(remotes).toEqual(
      expect.arrayContaining([
        { name: 'origin', url: 'https://example.invalid/o/m.git' },
        { name: 'backup', url: path.join(lab.root, 'bare.git') },
      ]),
    );
    expect(remotes).toHaveLength(2);
    expect(JSON.stringify(remotes)).not.toContain('secret-token');
  });
});

describe('a hostile repository', () => {
  it('runs no program the repository names during a full export, and each plant fires without the pins', async () => {
    const repo = initRepo(lab);
    await firstExport(repo);
    const fired = path.join(lab.root, 'fired');
    fs.writeFileSync(fired, '');
    const canDir = path.join(lab.root, 'can');
    fs.mkdirSync(canDir);
    const can = (name: string) => {
      const p = path.join(canDir, name.replace(/[^A-Za-z0-9._-]/g, '_'));
      fs.writeFileSync(p, `#!/bin/sh\necho "${name}" >> "${fired}"\nexit 0\n`, { mode: 0o755 });
      return p;
    };
    const hooksDir = path.join(lab.root, 'hk');
    fs.mkdirSync(hooksDir);
    for (const h of ['reference-transaction', 'post-index-change', 'pre-commit', 'post-commit']) {
      fs.copyFileSync(can(`hook:hooksPath/${h}`), path.join(hooksDir, h));
      fs.chmodSync(path.join(hooksDir, h), 0o755);
      fs.copyFileSync(can(`hook:.git/hooks/${h}`), path.join(repo, '.git', 'hooks', h));
      fs.chmodSync(path.join(repo, '.git', 'hooks', h), 0o755);
    }
    fx(lab, repo, ['config', 'filter.evil.clean', can('filter.evil.clean')]);
    fx(lab, repo, ['config', 'filter.evil.smudge', can('filter.evil.smudge')]);
    fx(lab, repo, ['config', 'core.fsmonitor', can('core.fsmonitor')]);
    fx(lab, repo, ['config', 'gpg.program', can('gpg.program')]);
    fx(lab, repo, ['config', 'commit.gpgsign', 'true']);
    fx(lab, repo, ['config', 'core.hooksPath', hooksDir]);
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'projects/demo.md filter=evil\n');
    // A replace ref on HEAD's tree: under GIT_NO_REPLACE_OBJECTS the real tree is read.
    const realTree = fx(lab, repo, ['rev-parse', 'HEAD^{tree}']);
    const foreign = fx(lab, repo, ['mktree'], '');
    fx(lab, repo, ['replace', '-f', realTree, foreign]);
    // Fixture setup above runs ordinary git, which fires the armed hooks; only the product run counts.
    fs.writeFileSync(fired, '');

    const { ctx, info } = await preflight(repo);
    await requireCommitIdentity(ctx);
    const res = await exportFiles(ctx, info, { 'projects/demo.md': '# hostile run\n' });
    expect(res.status).toBe('committed');
    expect(fs.readFileSync(fired, 'utf8')).toBe('');
    expect(await headBlob(ctx, 'INDEX.md')).not.toBeNull();
    expect(await hashFile(ctx, path.join(ctx.repo, 'projects/demo.md'))).toBe(await headBlob(ctx, 'projects/demo.md'));

    // Controls: the same repository, ordinary git, fires the plants.
    const plain = (args: string[]) => {
      try {
        fx(lab, repo, args);
      } catch {
        /* a failing canary (gpg) is still a fired canary */
      }
    };
    plain(['hash-object', '--', 'projects/demo.md']);
    plain(['update-ref', 'refs/canary/control', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'x.txt'), 'x');
    plain(['add', 'x.txt']);
    plain(['commit', '-q', '-m', 'control']);
    const firedNow = fs.readFileSync(fired, 'utf8');
    for (const want of ['filter.evil.clean', 'hook:hooksPath/reference-transaction', 'gpg.program']) {
      expect(firedNow, want).toContain(want);
    }
    // Replace-ref control: plain git reads the empty stand-in for the parent's tree, which our commit did not.
    expect(fx(lab, repo, ['ls-tree', `${res.commit}^`])).toBe('');
  });
});
