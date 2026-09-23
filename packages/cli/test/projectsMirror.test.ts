import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, deriveMasterKey, generateDeviceSecret, listProjectViews, withFileLock } from '@northkeep/core';
import { ExportRefusal, readExportSettings, readExportState, type VaultRunner } from '@northkeep/mcp-server';
import { describeMirrorError, projectsExportCmd, projectsImportCmd, type MirrorDeps } from '../src/projectsCmd.js';

/**
 * ADR 0053 M-A1 on the CLI: export, verify, status, schedule, the launchd
 * run and import, each against a temp vault and a temp `git init` folder.
 * Nothing here reaches the Keychain, launchctl, ~/Library or the network.
 */

const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'index.js');
const PASS = 'synthetic cli mirror passphrase';
const ENV_KEYS = ['NORTHKEEP_HOME', 'NORTHKEEP_MASTER_KEY', 'NORTHKEEP_PASSPHRASE'] as const;

let root = '';
let home = '';
let vaultPath = '';
let repo = '';
let keyHex = '';
let savedEnv: Record<string, string | undefined> = {};
let out: string[] = [];
let err: string[] = [];
/** Every human-facing line from every test, for the wording check at the end. */
const allPlain: string[] = [];

/** Fixture git runs with its own HOME and no system or global config, so the developer's settings never apply. */
function git(cwd: string, args: string[]): string {
  const fixtureHome = path.join(root, 'fixturehome');
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: fixtureHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fixtureHome, 'empty.gitconfig') },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Tester']);
  git(dir, ['config', 'user.email', 'tester@example.invalid']);
  return dir;
}

