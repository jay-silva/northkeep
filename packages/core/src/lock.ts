import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Advisory lock around every open→mutate→save cycle: the vault is whole-file,
 * so two concurrent cycles would drop one writer's changes. ADR 0097: a lock
 * whose owner is still running is never taken over.
 */
const STALE_MS = 60_000;
const TIMEOUT_MS = 5_000;
const RETRY_MS = 50;
/** A steal takes milliseconds; a guard older than this was left by a killed stealer. */
const GUARD_STALE_MS = 10_000;

/** The lock was held by someone else for longer than the caller was willing to wait. */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, holder = '') {
    super(
      `Vault is locked by another NorthKeep process (${lockPath}). ` +
        (holder === ''
          ? 'Quit the other NorthKeep app and try again.'
          : `It is held by ${holder}. Quit that app and try again. If it is not a NorthKeep app, delete the lock file and retry.`),
    );
    this.name = 'FileLockTimeoutError';
  }
}

let cachedBootId: string | null = null;

/**
 * An identity for this start of the machine, so a lock from before a restart
 * reads as dead even when its pid is in use again. Not derived from the clock,
 * which can be set. '' when the platform offers none.
 */
function bootId(): string {
  if (cachedBootId !== null) return cachedBootId;
  let id = '';
  try {
    if (process.platform === 'darwin') {
      id = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2_000 }).trim();
    } else if (process.platform === 'linux') {
      id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    }
  } catch {
    id = '';
  }
  cachedBootId = /^[0-9A-Fa-f-]{8,64}$/.test(id) ? id : '';
  return cachedBootId;
}

interface LockToken {
  pid: number;
  since: string;
  boot: string;
}

/** The pid stays the first field: older builds and git-plumbing read it there. */
function parseToken(text: string): LockToken | null {
  const fields = text.trim().split(' ');
  const pid = Number.parseInt(fields[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== fields[0]) return null;
  const boot = fields[3] ?? '';
  return { pid, since: fields[1] ?? '', boot: /^[0-9A-Fa-f-]{8,64}$/.test(boot) ? boot : '' };
}

/** 'unknown' is a token we cannot read as ours (empty, foreign): only age can free it. */
function ownerState(text: string): 'alive' | 'dead' | 'unknown' {
  const token = parseToken(text);
  if (token === null) return 'unknown';
  const here = bootId();
  if (token.boot !== '' && here !== '' && token.boot !== here) return 'dead';
  if (token.pid === process.pid) return 'alive';
  try {
    process.kill(token.pid, 0);
    return 'alive';
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists but is not ours; treat as alive.
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
  }
}

function readIfThere(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Creates `target` complete, or reports that it exists. The token goes to a
 * temp file that is then linked into place, so a reader never sees a partial
 * lock and a full disk cannot leave an empty one.
 */
function createComplete(target: string, token: string): boolean {
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, target);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      // A filesystem without hard links: create in place, as before ADR 0097.
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeSync(fd, token);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Moves `filePath` away only if it still holds exactly `seen`; anything else moved by mistake is linked back. */
function removeIfStill(filePath: string, seen: Buffer): void {
  const grave = `${filePath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(filePath, grave);
  } catch {
    return;
  }
  const moved = readIfThere(grave);
  if (moved === null || !moved.equals(seen)) {
    try {
      fs.linkSync(grave, filePath);
    } catch {
      // A newer file is in place, or no hard links: the save check (Vault.save) is the backstop.
    }
  }
  fs.rmSync(grave, { force: true });
}

/**
 * Compare-and-take of a lock judged dead. Stealers run one at a time under a
 * guard file, so the re-read under it proves the rename moves only the dead
 * bytes: nobody else may remove the lock, and its owner is gone.
 */
function removeDeadLock(lockPath: string, seen: Buffer, token: string): void {
  const guardPath = `${lockPath}.steal`;
  if (!createComplete(guardPath, token)) {
    const guard = readIfThere(guardPath);
    if (guard === null) return;
    let old = false;
    try {
      old = Date.now() - fs.statSync(guardPath).mtimeMs > GUARD_STALE_MS;
    } catch {
      return;
    }
    if (old || ownerState(guard.toString('utf8')) === 'dead') removeIfStill(guardPath, guard);
    return;
  }
  try {
    const now = readIfThere(lockPath);
    if (now !== null && now.equals(seen)) removeIfStill(lockPath, seen);
  } finally {
    const mine = readIfThere(guardPath);
    if (mine !== null && mine.toString('utf8') === token) fs.rmSync(guardPath, { force: true });
  }
}

/** "process 123 (node), since 2026-…", for the busy message. */
function describeHolder(seen: Buffer | null): string {
  const token = seen === null ? null : parseToken(seen.toString('utf8'));
  if (token === null) return '';
  let name = '';
  try {
    name = (execFileSync('/bin/ps', ['-p', String(token.pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2_000 }).trim().split('/').pop() ?? '');
  } catch {
    name = '';
  }
  const since = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(token.since) ? `, since ${token.since}` : '';
  return `process ${token.pid}${/^[\w .()-]{1,64}$/.test(name) ? ` (${name})` : ''}${since}`;
}

export interface FileLockOptions {
  /** How long to wait for the lock before giving up (default 5 s). */
  timeoutMs?: number;
  /** Age after which a lock with no readable owner is presumed abandoned and taken (default 60 s). */
  staleMs?: number;
  /**
   * Also take a lock older than `staleMs` from an owner that is still running.
   * Never set for the vault lock (ADR 0097 D1). The sync lock keeps it: its
   * holder freshens the lock while it works.
   */
  takeOverLiveOwner?: boolean;
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const token = `${process.pid} ${new Date().toISOString()} ${Math.random().toString(36).slice(2)} ${bootId() || '-'}\n`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (createComplete(lockPath, token)) break;
    const seen = readIfThere(lockPath);
    if (seen === null) continue; // released between the create and the read: retry at once
    const state = ownerState(seen.toString('utf8'));
    let dead = state === 'dead';
    if (!dead && (state === 'unknown' || options.takeOverLiveOwner === true)) {
      try {
        dead = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
      } catch {
        continue;
      }
    }
    if (dead) {
      removeDeadLock(lockPath, seen, token);
      if (!fs.existsSync(lockPath)) continue;
    }
    if (Date.now() > deadline) throw new FileLockTimeoutError(lockPath, describeHolder(seen));
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  try {
    return await fn();
  } finally {
    // Only remove the lock if it is still OURS: if it was taken from us (an
    // older build, or a hand-deleted lock), deleting would evict the new owner.
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // already gone — nothing to release
    }
  }
}
