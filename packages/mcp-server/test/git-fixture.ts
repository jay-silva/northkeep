import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitContext } from '../src/git-plumbing.js';

/**
 * Fixture git for the ADR 0053 tests. Setup runs git with an isolated
 * environment (its own HOME, no system or global config) so the developer's
 * ~/.gitconfig, signing or hooks never reach a fixture. Every repository lives
 * under a mkdtemp directory the test owns and removes.
 */
export interface Lab {
  root: string;
  home: string;
  vaultPath: string;
  fixtureHome: string;
  cleanup(): void;
}

export function makeLab(prefix = 'nk-git-'): Lab {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, 'nkhome');
  const fixtureHome = path.join(root, 'fixturehome');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fixtureHome, { recursive: true });
  fs.writeFileSync(path.join(fixtureHome, 'empty.gitconfig'), '');
  process.env.NORTHKEEP_HOME = home;
  return {
    root,
    home,
    vaultPath: path.join(home, 'vault.nkv'),
    fixtureHome,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * `git commit` starts `git maintenance run --auto --detach`, which holds
 * objects/maintenance.lock (and may repack) after commit returns. That
 * daemon raced verifyReadOnly's snapshot in CI, so fixture git never runs it.
 */
const NO_AUTO_MAINTENANCE = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

export function fx(lab: Lab, cwd: string, args: string[], input?: string): string {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...NO_AUTO_MAINTENANCE, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: lab.fixtureHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(lab.fixtureHome, 'empty.gitconfig'),
    },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).replace(/\n$/, '');
}

/** An empty repository with an identity and an unborn HEAD. */
export function initRepo(lab: Lab, name = 'mirror', identity = true): string {
  const dir = path.join(lab.root, name);
  fs.mkdirSync(dir, { recursive: true });
  fx(lab, dir, ['init', '-q', '-b', 'main']);
  if (identity) {
    fx(lab, dir, ['config', 'user.name', 'Tester']);
    fx(lab, dir, ['config', 'user.email', 'tester@example.invalid']);
  }
  return dir;
}

export function ctxFor(lab: Lab, repo: string): GitContext {
  return { repo: fs.realpathSync(repo), home: lab.home, vaultPath: lab.vaultPath };
}

/** Stand-in for core's parseMirrorHeader: `<!-- northkeep: vault <id> ... kind <kind>`. */
export function parseMarkerStub(bytes: Uint8Array): { vaultId: string; kind: string } | null {
  const m = /^<!-- northkeep: vault (\S+) .*?kind (\S+)/.exec(Buffer.from(bytes).toString('utf8'));
  return m ? { vaultId: m[1] as string, kind: m[2] as string } : null;
}

export function markerBytes(vaultId: string): Buffer {
  return Buffer.from(`<!-- northkeep: vault ${vaultId} kind marker\n     This folder is a NorthKeep mirror. -->\n`);
}
