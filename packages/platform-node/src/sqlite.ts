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