const runner: VaultRunner = (fn) =>
  withFileLock(vaultPath, async () => {
    const v = Vault.openWithKey(vaultPath, Buffer.from(keyHex, 'hex'));
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

async function setStatus(slug: string, status: string): Promise<void> {
  await write((v) => {
    const rev = listProjectViews(v).find((s) => s.project === slug)!.revision!;
    v.updateProject({ project: slug, expected_revision: rev, status });
  });
}

function deps(extra: Partial<MirrorDeps> = {}): MirrorDeps {
  return {
    home,
    vaultPath,
    vaultRunner: async () => runner,
    schedule: { cliEntry: '/nonexistent/northkeep/index.js', plistDir: path.join(root, 'agents'), load: false },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...extra,
  };
}

async function exportCmd(options: Parameters<typeof projectsExportCmd>[0], extra: Partial<MirrorDeps> = {}): Promise<number> {
  out = [];
  err = [];
  const code = await projectsExportCmd(options, deps(extra));
  if (!options.json) allPlain.push(...out, ...err);
  return code;
}

async function importCmd(options: Parameters<typeof projectsImportCmd>[0]): Promise<number> {
  out = [];
  err = [];
  const code = await projectsImportCmd(options, deps());
  if (!options.json) allPlain.push(...out, ...err);
  return code;
}

function commitCount(dir: string): number {
  return Number(git(dir, ['rev-list', '--count', 'HEAD']));
}

/** Path, size and content hash of every file under a folder. */
function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else lines.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-cli-mirror-')));
  home = path.join(root, 'nkhome');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'fixturehome'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixturehome', 'empty.gitconfig'), '');
  process.env.NORTHKEEP_HOME = home;
  delete process.env.NORTHKEEP_MASTER_KEY;
  delete process.env.NORTHKEEP_PASSPHRASE;
  vaultPath = path.join(home, 'vault.nkv');
  const deviceSecret = generateDeviceSecret();
  Vault.create({ path: vaultPath, passphrase: PASS, deviceSecret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(vaultPath);
  keyHex = deriveMasterKey(PASS, deviceSecret, header.salt, header.kdf).toString('hex');
  await write((v) => {
    v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why demo.', status: 'Starting.', log_entry: 'Created.' });
    v.updateProject({ project: 'other', expected_revision: null, what_why: 'Why other.', status: 'Fine.' });
  });
  repo = initRepo('mirror');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('northkeep projects export', () => {
  it('first export records the folder and commits; the second prints no changes and adds no commit', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    expect(out[0]).toBe(`Mirror folder: ${repo}`);
    expect(out).toContain('Wrote projects/demo.md');
    expect(out).toContain('Wrote projects/other.md');
    expect(out.some((l) => /^Committed [0-9a-f]{40}\.$/.test(l))).toBe(true);
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.northkeep-mirror', 'INDEX.md', 'projects']);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'export.json'), 'utf8')).repo).toBe(repo);
    expect(commitCount(repo)).toBe(1);

    const before = snapshot(path.join(repo, 'projects'));
    expect(await exportCmd({})).toBe(0);
    expect(out).toContain('No changes; nothing to commit.');
    expect(out.some((l) => l.startsWith('Wrote '))).toBe(false);
    expect(snapshot(path.join(repo, 'projects'))).toBe(before);
    expect(commitCount(repo)).toBe(1);
    expect(git(repo, ['status', '--short'])).toBe('');
  });

  it('refuses a folder that is not empty on the first run, with a plain reason', async () => {
    const busy = initRepo('busy');
    fs.writeFileSync(path.join(busy, 'notes.txt'), 'mine\n');
    expect(await exportCmd({ repo: busy })).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toBe(
      '✗ A new mirror needs an empty folder after git init: nothing but .git and no commits yet. NorthKeep never takes over a folder that already has files.',
    );
    expect(fs.readFileSync(path.join(busy, 'notes.txt'), 'utf8')).toBe('mine\n');
    expect(fs.existsSync(path.join(home, 'export.json'))).toBe(false);
  });

  it('a hand edit makes export exit 1, names the file, keeps the edit and exports the rest', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    const file = path.join(repo, 'projects', 'demo.md');
    fs.appendFileSync(file, 'note\n');
    const edited = fs.readFileSync(file, 'utf8');
    await setStatus('other', 'Moved on.');
    expect(await exportCmd({})).toBe(1);
    expect(out).toContain('Refused projects/demo.md: hand edit. Move or delete the file; NorthKeep then writes it fresh.');
    expect(out).toContain('Wrote projects/other.md');
    expect(out).toContain('1 path refused; everything else was exported.');
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
  });

  it('an unreadable mirror file is refused by name with fixed text, and the rest exports (a2)', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    const demo = path.join(repo, 'projects', 'demo.md');
    fs.chmodSync(demo, 0o000);
    try {
      await setStatus('other', 'Past the bad file.');
      expect(await exportCmd({})).toBe(1);
      expect(out).toContain('Refused projects/demo.md: unreadable. Check the file permissions; NorthKeep left it as it was.');
      expect(out).toContain('Wrote projects/other.md');
      expect([...out, ...err].join('\n')).not.toContain(demo);
    } finally {
      fs.chmodSync(demo, 0o644);
    }
  });

  it('describes a file-system error with fixed text and no path', () => {
    const e = Object.assign(new Error(`EACCES: permission denied, open '${path.join(root, 'secret', 'x.md')}'`), { code: 'EACCES' });
    const text = describeMirrorError(e);
    expect(text).not.toContain(root);
    expect(text).toContain('EACCES');
  });

  it('prints JSON with --json and rejects mixed modes', async () => {
    expect(await exportCmd({ repo, json: true })).toBe(0);
    expect(JSON.parse(out.join('\n')).status).toBe('committed');
    expect(await exportCmd({ verify: true, status: true })).toBe(1);
    expect(err[0]).toBe('✗ Choose only one of --verify, --status and --schedule.');
    expect(await exportCmd({ verify: true, repo })).toBe(1);
    expect(err[0]).toContain('--repo applies only to a plain export');
  });
});

describe('northkeep projects export --verify', () => {
  it('reports every path as matches and exits 0, then stale after a vault update and exits 1', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    expect(await exportCmd({ verify: true })).toBe(0);
    const pathLines = out.filter((l) => /^[^ ]+: /.test(l) && !l.startsWith('Mirror folder'));
    expect(pathLines.map((l) => l.split(': ')[0]).sort()).toEqual(['.northkeep-mirror', 'INDEX.md', 'projects/demo.md', 'projects/other.md']);
    expect(pathLines.every((l) => l.endsWith(': matches'))).toBe(true);
    expect(out.at(-1)).toBe('All 4 paths match.');

    await setStatus('other', 'Changed in the vault.');
    expect(await exportCmd({ verify: true })).toBe(1);
    expect(out).toContain('projects/other.md: stale');
    expect(out).toContain('projects/demo.md: matches');
    expect(out.at(-1)).toMatch(/^\d of 4 paths match\.$/);
  });

  it('names a hand edit and exits 1', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    fs.appendFileSync(path.join(repo, 'projects', 'demo.md'), 'note\n');
    expect(await exportCmd({ verify: true })).toBe(1);
    expect(out).toContain('projects/demo.md: hand edit');
  });
});

