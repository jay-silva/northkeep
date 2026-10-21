/**
 * The notes file (ADR 0072 D1): one SQLite file per vault beside the vault's
 * home folder, never synced, exported or shared. Rows are sealed under the
 * notes key; project, ids, sender key and times stay readable so the file can
 * be queried and pruned without decrypting. A key-check row tells a new vault
 * or a re-key apart from a damaged row, and resets the file visibly. The
 * `shown` table (ADR 0079 D4) records which notes each reader was given.
 */
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ProjectNoteError,
  Vault,
  keyCheckMatches,
  northkeepHome,
  notesToPrune,
  openNote,
  sealKeyCheck,
  sealNote,
  type NotePayload,
  type ShownRow,
  type StoredNote,
} from '@northkeep/core';
import { openSqliteFile, type SqliteFile } from '@northkeep/platform-node';

const SEEN_RETENTION_DAYS = 30;
const SHOWN_IN_PROJECT = 'SELECT s.* FROM shown s JOIN notes n ON n.id = s.note_id WHERE n.project = ?';

/** The vault's identity without its key, under a label of its own. Null when the header cannot be read. */
export function notesFilePath(vaultPath: string): string | null {
  let salt: Buffer;
  try {
    salt = Vault.readHeader(vaultPath).salt;
  } catch {
    return null;
  }
  const fp = crypto.createHash('sha256').update('northkeep-notes-vault\0').update(salt).digest('hex').slice(0, 32);
  return path.join(northkeepHome(), `notes-${fp}.db`);
}

interface NoteRow {
  seq: number;
  id: string;
  project: string;
  client_id: string;
  created_at: string;
  sender_key: string;
  blob: Buffer;
}

export interface InsertResult {
  note: StoredNote;
  replayed: boolean;
}

/** The file was written under another key and this caller may not reset it. */
export class NotesKeyMismatchError extends Error {
  constructor() {
    super('The notes file was written under a different key.');
    this.name = 'NotesKeyMismatchError';
  }
}

export class NotesFile {
  /** True when this open found a key-check mismatch and emptied the file. */
  readonly reset: boolean;
  /** Rows that did not open under this key on the last read; skipped, never fatal. */
  unreadable = 0;

  private constructor(private readonly db: SqliteFile, private readonly key: Buffer, reset: boolean) {
    this.reset = reset;
  }

