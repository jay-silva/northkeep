import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { SqliteDb, SqliteDriver } from '@northkeep/core';

/**
 * Node SqliteDriver: better-sqlite3 behind the platform seam. better-sqlite3's
 * Database already exposes exactly the synchronous surface SqliteDb declares
 * (prepare/exec/pragma/transaction/close and serialize), so this adapter is a
 * thin pass-through — the cast is safe because the shapes match structurally, and
 * the vault only ever calls the methods SqliteDb names.
 */
export function nodeSqliteDriver(): SqliteDriver {
  return {
    createEmpty(): SqliteDb {
      return new Database(':memory:') as unknown as SqliteDb;
    },
    openFromImage(bytes: Uint8Array): SqliteDb {
      const image = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return new Database(image) as unknown as SqliteDb;
    },
    serialize(db: SqliteDb): Uint8Array {
      return (db as unknown as Database.Database).serialize();
    },
  };
}

/** The on-disk SQLite surface the notes file (ADR 0072) uses. */
export interface SqliteFile {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  pragma(sql: string): unknown;
  close(): void;
}

/**
 * Opens (creating if needed) a SQLite file with WAL and a busy timeout, so
 * several MCP server processes and the CLI can share it. Mode 0600 (SQLite
 * gives its WAL files the same): the readable columns name projects.
 * `readonly` opens an existing file only and changes neither it nor its mode.
 */
export function openSqliteFile(filePath: string, options: { busyTimeoutMs?: number; readonly?: boolean } = {}): SqliteFile {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (options.readonly === true) {
    return new Database(filePath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs }) as unknown as SqliteFile;
  }
  fs.closeSync(fs.openSync(filePath, 'a', 0o600));
  fs.chmodSync(filePath, 0o600);
  const db = new Database(filePath, { timeout: busyTimeoutMs });
  db.pragma('journal_mode = WAL');
  return db as unknown as SqliteFile;
}
