import fs from 'node:fs';

/**
 * Advisory file lock serializing vault access between the CLI and the MCP
 * server. The vault is whole-file: two concurrent open→mutate→save cycles
 * would silently drop one writer's changes, so every such cycle runs inside
 * withFileLock. Locks older than STALE_MS are presumed abandoned (crashed
 * process) and stolen.
 */
const STALE_MS = 60_000;
const TIMEOUT_MS = 5_000;
const RETRY_MS = 50;

/** The lock was held by someone else for longer than the caller was willing to wait. */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(
      `Vault is locked by another NorthKeep process (${lockPath}). ` +
        'If nothing is running, delete the lock file and retry.',
    );
    this.name = 'FileLockTimeoutError';
  }
}

/** Is the process that wrote this lock token still alive? Unknown (foreign format) counts as alive. */
function lockOwnerAlive(token: string): boolean {
  const pid = Number.parseInt(token.split(' ')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists but is not ours; treat as alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export interface FileLockOptions {
  /** How long to wait for the lock before giving up (default 5 s). */
  timeoutMs?: number;
  /** Age after which a lock is presumed abandoned and stolen (default 60 s). */
  staleMs?: number;
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const token = `${process.pid} ${new Date().toISOString()} ${Math.random().toString(36).slice(2)}\n`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        // A lock whose owner is dead (crash or kill mid-operation) is stale
        // at once; waiting out the age window only stalls the next sync
        // (ADR 0044 review). Age still covers a token we cannot parse.
        let ownerDead = false;
        try {
          ownerDead = !lockOwnerAlive(fs.readFileSync(lockPath, 'utf8'));
        } catch {
          ownerDead = false;
        }
        if (age > staleMs || ownerDead) {
          // Steal atomically via rename: exactly one contender wins the
          // rename; losers get ENOENT and retry. A plain rm here would let
          // two stealers both remove-and-recreate (double entry).
          const graveyard = `${lockPath}.stale-${process.pid}-${Date.now()}`;
          try {
            fs.renameSync(lockPath, graveyard);
            fs.rmSync(graveyard, { force: true });
          } catch {
            // another contender won the steal — fall through and retry
          }
          continue;
        }
      } catch {
        continue; // lock vanished between exists and stat — retry immediately
      }
      if (Date.now() > deadline) throw new FileLockTimeoutError(lockPath);
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    // Only remove the lock if it is still OURS: if we overran STALE_MS and
    // were stolen from, deleting unconditionally would evict the stealer.
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      // already gone — nothing to release
    }
  }
}