describe('northkeep projects export --status', () => {
  it('shows one project changed since after a vault write, the refusals, and each remote with the push sentence', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    await setStatus('other', 'After the export.');
    const bare = path.join(root, 'bare.git');
    execFileSync('/usr/bin/git', ['init', '-q', '--bare', bare], { env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'fixturehome'), GIT_CONFIG_NOSYSTEM: '1' } });
    git(repo, ['remote', 'add', 'origin', bare]);

    expect(await exportCmd({ status: true })).toBe(0);
    expect(out[0]).toBe(`Mirror folder: ${repo}`);
    expect(out[1]).toMatch(/^Mirror last exported .+; 1 project changed since$/);
    expect(out).toContain('Projects changed since: other');
    expect(out).toContain('Refused paths: none');
    expect(out).toContain('Last failure: none');
    expect(out).toContain(`Remote origin: ${bare}`);
    expect(out.at(-1)).toBe('NorthKeep never pushes; a push you make publishes the mirror.');

    expect(await exportCmd({})).toBe(0);
    expect(out).toContain('Wrote projects/other.md');
    expect(git(bare, ['rev-list', '--all'])).toBe('');
    expect(await exportCmd({ status: true })).toBe(0);
    expect(out[1]).toMatch(/; 0 projects changed since$/);
  });

  it('says when no mirror is configured, without opening the vault', async () => {
    let opened = false;
    expect(await exportCmd({ status: true }, { vaultRunner: async () => ((opened = true), runner) })).toBe(0);
    expect(out).toEqual(['No mirror is configured. Run northkeep projects export --repo <folder> once to start one.']);
    expect(opened).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('northkeep projects export --schedule', () => {
  it('installs the launchd agent into the overridden folder, then removes it with off', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    let opened = false;
    const noVault = { vaultRunner: async () => ((opened = true), runner) };
    expect(await exportCmd({ schedule: 'hourly' }, noVault)).toBe(0);
    const plist = path.join(root, 'agents', 'com.northkeep.mirror-export.plist');
    expect(out[0]).toBe(`Installed the hourly export schedule: ${plist}`);
    expect(out.join('\n')).toContain('northkeep unlock');
    expect(out.join('\n')).toContain('It never pushes.');
    const text = fs.readFileSync(plist, 'utf8');
    expect(text).toContain('<string>--scheduled</string>');
    expect(text).toContain('<key>StartInterval</key>');
    expect(text).toContain('/nonexistent/northkeep/index.js');
    expect(fs.statSync(plist).mode & 0o777).toBe(0o644);

    expect(await exportCmd({ schedule: 'daily' }, noVault)).toBe(0);
    expect(fs.readFileSync(plist, 'utf8')).toContain('<key>StartCalendarInterval</key>');

    expect(await exportCmd({ schedule: 'off' }, noVault)).toBe(0);
    expect(out).toEqual([`Removed the export schedule (${plist}).`]);
    expect(fs.existsSync(plist)).toBe(false);
    expect(await exportCmd({ schedule: 'off' }, noVault)).toBe(0);
    expect(out).toEqual(['No export schedule was installed.']);
    expect(await exportCmd({ schedule: 'weekly' }, noVault)).toBe(1);
    expect(opened).toBe(false);
  });

  it('refuses a vault other than the default, since the job cannot carry --vault', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    expect(await exportCmd({ schedule: 'hourly' }, { vaultPath: path.join(root, 'elsewhere.nkv') })).toBe(1);
    expect(err[0]).toBe(`✗ The schedule exports only the default vault (${path.join(home, 'vault.nkv')}). Run --schedule without --vault.`);
    expect(fs.existsSync(path.join(root, 'agents'))).toBe(false);
  });

  it('refuses to install before a mirror is configured', async () => {
    expect(await exportCmd({ schedule: 'hourly' })).toBe(1);
    expect(err[0]).toContain('No mirror is configured');
    expect(fs.existsSync(path.join(root, 'agents'))).toBe(false);
  });
});

