import fs from 'node:fs';
import path from 'node:path';
import type { VaultStorage } from '@northkeep/core';

/**
 * Node VaultStorage: node:fs behind the platform seam. writeAtomic reproduces
 * exactly the temp + fsync + rename + .bak + directory-fsync dance that lived
 * inline in vault.ts save() (ADR crash-safety semantics unchanged).
 */
export function nodeVaultStorage(): VaultStorage {
  return {
    exists(filePath: string): boolean {
      return fs.existsSync(filePath);
    },

    readBytes(filePath: string): Buffer {
      return fs.readFileSync(filePath);
    },

    writeAtomic(filePath: string, bytes: Uint8Array): void {
      // Write THROUGH a symlink, never over it. The old code renamed the temp
      // file onto the given path, which replaced the link with a regular file
      // on the first save: a symlinked default vault stopped being the default
      // vault, and sync quietly switched itself off (ADR 0044 sixth review).
      const target = resolveLink(filePath);
      const tmpPath = `${target}.tmp`;
      const dir = path.dirname(target);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(target)) {
        fs.copyFileSync(target, `${target}.bak`);
      }
      fs.renameSync(tmpPath, target);
      // fsync the directory so the rename itself survives power loss.
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    },
  };
}

/**
 * The file a path really names: a symlink's target, resolved even when the
 * target does not exist yet (a dangling link must not be replaced by a regular
 * file either, and `realpathSync` throws for one). Anything
 * that is not a symlink, and any path we cannot stat, is returned unchanged.
 */
function resolveLink(filePath: string): string {
  try {
    if (!fs.lstatSync(filePath).isSymbolicLink()) return filePath;
  } catch {
    return filePath;
  }
  try {
    return fs.realpathSync(filePath);
  } catch {
    // Dangling link: resolve the recorded target by hand.
    try {
      return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
    } catch {
      return filePath;
    }
  }
}
