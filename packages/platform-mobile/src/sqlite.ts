import {
  deserializeDatabaseSync,
  openDatabaseSync,
  type SQLiteDatabase,
} from 'expo-sqlite';
import type { SqliteDb, SqliteDriver, SqliteStatement } from '@northkeep/core';
import { toExpoBindParams } from './sqlite-params.js';

/**
 * Mobile SqliteDriver: expo-sqlite's synchronous API behind the platform seam,
 * preserving the whole-file .nkv image model (ADR 0001): openFromImage =
 * deserializeDatabaseSync over the decrypted vault payload, serialize =
 * serializeSync back to an image for encryption + save.
 *
 * The IMAGE contract (a better-sqlite3-serialized vault opens here and a
 * re-serialized image reopens on desktop, hash chain intact) is what the Node
 * byte-exactness suite proves via sql.js — a third, independent SQLite build —
 * replicating the passing Week-1 Spike 1. This wrapper's expo API calls
 * themselves only run on device (ADR 0021).
 *
 * Statements are prepared, executed, and finalized per call rather than cached:
 * vault statement reuse is light (a handful of executions per unlock), and
 * eager finalization avoids leaking native statement handles on Hermes.
 */

class ExpoStatement implements SqliteStatement {
  constructor(
    private readonly db: SQLiteDatabase,
    private readonly sql: string,
  ) {}

  private execute<T>(params: unknown[], collect: (result: {
    changes: number;
    lastInsertRowId: number;
    getAllSync(): unknown[];
    getFirstSync(): unknown | null;
  }) => T): T {
    let stmt;
    try {
      stmt = this.db.prepareSync(this.sql);
    } catch (err) {
      throw new Error(`sqlite[prepare] "${this.sql.slice(0, 40)}": ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      return collect(stmt.executeSync(...toExpoBindParams(params)));
    } catch (err) {
      throw new Error(`sqlite[execute] "${this.sql.slice(0, 40)}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      stmt.finalizeSync();
    }
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.execute(params, (r) => ({
      changes: r.changes,
      // Contract (and better-sqlite3) spell it "Rowid"; expo spells it "RowId".
      lastInsertRowid: r.lastInsertRowId,
    }));
  }

  get(...params: unknown[]): unknown {
    // better-sqlite3 returns undefined for no row; expo returns null. `??` is
    // safe here (not `||`) because a row is always a non-null object, so only
    // the no-row null collapses to undefined; a falsy column value is untouched.
    return this.execute(params, (r) => r.getFirstSync() ?? undefined);
  }

  all(...params: unknown[]): unknown[] {
    return this.execute(params, (r) => r.getAllSync());
  }
}

class ExpoSqliteDb implements SqliteDb {
  constructor(readonly native: SQLiteDatabase) {}

  prepare(sql: string): SqliteStatement {
    return new ExpoStatement(this.native, sql);
  }

  exec(sql: string): void {
    this.native.execSync(sql);
  }

  pragma(source: string): unknown {
    // The seam contract says the return value is ignored by the vault.
    this.native.execSync(`PRAGMA ${source};`);
    return undefined;
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      let result!: T;
      this.native.withTransactionSync(() => {
        result = fn();
      });
      return result;
    };
  }

  close(): void {
    this.native.closeSync();
  }
}

function labelNative<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`sqlite[${name}]: ${msg}`);
  }
}

export function mobileSqliteDriver(): SqliteDriver {
  return {
    createEmpty(): SqliteDb {
      return new ExpoSqliteDb(labelNative('openDatabaseSync', () => openDatabaseSync(':memory:')));
    },
    openFromImage(bytes: Uint8Array): SqliteDb {
      // Hand the native module a plain Uint8Array (not the Buffer polyfill).
      const plain = new Uint8Array(bytes);
      return new ExpoSqliteDb(labelNative('deserializeDatabaseSync', () => deserializeDatabaseSync(plain)));
    },
    serialize(db: SqliteDb): Uint8Array {
      return labelNative('serializeSync', () => (db as ExpoSqliteDb).native.serializeSync());
    },
  };
}