describe('northkeep projects export --scheduled', () => {
  it('commits as northkeep-schedule and prints nothing', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    await setStatus('demo', 'Scheduled change.');
    let opened = false;
    const code = await exportCmd({ scheduled: true }, { vaultRunner: async () => ((opened = true), runner), scheduledRunner: runner });
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(opened).toBe(false);
    expect(git(repo, ['log', '-1', '--format=%s'])).toBe('export: 1 project (northkeep-schedule)');
  });

  it('records a locked vault as a failure, never prompts, prints nothing, and --status shows vault_locked', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    let prompted = false;
    const locked: VaultRunner = async () => {
      throw new ExportRefusal('vault_locked', 'The vault is locked; run northkeep unlock, then export again');
    };
    const code = await exportCmd(
      { scheduled: true },
      {
        vaultRunner: async () => {
          prompted = true;
          throw new Error('the scheduled run must not ask for a passphrase');
        },
        scheduledRunner: locked,
      },
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(prompted).toBe(false);
    const vaultId = await runner((v) => v.getVaultId());
    const state = readExportState(home, repo, vaultId, readExportSettings(home)?.mirror_id ?? null)!;
    expect(state.last_failure?.code).toBe('vault_locked');
    expect(state.last_attempt?.by).toBe('schedule');

    expect(await exportCmd({ status: true })).toBe(0);
    expect(out.find((l) => l.startsWith('Last failure: '))).toMatch(/^Last failure: .+, vault_locked \(the vault was locked; run northkeep unlock/);
    expect(out[1]).toContain('last export failed');
  });
});

