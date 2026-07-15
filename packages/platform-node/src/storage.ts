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
      const tmpPath = `${filePath}.tmp`;
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.bak`);
      }
      fs.renameSync(tmpPath, filePath);
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
