import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared surgical-write helpers (ADR 0042 P7). Semantics are BYTE-IDENTICAL
 * to the previous private copies in connect.ts: same suffixes, same
 * realpath-then-write, same 0600 default, same post-write chmod, same temp
 * cleanup. connect.ts re-imports these; contract.ts uses them too.
 */

/**
 * Copy the file to `<file>.northkeep-bak` before the first write, so the
 * pristine pre-NorthKeep bytes are always recoverable. Only backs up when the
 * file exists and no backup exists yet (so we never overwrite the original
 * backup with a file that already carries our edits).
 */
export function backupOnce(file: string): void {
  const bak = `${file}.northkeep-bak`;
  if (fs.existsSync(file) && !fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
  }
}

/**
 * Atomic, mode-preserving write. P4: `realpathSync` an existing file and
 * write/rename against that target so a symlink is not replaced by a regular
 * file (temp in the resolved parent, mode from the resolved file). A missing
 * path writes at the literal location with 0600. writeFileSync mode is subject
 * to umask, so we chmod after write.
 */
export function atomicWrite(file: string, contents: string): void {
  let target = file;
  let mode = 0o600;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* new file — keep the 0600 default, write at the literal path */
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.northkeep-tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode });
    fs.chmodSync(tmp, mode); // writeFileSync mode is subject to umask; force it
    fs.renameSync(tmp, target); // atomic on the same filesystem
  } finally {
    // Never leave a stray temp behind if the rename didn't happen.
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}