describe('northkeep projects export --scheduled, refused at the lock', () => {
  it('records an unreadable export lock and --status shows it as the last failure', async () => {
    expect(await exportCmd({ repo })).toBe(0);
    fs.writeFileSync(path.join(repo, '.git', 'northkeep-export.lock'), 'not json, owner unknown\n');
    const code = await exportCmd({ scheduled: true }, { scheduledRunner: runner, scheduledLockWaitMs: 100 });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(await exportCmd({ status: true })).toBe(0);
    expect(out.find((l) => l.startsWith('Last failure: '))).toMatch(/^Last failure: .+, lock_unreadable \(the export lock file was unreadable; /);
  }, 60_000);
});

describe('northkeep projects import', () => {
  /** Shaped like the command repo's projects folder: one file per project, plus a template. */
  function commandRepoCopy(): string {
    const dir = path.join(root, 'cr', 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'alpha.md'),
      '# Alpha\n\n## What & Why\n\nA test project.\n\n## Current Status\n\nIn progress, as of 2026-09-01.\n\n' +
        '## Next Actions\n\n- Ship it\n\n## Open Questions / Risks\n\n- None yet\n\n## Log\n\n- 2026-09-01: Started.\n- 2026-09-02: Continued.\n',
    );
    fs.writeFileSync(path.join(dir, 'beta-str.md'), '# Beta\n\n## What & Why\n\nSecond.\n\n## Current Status\n\nPaused.\n');
    fs.writeFileSync(path.join(dir, '_TEMPLATE.md'), '# Template\n\n## What & Why\n\n...\n');
    return dir;
  }

  it('dry run prints the plan and changes neither the source nor the vault; --write imports; a second --write is refused by name', async () => {
    const src = commandRepoCopy();
    const srcBefore = snapshot(path.join(root, 'cr'));
    const vaultBefore = fs.readFileSync(vaultPath);
    let opened = false;
    out = [];
    err = [];
    const dry = await projectsImportCmd({ from: src }, { ...deps(), vaultRunner: async () => ((opened = true), runner) });
    allPlain.push(...out, ...err);
    expect(dry).toBe(0);
    // Opened read only, to report taken slugs; the vault file is unchanged below.
    expect(opened).toBe(true);
    expect(out.find((l) => l.startsWith('Would import alpha.md as alpha: '))).toMatch(
      /bytes, 0 log archives, no overflow, Open Questions \/ Risks stored as Open Questions/,
    );
    expect(out.some((l) => l.startsWith('Would import beta-str.md as beta-str: '))).toBe(true);
    expect(out.find((l) => l.startsWith('Skip _TEMPLATE.md: '))).toContain('not a project slug');
    expect(out.at(-2)).toMatch(/^Largest row: [\d,]+ bytes \(limit 60,000\)\. Total: [\d,]+ bytes of the 4,194,304-byte sync limit\.$/);
    expect(out.at(-1)).toBe('Dry run: 2 files would be imported, 0 already in the vault, 0 refused, 1 skipped. Nothing was written; add --write to import.');
    expect(snapshot(path.join(root, 'cr'))).toBe(srcBefore);
    expect(fs.readFileSync(vaultPath).equals(vaultBefore)).toBe(true);

    expect(await importCmd({ from: src, write: true })).toBe(0);
    expect(out.some((l) => l.startsWith('Imported alpha.md as alpha: '))).toBe(true);
    expect(out.at(-1)).toBe('Imported 2 projects; 0 refused, 1 skipped.');
    expect(await runner((v) => listProjectViews(v).map((s) => s.project))).toEqual(['alpha', 'beta-str', 'demo', 'other']);
    expect(snapshot(path.join(root, 'cr'))).toBe(srcBefore);

    expect(await importCmd({ from: src, write: true })).toBe(1);
    expect(out.find((l) => l.startsWith('Refused alpha.md (alpha): '))).toContain('Project alpha already has entries in this vault; delete the project from the Projects page first.');
    expect(out.at(-1)).toBe('Imported 0 projects; 2 refused, 1 skipped.');
  });

  it('the dry run names a taken slug and a non-UTF-8 file, and counts both (F1, S2)', async () => {
    const dir = path.join(root, 'mixed');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'demo.md'), '## Current Status\n\nAlready here.\n');
    fs.writeFileSync(path.join(dir, 'cp.md'), Buffer.from([...Buffer.from('## Current Status\n\nCaf'), 0xe9, 0x0a]));
    fs.writeFileSync(path.join(dir, 'fresh.md'), '## Current Status\n\nNew.\n');
    const vaultBefore = fs.readFileSync(vaultPath);
    expect(await importCmd({ from: dir })).toBe(0);
    expect(out).toContain('Refused cp.md: not UTF-8; convert it first.');
    expect(out).toContain('Exists demo.md (demo): Project demo already has entries in this vault; delete the project from the Projects page first.');
    expect(out.at(-1)).toBe('Dry run: 1 file would be imported, 1 already in the vault, 1 refused, 0 skipped. Nothing was written; add --write to import.');
    expect(fs.readFileSync(vaultPath).equals(vaultBefore)).toBe(true);
  });

  it('names headings the dry run does not recognize, including one split out of a code fence', async () => {
    const dir = path.join(root, 'fenced');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'gamma.md'),
      '# Gamma\n\n## What & Why\n\nWhy.\n\n```\n## Not a heading\n```\n\n## Current Status\n\nOk.\n\n## Custom\n\nMine.\n',
    );
    expect(await importCmd({ from: dir })).toBe(0);
    expect(out[0]).toMatch(/^Would import gamma\.md as gamma: .*, other sections: Not a heading, Custom$/);
  });

  it('refuses a folder that does not exist', async () => {
    expect(await importCmd({ from: path.join(root, 'nope') })).toBe(1);
    expect(err).toEqual(['✗ The import folder does not exist or is not a folder.']);
  });
});