  /**
   * The caller keeps ownership of `key` and wipes it after close(). Only a
   * caller that has proved the key against the vault may reset the file; the
   * hook has not, so it passes resetOnMismatch false and gets an error instead.
   */
  /**
   * `proven: false` (the hook) also refuses a file with no key-check row and
   * writes nothing while opening, since its key was never checked against the vault.
   */
  static open(filePath: string, key: Buffer, options: { resetOnMismatch?: boolean; proven?: boolean } = {}): NotesFile {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const db = openSqliteFile(filePath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS notes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          project TEXT NOT NULL,
          client_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sender_key TEXT NOT NULL,
          blob BLOB NOT NULL,
          UNIQUE (project, client_id)
        );
        CREATE INDEX IF NOT EXISTS notes_project ON notes (project, seq);
        CREATE TABLE IF NOT EXISTS seen (
          reader_key TEXT NOT NULL,
          project TEXT NOT NULL,
          last_seq INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (reader_key, project)
        );
        CREATE TABLE IF NOT EXISTS shown (
          note_id TEXT NOT NULL,
          reader_key TEXT NOT NULL,
          host TEXT NOT NULL,
          shown_at TEXT NOT NULL,
          PRIMARY KEY (note_id, reader_key)
        );
        CREATE INDEX IF NOT EXISTS shown_reader ON shown (reader_key, note_id);
      `);
      let reset = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const check = db.prepare('SELECT v FROM meta WHERE k = ?').get('key_check') as { v: Buffer } | undefined;
        const matches = check !== undefined && keyCheckMatches(check.v, key);
        if (!matches && options.proven === false) throw new NotesKeyMismatchError();
        if (!matches) {
          const hadRows = (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n > 0;
          reset = check !== undefined || hadRows;
          if (reset && options.resetOnMismatch === false) throw new NotesKeyMismatchError();
          db.exec('DELETE FROM notes; DELETE FROM seen; DELETE FROM shown;');
          db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('key_check', sealKeyCheck(key));
        }
        if (options.proven !== false) {
          const cutoff = new Date(Date.now() - SEEN_RETENTION_DAYS * 86_400_000).toISOString();
          db.prepare('DELETE FROM seen WHERE updated_at < ?').run(cutoff);
          db.prepare('DELETE FROM shown WHERE shown_at < ?').run(cutoff);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return new NotesFile(db, key, reset);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private decode(row: NoteRow): StoredNote | null {
    const fields = { id: row.id, project: row.project, client_id: row.client_id, sender_key: row.sender_key, created_at: row.created_at };
    const payload = openNote(row.blob, fields, this.key);
    if (payload === null) return null;
    return { ...fields, seq: row.seq, payload };
  }

  read(project: string): StoredNote[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE project = ? ORDER BY seq').all(project) as NoteRow[];
    const out: StoredNote[] = [];
    let bad = 0;
    for (const row of rows) {
      const note = this.decode(row);
      if (note === null) bad += 1;
      else out.push(note);
    }
    this.unreadable = bad;
    return out;
  }

  /**
   * Plans and stores one note in a single write transaction, so two processes
   * cannot both take one subject. A repeated client id returns the stored row,
   * only to the same sender for the same request.
   */
  insert(
    project: string,
    clientId: string,
    senderKey: string,
    plan: (existing: StoredNote[]) => NotePayload,
    now: Date = new Date(),
    sameRequest: (prior: NotePayload) => boolean = () => false,
  ): InsertResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM notes WHERE project = ? AND client_id = ?').get(project, clientId) as NoteRow | undefined;
      if (prior !== undefined) {
        const note = this.decode(prior);
        if (note === null) throw new Error('A note with that client id exists but cannot be read.');
        if (note.sender_key !== senderKey || !sameRequest(note.payload)) {
          throw new ProjectNoteError('invalid_request', 'That client_id was already used for a different note. Send a new one.');
        }
        this.db.exec('COMMIT');
        return { note, replayed: true };
      }
      const existing = this.read(project);
      const payload = plan(existing);
      const fields = { id: randomUUID(), project, client_id: clientId, sender_key: senderKey, created_at: now.toISOString() };
      const info = this.db
        .prepare('INSERT INTO notes (id, project, client_id, created_at, sender_key, blob) VALUES (?, ?, ?, ?, ?, ?)')
        .run(fields.id, project, clientId, fields.created_at, senderKey, sealNote(payload, fields, this.key));
      if (info.changes !== 1) throw new Error('The note was not stored.');
      const seq = (this.db.prepare('SELECT seq FROM notes WHERE id = ?').get(fields.id) as { seq: number }).seq;
      const note: StoredNote = { ...fields, seq, payload };
      const drop = notesToPrune([...existing, note], now);
      const del = this.db.prepare('DELETE FROM notes WHERE id = ?');
      const delShown = this.db.prepare('DELETE FROM shown WHERE note_id = ?');
      for (const id of drop) {
        delShown.run(id);
        del.run(id);
      }
      this.db.exec('COMMIT');
      return { note, replayed: false };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  lastSeen(readerKey: string, project: string): number | null {
    const row = this.db.prepare('SELECT last_seq FROM seen WHERE reader_key = ? AND project = ?').get(readerKey, project) as { last_seq: number } | undefined;
    return row === undefined ? null : row.last_seq;
  }

  markSeen(readerKey: string, project: string, lastSeq: number): void {
    this.db
      .prepare(`INSERT INTO seen (reader_key, project, last_seq, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (reader_key, project) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`)
      .run(readerKey, project, lastSeq, new Date().toISOString());
  }

  /** Ids of this project's notes already given to this reader. */
  shownFor(readerKey: string, project: string): Set<string> {
    const rows = this.db.prepare(`${SHOWN_IN_PROJECT} AND s.reader_key = ?`).all(project, readerKey) as ShownRow[];
    return new Set(rows.map((r) => r.note_id));
  }

  /** Records that these notes were given to this reader. Ids not in the project are skipped; repeats are no-ops. */
  markShown(project: string, readerKey: string, host: string, ids: readonly string[], now: Date = new Date()): void {
    if (ids.length === 0) return;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO shown (note_id, reader_key, host, shown_at) SELECT id, ?, ?, ? FROM notes WHERE id = ? AND project = ?',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) insert.run(readerKey, host, now.toISOString(), id, project);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  shownRows(project: string): ShownRow[] {
    return this.db.prepare(`${SHOWN_IN_PROJECT} ORDER BY s.shown_at, s.note_id`).all(project) as ShownRow[];
  }

  /** The project's newest sequence number, 0 when it has no notes; cheap enough to poll. */
  maxSeq(project: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM notes WHERE project = ?').get(project) as { m: number }).m;
  }

  /** Removes notes and markers of projects that no longer exist in the vault. */
  keepOnly(liveProjects: ReadonlySet<string>): number {
    const projects = (this.db.prepare('SELECT DISTINCT project FROM notes').all() as Array<{ project: string }>).map((r) => r.project);
    let removed = 0;
    for (const project of projects) {
      if (liveProjects.has(project)) continue;
      this.db.prepare('DELETE FROM shown WHERE note_id IN (SELECT id FROM notes WHERE project = ?)').run(project);
      removed += this.db.prepare('DELETE FROM notes WHERE project = ?').run(project).changes;
      this.db.prepare('DELETE FROM seen WHERE project = ?').run(project);
    }
    return removed;
  }
}
