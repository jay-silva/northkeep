/**
 * Platform seam: the synchronous SQLite surface vault.ts needs, as an interface
 * so the vault can run on a mobile runtime (expo-sqlite's serializeSync/
 * deserializeDatabaseSync) by swapping the adapter. The shape mirrors
 * better-sqlite3 so the Node adapter is a thin pass-through. SYNCHRONOUS by
 * contract — the vault opens, mutates, serializes, and closes within a single
 * file-lock window and never awaits the database.
 *
 * The whole-file model (ADR 0001): a vault is a single SQLite image, decrypted
 * into memory on open and re-serialized on save. No per-row encryption.
 */

/** A prepared statement. Params may be passed positionally or as one named object
 * (`@name`), matching better-sqlite3. Result rows are typed `unknown` — callers
 * cast to their row shape, as the existing vault code already does. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** An open in-memory database. */
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** Runs a PRAGMA (e.g. `foreign_keys = ON`); return value is ignored by the vault. */
  pragma(source: string): unknown;
  /** Wraps `fn` so it runs atomically; the returned function executes it. */
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export interface SqliteDriver {
  /** Open a database from a serialized SQLite image (the decrypted vault payload). */
  openFromImage(bytes: Uint8Array): SqliteDb;
  /** Create a fresh empty in-memory database (a new vault). */
  createEmpty(): SqliteDb;
  /** Serialize a database back to a SQLite image for encryption + save. */
  serialize(db: SqliteDb): Uint8Array;
}