describe('the real CLI process', () => {
  function cli(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [CLI_DIST, '--vault', vaultPath, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'fixturehome'), NORTHKEEP_HOME: home, NORTHKEEP_MASTER_KEY: keyHex, ...extraEnv },
      encoding: 'utf8',
      timeout: 60_000,
    });
    allPlain.push(...r.stdout.split('\n'), ...r.stderr.split('\n'));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('creates a project with projects update, exports, and verify exits 0 clean and 1 after a hand edit', () => {
    const created = cli(['projects', 'update', 'third', '--what-why', 'Why third.', '--status', 'New.']);
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/Created project third/);
    expect(cli(['projects', 'update', 'third', '--log', 'Did a thing.']).stdout).toMatch(/Updated project third/);

    const first = cli(['projects', 'export', '--repo', repo]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Wrote projects/third.md');
    expect(cli(['projects', 'export']).stdout).toContain('No changes; nothing to commit.');
    const clean = cli(['projects', 'export', '--verify']);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('projects/third.md: matches');

    fs.appendFileSync(path.join(repo, 'projects', 'third.md'), 'note\n');
    const dirty = cli(['projects', 'export', '--verify']);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toContain('projects/third.md: hand edit');
    expect(cli(['projects', 'export']).status).toBe(1);
  });

  it('hides --scheduled and --skip-launchctl from help', () => {
    const help = cli(['projects', 'export', '--help']);
    expect(help.stdout).toContain('--verify');
    expect(help.stdout).not.toContain('--scheduled');
    expect(help.stdout).not.toContain('--skip-launchctl');
  });

  it('--schedule writes into NORTHKEEP_LAUNCH_AGENTS_DIR and --skip-launchctl loads nothing (S1)', () => {
    if (process.platform !== 'darwin') return;
    expect(cli(['projects', 'export', '--repo', repo]).status).toBe(0);
    const agents = path.join(root, 'agents-env');
    const env = { NORTHKEEP_LAUNCH_AGENTS_DIR: agents };
    const on = cli(['projects', 'export', '--schedule', 'hourly', '--skip-launchctl'], env);
    expect(on.stderr).toBe('');
    expect(on.status).toBe(0);
    expect(fs.readdirSync(agents)).toEqual(['com.northkeep.mirror-export.plist']);
    expect(fs.readFileSync(path.join(agents, 'com.northkeep.mirror-export.plist'), 'utf8')).toContain('<string>--scheduled</string>');
    expect(fs.existsSync(path.join(root, 'fixturehome', 'Library'))).toBe(false);
    const off = cli(['projects', 'export', '--schedule', 'off', '--skip-launchctl'], env);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('Removed the export schedule');
    expect(fs.readdirSync(agents)).toEqual([]);
  });
});

describe('wording', () => {
  // Runs last in this file: every human-facing line above, checked for plain sentences.
  it('has no em dash and none of the internal words in normal output', () => {
    const text = allPlain.join('\n');
    expect(allPlain.length).toBeGreaterThan(50);
    expect(text).not.toContain('\u2014');
    expect(text).not.toMatch(/\b(blob|journal)\b/i);
  });
});
