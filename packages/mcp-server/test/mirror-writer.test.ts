import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIRROR_TEMP_PATTERN, cleanStaleMirrorTemps, writeMirrorFile } from '../src/fs-safe.js';

const DIST = path.resolve(__dirname, '../dist/fs-safe.js');
const TEMP = /^root\.md\.northkeep-tmp-[0-9a-f]{16}$/;

let dir: string;
let proj: string;
let target: string;
let outside: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-writer-')));
  proj = path.join(dir, 'repo', 'projects');
  fs.mkdirSync(proj, { recursive: true });
  target = path.join(proj, 'root.md');
  outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE ORIGINAL\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeMirrorFile', () => {
  it('writes the bytes at 0o644 through a unique temp and leaves no temp behind', () => {
    writeMirrorFile(target, Buffer.from('VERSION 1\n'));
    expect(fs.readFileSync(target, 'utf8')).toBe('VERSION 1\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    writeMirrorFile(target, Buffer.from('VERSION 2\n'));
    expect(fs.readFileSync(target, 'utf8')).toBe('VERSION 2\n');
    expect(fs.readdirSync(proj)).toEqual(['root.md']);
  });

  it('replaces a symlinked target with a regular file instead of writing through it', () => {
    fs.symlinkSync(outside, target);
    writeMirrorFile(target, Buffer.from('MINE\n'));
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE ORIGINAL\n');
  });

  it('refuses when anything sits at its temp path and never follows a planted link there', () => {
    const fixed = Buffer.from('aaaaaaaaaaaaaaaa', 'hex');
    vi.spyOn(crypto, 'randomBytes').mockImplementation((() => fixed) as never);
    const tmp = `${target}.northkeep-tmp-${fixed.toString('hex')}`;
    fs.symlinkSync(outside, tmp);
    expect(() => writeMirrorFile(target, Buffer.from('ESCAPE\n'))).toThrow(/temp path already exists/);
    fs.rmSync(tmp);
    fs.symlinkSync(path.join(dir, 'absent.txt'), tmp);
    expect(() => writeMirrorFile(target, Buffer.from('ESCAPE\n'))).toThrow(/temp path already exists/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE ORIGINAL\n');
    expect(fs.existsSync(path.join(dir, 'absent.txt'))).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(tmp).isSymbolicLink()).toBe(true);
  });

  it('unlinks only its own temp when the rename fails', () => {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    expect(() => writeMirrorFile(target, Buffer.from('X\n'))).toThrow();
    expect(fs.readdirSync(proj)).toEqual(['root.md']);
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('x');
  });
});

describe('cleanStaleMirrorTemps', () => {
  it('unlinks exact-pattern files and symlinks without following, and keeps everything else', () => {
    fs.writeFileSync(target, 'CURRENT\n');
    fs.symlinkSync(outside, `${target}.northkeep-tmp-0123456789abcdef`);
    fs.symlinkSync(path.join(dir, 'absent.txt'), `${target}.northkeep-tmp-fedcba9876543210`);
    fs.writeFileSync(`${target}.northkeep-tmp-00000000000000aa`, 'partial');
    fs.writeFileSync(`${target}.northkeep-tmp-notmine`, 'not ours\n');
    fs.writeFileSync(`${target}.northkeep-tmp-ABCDEF0123456789`, 'uppercase is not ours\n');
    fs.writeFileSync(`${target}.northkeep-tmp`, 'atomicWrite name, not ours\n');
    fs.mkdirSync(`${target}.northkeep-tmp-1111111111111111`);
    const removed = cleanStaleMirrorTemps(proj).sort();
    expect(removed).toEqual(
      [
        'root.md.northkeep-tmp-00000000000000aa',
        'root.md.northkeep-tmp-0123456789abcdef',
        'root.md.northkeep-tmp-fedcba9876543210',
      ].sort(),
    );
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE ORIGINAL\n');
    expect(fs.existsSync(path.join(dir, 'absent.txt'))).toBe(false);
    expect(fs.readdirSync(proj).sort()).toEqual(
      [
        'root.md',
        'root.md.northkeep-tmp',
        'root.md.northkeep-tmp-ABCDEF0123456789',
        'root.md.northkeep-tmp-1111111111111111',
        'root.md.northkeep-tmp-notmine',
      ].sort(),
    );
    expect(MIRROR_TEMP_PATTERN.test('x.northkeep-tmp-0123456789abcdef')).toBe(true);
    expect(MIRROR_TEMP_PATTERN.test('.northkeep-tmp-0123456789abcdef')).toBe(false);
  });

  it('returns nothing for a missing folder', () => {
    expect(cleanStaleMirrorTemps(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('a killed write heals on the next run', () => {
  it('leaves one temp and the old target after SIGKILL, and the next run removes it and writes', () => {
    expect(fs.existsSync(DIST), 'build @northkeep/mcp-server first').toBe(true);
    fs.writeFileSync(target, 'VERSION 2\n');
    const script = `import { writeMirrorFile } from ${JSON.stringify(DIST)};
writeMirrorFile(${JSON.stringify(target)}, Buffer.from('VERSION 3\\n'));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: '/usr/bin:/bin', NORTHKEEP_EXPORT_CRASH_WRITE: '1' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.signal).toBe('SIGKILL');
    const left = fs.readdirSync(proj).filter((n) => TEMP.test(n));
    expect(left).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('VERSION 2\n');
    expect(fs.statSync(path.join(proj, left[0] as string)).mode & 0o777).toBe(0o644);
    expect(cleanStaleMirrorTemps(proj)).toEqual(left);
    writeMirrorFile(target, Buffer.from('VERSION 3\n'));
    expect(fs.readFileSync(target, 'utf8')).toBe('VERSION 3\n');
    expect(fs.readdirSync(proj)).toEqual(['root.md']);
  });
});
