/**
 * Platform seam: durable byte storage for the vault file, as an interface so the
 * atomic-save semantics can move to a mobile filesystem (expo-file-system temp +
 * move) by swapping the adapter. The Node adapter implements the temp + fsync +
 * rename + .bak dance that lived inline in vault.ts save().
 *
 * NOTE: the advisory file lock (lock.ts) is deliberately NOT part of this
 * interface for M6-1 — it stays Node-only (node:fs). Mobile is single-process, so
 * cross-process locking is not needed there; if a mobile locking story is ever
 * required it gets its own seam. Device-secret storage (platform.ts) likewise
 * stays Node-coupled here and is re-homed to SecureStore in the apps/mobile work.
 */
export interface VaultStorage {
  /** True if a file exists at `path` (create() uses this to refuse overwrites). */
  exists(path: string): boolean;
  /** Read the whole file. Throws if it does not exist. */
  readBytes(path: string): Buffer;
  /**
   * Atomically replace the file at `path` with `bytes`: write to a temp file,
   * fsync, keep the previous contents as `${path}.bak`, then rename into place
   * (and fsync the directory) so a crash never leaves a torn vault.
   */
  writeAtomic(path: string, bytes: Uint8Array): void;
}
