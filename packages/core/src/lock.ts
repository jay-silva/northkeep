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

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const token = `${process.pid} ${new Date().toISOString()} ${Math.random().toString(36).slice(2)}\n`;
  const deadline = Date.now() + TIMEOUT_MS;
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
        if (age > STALE_MS) {
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
      if (Date.now() > deadline) {
        throw new Error(
          `Vault is locked by another Northkeep process (${lockPath}). ` +
            'If nothing is running, delete the lock file and retry.',
        );
      }
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
