import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/lock.js';

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-lock-'));
  target = path.join(dir, 'vault.nkv');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('holds the lock during fn and releases after', async () => {
    await withFileLock(target, () => {
      expect(fs.existsSync(`${target}.lock`)).toBe(true);
    });
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });

  it('releases the lock even when fn throws', async () => {
    await expect(withFileLock(target, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });

  it('serializes concurrent critical sections', async () => {
    const order: string[] = [];
    const first = withFileLock(target, async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push('first-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let first acquire
    const second = withFileLock(target, () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('steals a stale lock', async () => {
    fs.writeFileSync(`${target}.lock`, 'dead-process');
    const old = Date.now() - 120_000;
    fs.utimesSync(`${target}.lock`, old / 1000, old / 1000);
    let ran = false;
    await withFileLock(target, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
