import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { FileLockTimeoutError, withFileLock } from '../src/lock.js';

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-lock-'));
  target = path.join(dir, 'vault.nkv');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Makes the lock file look `ms` old. */
const age = (ms: number) => {
  const old = (Date.now() - ms) / 1000;
  fs.utimesSync(`${target}.lock`, old, old);
};

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

  it('takes a lock with no readable owner once it is older than the stale age', async () => {
    fs.writeFileSync(`${target}.lock`, 'dead-process');
    const old = Date.now() - 120_000;
    fs.utimesSync(`${target}.lock`, old / 1000, old / 1000);
    let ran = false;
    await withFileLock(target, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('never takes over a lock whose owner is still running, however old (ADR 0097 D1)', async () => {
    const live = `${process.pid} 2026-01-02T03:04:05.000Z abc -\n`;
    fs.writeFileSync(`${target}.lock`, live);
    age(300_000);
    let ran = false;
    const err = await withFileLock(target, () => void (ran = true), { timeoutMs: 200 }).then(() => null, (e: Error) => e);
    expect([ran, err instanceof FileLockTimeoutError]).toEqual([false, true]);
    expect(err!.message).toContain(`It is held by process ${process.pid} (`);
    expect(err!.message).toContain('since 2026-01-02T03:04:05.000Z. Quit that app and try again.');
    expect(fs.readFileSync(`${target}.lock`, 'utf8')).toBe(live);
  });

  it('still takes an old lock from a running owner when the caller asks for that (the sync lock)', async () => {
    fs.writeFileSync(`${target}.lock`, `${process.pid} 2026-01-02T03:04:05.000Z abc -\n`);
    age(300_000);
    let ran = false;
    await withFileLock(target, () => void (ran = true), { timeoutMs: 200, staleMs: 60_000, takeOverLiveOwner: true });
    expect(ran).toBe(true);
  });

  it('takes a fresh lock at once when its owner has exited', async () => {
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(`${target}.lock`, `${gone} ${new Date().toISOString()} abc -\n`);
    let ran = false;
    await withFileLock(target, () => void (ran = true), { timeoutMs: 200 });
    expect(ran).toBe(true);
  });

  it('takes a fresh lock at once when it names another start of the machine, even with a live pid', async () => {
    fs.writeFileSync(`${target}.lock`, `${process.pid} ${new Date().toISOString()} abc 00000000-0000-4000-8000-000000000000\n`);
    let ran = false;
    await withFileLock(target, () => void (ran = true), { timeoutMs: 200 });
    expect(ran).toBe(true);
  });

  it('a fresh lock with no readable owner blocks, and is left as it was', async () => {
    fs.writeFileSync(`${target}.lock`, '');
    const err = await withFileLock(target, () => undefined, { timeoutMs: 200 }).then(() => null, (e: Error) => e);
    expect(err instanceof FileLockTimeoutError).toBe(true);
    expect(err!.message).toContain('Quit the other NorthKeep app and try again.');
    expect(fs.readFileSync(`${target}.lock`, 'utf8')).toBe('');
  });

  it('gives up at the deadline, and does not spin, when the lock path cannot be read', async () => {
    fs.mkdirSync(`${target}.lock`);
    const started = Date.now();
    const err = await withFileLock(target, () => undefined, { timeoutMs: 200 }).then(() => null, (e: Error) => e);
    expect(err instanceof FileLockTimeoutError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.statSync(`${target}.lock`).isDirectory()).toBe(true);

    // Aged past the stale limit it still cannot be compared, so it is still not taken.
    age(300_000);
    const again = await withFileLock(target, () => undefined, { timeoutMs: 200 }).then(() => null, (e: Error) => e);
    expect(again instanceof FileLockTimeoutError).toBe(true);
    fs.rmdirSync(`${target}.lock`);
  });

  it('writes its lock complete, pid first, with this start of the machine, and leaves no stray files', async () => {
    let token = '';
    await withFileLock(target, () => void (token = fs.readFileSync(`${target}.lock`, 'utf8')));
    const fields = token.trimEnd().split(' ');
    expect(fields).toHaveLength(4);
    expect(fields[0]).toBe(String(process.pid));
    expect(fields[3]).toMatch(/^[0-9A-Fa-f-]{8,64}$/);
    expect(token.endsWith('\n')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('eight callers racing for one dead lock run one at a time', async () => {
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(`${target}.lock`, `${gone} ${new Date().toISOString()} abc -\n`);
    let inside = 0;
    let most = 0;
    let ran = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(target, async () => {
          inside += 1;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 5));
          inside -= 1;
          ran += 1;
        }),
      ),
    );
    expect([most, ran]).toEqual([1, 8]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not remove a lock that was replaced while it ran', async () => {
    const other = `${process.pid} ${new Date().toISOString()} someone-else -\n`;
    await withFileLock(target, () => fs.writeFileSync(`${target}.lock`, other));
    expect(fs.readFileSync(`${target}.lock`, 'utf8')).toBe(other);
  });
});
