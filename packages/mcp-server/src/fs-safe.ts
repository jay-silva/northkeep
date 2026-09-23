import crypto from 'node:crypto';
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

/** NorthKeep's own mirror temps: `<name>.northkeep-tmp-<16 lowercase hex>`, nothing looser. */
export const MIRROR_TEMP_PATTERN = /^.+\.northkeep-tmp-[0-9a-f]{16}$/;

/**
 * ADR 0053 Decision 2: at run start, remove crash residue from a killed write.
 * Only exact-pattern regular files or symlinks go; unlink never follows a link.
 * Returns the names removed.
 */
export function cleanStaleMirrorTemps(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!MIRROR_TEMP_PATTERN.test(name)) continue;
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    fs.unlinkSync(p);
    removed.push(name);
  }
  return removed;
}

/**
 * The mirror writer (ADR 0053 Decision 2). Unlike atomicWrite it resolves
 * nothing: a fresh random temp opened O_EXCL|O_NOFOLLOW so a planted link is
 * never written through, mode 0o644 set on the descriptor against the umask,
 * fsync, then rename. On failure it unlinks only the temp it created.
 */
export function writeMirrorFile(target: string, bytes: Uint8Array): void {
  const tmp = `${target}.northkeep-tmp-${crypto.randomBytes(8).toString('hex')}`;
  let present = true;
  try {
    fs.lstatSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    present = false;
  }
  if (present) throw new Error('The mirror temp path already exists; NorthKeep will not write through it');
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  let open = true;
  let renamed = false;
  try {
    fs.fchmodSync(fd, 0o644);
    if (process.env.NORTHKEEP_EXPORT_CRASH_WRITE === '1') {
      // Acceptance hook: die with a partial temp on disk, skipping every finally.
      fs.writeSync(fd, bytes.subarray(0, Math.min(3, bytes.length)));
      fs.fsyncSync(fd);
      process.kill(process.pid, 'SIGKILL');
      process.abort();
    }
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    open = false;
    fs.renameSync(tmp, target);
    renamed = true;
  } finally {
    if (open) fs.closeSync(fd);
    if (!renamed) fs.rmSync(tmp, { force: true });
  }
}
