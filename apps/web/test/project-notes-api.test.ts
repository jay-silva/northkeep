import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, NOTES_NOTICE, Vault, deriveMasterKey, deriveNotesKey, planNote, type StoredNote } from '@northkeep/core';
import { NotesFile, notesFilePath } from '@northkeep/mcp-server';
import { openSqliteFile } from '@northkeep/platform-node';
import { handleProjectsApi } from '../src/projectsApi.js';
import { UiSession } from '../src/session.js';

const passphrase = 'synthetic notes panel';
const deviceSecret = Buffer.alloc(32, 7);
const prevHome = process.env.NORTHKEEP_HOME;
let dir: string;
let vaultPath: string;
let session: UiSession;

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-notes-')));
  process.env.NORTHKEEP_HOME = dir;
  fs.writeFileSync(path.join(dir, 'device.secret'), `${deviceSecret.toString('hex')}\n`, { mode: 0o600 });
  vaultPath = path.join(dir, 'vault.nkv');
  const v = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  v.save();
  v.close();
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
});
afterEach(() => {
  session.autoSync.stop();
  session.connectorAutoPush.stop();
  session.lock();
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The key an MCP server on this vault would use, derived apart from the session. */
function writerKey(): Buffer {
  const header = Vault.readHeader(vaultPath);
  return deriveNotesKey(deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf));
}

function send(file: NotesFile, from: { host: string; sender_key: string }, request: Parameters<typeof planNote>[0], at: Date): StoredNote {
  return file.insert('northkeep', crypto.randomUUID(), from.sender_key, (existing) => planNote(request, from, existing, at), at).note;
}

const getNotes = async (slug = 'northkeep') => {
  const response = await handleProjectsApi(session, 'GET', `/api/projects/${slug}/notes`, Buffer.alloc(0));
  return { status: response?.status, body: response?.body as Record<string, unknown> };
};
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('GET /api/projects/<slug>/notes (ADR 0079 D6)', () => {
  it('answers 423 while the vault is locked', async () => {
    session.lock();
    expect(await getNotes()).toEqual({ status: 423, body: { error: 'Vault is locked.', code: 'locked' } });
  });

  it('returns no messages when no notes file exists yet, and does not create one', async () => {
    expect(await getNotes()).toEqual({ status: 200, body: { threads: [], active_claims: [], notice: NOTES_NOTICE } });
    expect(fs.existsSync(notesFilePath(vaultPath)!)).toBe(false);
  });

  it('says a zero-byte notes file cannot be read and leaves it empty', async () => {
    const filePath = notesFilePath(vaultPath)!;
    fs.writeFileSync(filePath, '');
    expect(await getNotes()).toEqual({ status: 200, body: { unreadable: true } });
    expect(fs.statSync(filePath).size).toBe(0);
  });

  it('returns one thread with the reply nested, canonical receipts, and the active claim apart', async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const [asked, claimed, answered] = [minutesAgo(8), minutesAgo(5), minutesAgo(2)];
    const key = writerKey();
    const file = NotesFile.open(notesFilePath(vaultPath)!, key);
    const code = { host: 'claude-code', sender_key: 'session-code' };
    const cursor = { host: 'cursor-vscode', sender_key: 'session-cursor' };
    const question = send(file, code, { kind: 'note', text: 'Can you rerun the full test run?', to: 'cursor' }, asked);
    const claim = send(file, cursor, { kind: 'claim', text: 'Running it now.', subject: 'bug 1234', hours: 2 }, claimed);
    const answer = send(file, cursor, { kind: 'note', text: 'Running it now. Leave the notes route alone.', reply_to: question.id }, answered);
    file.markShown('northkeep', 'session-cursor', 'cursor-vscode', [question.id], minutesAgo(7));
    file.markShown('northkeep', 'session-code-2', 'claude-code', [answer.id], minutesAgo(1));
    file.close();
    key.fill(0);

    const { status, body } = await getNotes();
    expect(status).toBe(200);
    expect(body).toEqual({
      threads: [{
        root: { id: question.id, kind: 'note', from: 'claude-code', to: 'cursor', text: 'Can you rerun the full test run?', seen_by: ['cursor'], created_at: asked.toISOString() },
        replies: [{ id: answer.id, kind: 'note', from: 'cursor', to: 'claude-code', text: 'Running it now. Leave the notes route alone.', reply_to: question.id, thread: question.id, seen_by: ['claude-code'], created_at: answered.toISOString() }],
      }],
      active_claims: [{ id: claim.id, kind: 'claim', from: 'cursor', to: 'all', text: 'Running it now.', subject: 'bug 1234', expires_at: new Date(claimed.getTime() + 2 * 3_600_000).toISOString(), seen_by: [], created_at: claimed.toISOString() }],
      notice: NOTES_NOTICE,
    });
  });

  it('says the file cannot be read under another key and leaves its bytes unchanged', async () => {
    const other = crypto.randomBytes(32);
    const filePath = notesFilePath(vaultPath)!;
    const file = NotesFile.open(filePath, other);
    send(file, { host: 'codex-mcp-client', sender_key: 'session-codex' }, { kind: 'note', text: 'Written under a different vault key.' }, new Date());
    file.close();
    const before = sha(filePath);
    expect(await getNotes()).toEqual({ status: 200, body: { unreadable: true } });
    expect(sha(filePath)).toBe(before);
  });

  it('shows the threads with no receipts from a file only 0072 builds have opened, and leaves it unchanged', async () => {
    const filePath = notesFilePath(vaultPath)!;
    const key = writerKey();
    const file = NotesFile.open(filePath, key);
    const sent = new Date(Date.now() - 60_000);
    const note = send(file, { host: 'cursor-vscode', sender_key: 'session-cursor' }, { kind: 'note', text: 'Are you in vault.ts?', to: 'claude-ai' }, sent);
    file.close();
    key.fill(0);
    const db = openSqliteFile(filePath);
    db.exec('DROP TABLE shown');
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name))
      .toEqual(['meta', 'notes', 'seen', 'sqlite_sequence']);
    db.close();
    const before = sha(filePath);

    expect(await getNotes()).toEqual({
      status: 200,
      body: {
        threads: [{ root: { id: note.id, kind: 'note', from: 'cursor', to: 'claude-desktop', text: 'Are you in vault.ts?', seen_by: [], created_at: sent.toISOString() }, replies: [] }],
        active_claims: [],
        notice: NOTES_NOTICE,
      },
    });
    expect(sha(filePath)).toBe(before);
  });

  it('refuses a write method and a slug outside the project pattern', async () => {
    expect((await handleProjectsApi(session, 'POST', '/api/projects/northkeep/notes', Buffer.from('{}')))?.status).toBe(405);
    expect((await getNotes('Not_A_Slug')).status).toBe(404);
  });
});
