import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain Node script without type declarations
import { checkLinks, checkVersions } from '../check-drift.mjs';

const script = join(__dirname, '..', 'check-drift.mjs');
const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nk-drift-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function release(v: { desktop?: string; web?: string; mobile?: string; readme?: string; site?: string }) {
  const d = v.desktop ?? '1.2.0';
  const site = v.site ?? d;
  return {
    'apps/desktop/src-tauri/tauri.conf.json': JSON.stringify({ productName: 'NorthKeep', version: d }),
    'apps/web/src/api.ts': `const APP_VERSION = '${v.web ?? d}';\n`,
    'apps/mobile/app.config.ts': `export default {\n  version: '${v.mobile ?? d}',\n  ios: { buildNumber: '9' },\n};\n`,
    'README.md': `# App\n\nThe current download is ${v.readme ?? d}.\n`,
    'site/index.html': `<a href="https://github.com/o/r/releases/download/v${site}/NorthKeep_${site}_aarch64.dmg">Get</a>`,
  };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('version drift', () => {
  it('passes when every release string agrees', () => {
    expect(checkVersions(repo(release({}))).problems).toEqual([]);
  });

  it('names the web constant when it disagrees with the desktop release', () => {
    const { problems } = checkVersions(repo(release({ web: '1.1.0' })));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('apps/web/src/api.ts says APP_VERSION 1.1.0');
  });

  it('flags a stale README download line', () => {
    const { problems } = checkVersions(repo(release({ readme: '0.9.4' })));
    expect(problems[0]).toContain('README.md says "The current download is 0.9.4"');
  });

  it('flags site download links that point at another release', () => {
    const { problems } = checkVersions(repo(release({ site: '1.1.0' })));
    expect(problems[0]).toContain('site/index.html links to the v1.1.0 download');
  });

  it('lets the iPhone version lag the desktop release, with a note', () => {
    const result = checkVersions(repo(release({ mobile: '1.1.0' })));
    expect(result.problems).toEqual([]);
    expect(result.notes[0]).toContain('may lag');
  });

  it('refuses an iPhone version ahead of the desktop release', () => {
    const { problems } = checkVersions(repo(release({ mobile: '1.10.0', desktop: '1.9.0' })));
    expect(problems[0]).toContain('ahead of the desktop release 1.9.0');
  });
});

describe('dead file references in Markdown', () => {
  it('reports a relative link to a missing file and accepts a present one', () => {
    const root = repo({
      'docs/a.md': '[ok](./b.md) and [gone](../SPEC/nope.md#part) and [web](https://x.test/y.md) and [top](#here)\n',
      'docs/b.md': '# B\n',
    });
    expect(checkLinks(root, { exclude: [] }).problems).toEqual([
      'docs/a.md:1 refers to ../SPEC/nope.md#part, which does not exist in the repo.',
    ]);
  });

  it('reports backticked and bare upper-case doc names that exist nowhere', () => {
    const root = repo({
      'CLAUDE.md': 'Per `03-BUILD-BLUEPRINT.md` and 07-PLAN.md, see `KNOWN-LIMITS.md`.\n',
      'KNOWN-LIMITS.md': '# Limits\n',
    });
    const { problems } = checkLinks(root, { exclude: [] });
    expect(problems).toEqual([
      'CLAUDE.md:1 refers to 03-BUILD-BLUEPRINT.md, which does not exist in the repo.',
      'CLAUDE.md:1 refers to 07-PLAN.md, which does not exist in the repo.',
    ]);
  });

  it('checks repo paths from a top-level folder against the repo root', () => {
    const root = repo({
      'SPEC/decisions/0001-x.md': 'See `SPEC/security-model.md` and packages/core/src/gone.ts:12.\n',
      'SPEC/security-model.md': '# S\n',
    });
    expect(checkLinks(root, { exclude: [] }).problems).toEqual([
      'SPEC/decisions/0001-x.md:1 refers to packages/core/src/gone.ts, which does not exist in the repo.',
    ]);
  });

  it('ignores fenced code, runtime file names, placeholders and links shown as code', () => {
    const root = repo({
      'README.md': [
        '```',
        '[dead](missing.md) `SPEC/missing.md`',
        '```',
        'Edit `mcp.json` or `~/.codex/AGENTS.md`; write `projects/<slug>.md`; `[text](url)` renders as text.',
        'The mirror holds `INDEX.md`.',
      ].join('\n'),
    });
    expect(checkLinks(root, { exclude: [] }).problems).toEqual([]);
  });

  it('counts only tracked files in a git checkout, as CI sees them', () => {
    const root = repo({ 'README.md': 'See [notes](./NOTES.md) and [guide](./GUIDE.md).\n', 'GUIDE.md': '# G\n' });
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    git('add', 'README.md', 'GUIDE.md');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(root, 'NOTES.md'), '# untracked\n');
    expect(checkLinks(root, { exclude: [] }).problems).toEqual([
      'README.md:1 refers to ./NOTES.md, which does not exist in the repo.',
    ]);
  });

  it('skips excluded history folders', () => {
    const root = repo({ 'docs/design/old.md': '[gone](./missing.md)\n' });
    expect(checkLinks(root).problems).toEqual([]);
    expect(checkLinks(root, { exclude: [] }).problems).toHaveLength(1);
  });
});

describe('command line', () => {
  it('exits 1 with a plain message on drift and 0 when clean', () => {
    const bad = spawnSync(process.execPath, [script, repo(release({ readme: '0.1.0' }))], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Drift check failed with 1 problem(s)');
    const good = spawnSync(process.execPath, [script, repo(release({}))], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('Drift check passed');
  });
});
