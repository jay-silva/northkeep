/**
 * The vault nests transactions (an edit supersedes inside its own transaction).
 * expo's withTransactionSync cannot nest: the inner BEGIN fails and its ROLLBACK
 * ends the outer transaction. The fake below is expo-sqlite's
 * sync API over sql.js, with expo's own withTransactionSync.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, Vault, generateDeviceSecret, type Platform } from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';

let SQL: SqlJsStatic;

class FakeExpoDb {
  constructor(readonly db: SqlJsDatabase) {}
  execSync(sql: string): void {
    this.db.exec(sql);
  }
  prepareSync(sql: string) {
    const stmt = this.db.prepare(sql);
    const db = this.db;
    return {
      executeSync(...params: unknown[]) {
        const bind = (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !ArrayBuffer.isView(params[0]) ? params[0] : params) as never;
        stmt.bind(bind);
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        const changes = db.getRowsModified();
        const last = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0] ?? 0;
        return { changes, lastInsertRowId: Number(last), getAllSync: () => rows, getFirstSync: () => rows[0] ?? null };
      },
      finalizeSync() {
        stmt.free();
      },
    };
  }
  // expo-sqlite 57's own body, so a nested BEGIN fails the way it does on a phone.
  withTransactionSync(task: () => void): void {
    try {
      this.execSync('BEGIN');
      task();
      this.execSync('COMMIT');
    } catch (e) {
      this.execSync('ROLLBACK');
      throw e;
    }
  }
  serializeSync(): Uint8Array {
    return this.db.export();
  }
  closeSync(): void {
    this.db.close();
  }
}

vi.mock('expo-sqlite', () => ({
  openDatabaseSync: () => new FakeExpoDb(new SQL.Database()),
  deserializeDatabaseSync: (bytes: Uint8Array) => new FakeExpoDb(new SQL.Database(bytes)),
}));

const { mobileSqliteDriver } = await import('../src/sqlite.js');

beforeAll(async () => {
  SQL = await initSqlJs();
});

const phone = (): Platform => ({ ...nodePlatform(), sqlite: mobileSqliteDriver() });

function phoneVault(): Vault {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-mobile-tx-'));
  return Vault.create({ path: path.join(dir, 'v.nkv'), passphrase: 'test passphrase only', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE, platform: phone() });
}

describe('the phone SQLite driver', () => {
  it('an edit made on the phone saves the new text and keeps the old one in history', () => {
    const vault = phoneVault();
    const first = vault.remember({ content: 'The fuel dock opens at 6.', type: 'semantic', scope: 'harbor', source: 'cli' });
    const edited = vault.editMemory(first.id, { content: 'The fuel dock opens at 7.' }, { actor: 'owner' });
    expect(vault.list({ scope: 'harbor' }).map((m) => m.content)).toEqual(['The fuel dock opens at 7.']);
    expect(edited.id).not.toBe(first.id);
    vault.close();
  });

  it('a failure inside a nested step rolls back only that step and reports its own error', () => {
    const db = mobileSqliteDriver().createEmpty();
    db.exec('CREATE TABLE t (v TEXT)');
    const ins = (v: string) => db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
    db.transaction(() => {
      ins('outer');
      expect(() =>
        db.transaction(() => {
          ins('inner');
          throw new Error('inner failed');
        })(),
      ).toThrow('inner failed');
    })();
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'outer' }]);

    expect(() =>
      db.transaction(() => {
        ins('lost');
        db.transaction(() => ins('lost too'))();
        throw new Error('outer failed');
      })(),
    ).toThrow('outer failed');
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'outer' }]);
  });
});
