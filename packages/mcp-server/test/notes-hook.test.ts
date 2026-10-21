import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, NOTES_NOTICE, Vault, deriveMasterKey, deriveNotesKey, generateDeviceSecret, planNote, type NoteRequest, type NoteView, type NotesBlock } from '@northkeep/core';
import { NotesFile, notesFilePath } from '../src/notes-store.js';
import { notesOwnerView, parseHookInput, renderHook, runNotesHook } from '../src/notes-cli.js';
import { keychainSetMasterKey, resetMasterKeyStoreProbe } from '../src/keychain.js';

const PASSPHRASE = 'adr 0079 notes hook passphrase';
const UUID_V7 = '0192F1A4-7B3C-7D2E-8F10-123456789ABC';
const ID_128 = 'a'.repeat(128);
const ID_129 = 'a'.repeat(129);
let home: string;
let vaultPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0079-hook-'));
  vaultPath = path.join(home, 'vault.nkv');
  for (const key of ['NORTHKEEP_SECRET_BACKEND', 'NORTHKEEP_HOME', 'NORTHKEEP_MASTER_KEY', 'NORTHKEEP_NO_KEYCHAIN', 'NORTHKEEP_REDACT_TIER']) saved[key] = process.env[key];
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  delete process.env.NORTHKEEP_REDACT_TIER;
  const secret = generateDeviceSecret();
  Vault.create({ path: vaultPath, passphrase: PASSPHRASE, deviceSecret: secret, kdf: KDF_INTERACTIVE }).close();
  const header = Vault.readHeader(vaultPath);
  process.env.NORTHKEEP_MASTER_KEY = deriveMasterKey(PASSPHRASE, secret, header.salt, header.kdf).toString('hex');
});

afterEach(() => {
  resetMasterKeyStoreProbe();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const stdin = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe('ADR 0079 hook input per host', () => {
  it('claude-code reads session_id, accepts only a UUID, and lowercases it in the reader key', () => {
    expect(parseHookInput('claude-code', stdin({ session_id: UUID_V7, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }))).toEqual({
      host: 'claude-code', event: 'UserPromptSubmit', readerKey: 'hook:claude-code:0192f1a4-7b3c-7d2e-8f10-123456789abc', recordsShown: true,
    });
    expect(parseHookInput('claude-code', stdin({ session_id: UUID_V7, hook_event_name: 'PostToolUse' }))?.event).toBe('PostToolUse');
    for (const id of ['thr_123', 'conv-456', ID_129]) {
      expect(parseHookInput('claude-code', stdin({ session_id: id, hook_event_name: 'UserPromptSubmit' }))).toBeNull();
    }
    expect(parseHookInput('claude-code', stdin({ session_id: UUID_V7, hook_event_name: 'SessionStart' }))).toBeNull();
  });

  it('codex reads session_id, accepts 4 to 128 of [A-Za-z0-9_.:-], and SessionStart', () => {
    const codex = (id: string, event = 'PostToolUse') => parseHookInput('codex', stdin({ session_id: id, hook_event_name: event }));
    expect(codex('thr_123', 'SessionStart')).toEqual({ host: 'codex', event: 'SessionStart', readerKey: 'hook:codex:thr_123', recordsShown: true });
    expect(codex('conv-456', 'UserPromptSubmit')?.readerKey).toBe('hook:codex:conv-456');
    expect(codex(UUID_V7)?.readerKey).toBe('hook:codex:0192f1a4-7b3c-7d2e-8f10-123456789abc');
    expect(codex(ID_128)?.readerKey).toBe(`hook:codex:${ID_128}`);
    for (const id of [ID_129, 'abc', 'thr 123', '../etc', 'thr_123\n']) expect(codex(id)).toBeNull();
    expect(codex('thr_123', 'sessionStart')).toBeNull();
  });

  it('cursor reads conversation_id, not session_id, and its own event names', () => {
    const cursor = (fields: Record<string, unknown>) => parseHookInput('cursor', stdin(fields));
    expect(cursor({ conversation_id: 'conv-456', hook_event_name: 'postToolUse' })).toEqual({
      host: 'cursor', event: 'postToolUse', readerKey: 'hook:cursor:conv-456', recordsShown: true,
    });
    expect(cursor({ conversation_id: 'thr_123', hook_event_name: 'postToolUseFailure' })?.recordsShown).toBe(true);
    expect(cursor({ conversation_id: UUID_V7, hook_event_name: 'sessionStart' })).toEqual({
      host: 'cursor', event: 'sessionStart', readerKey: 'hook:cursor:0192f1a4-7b3c-7d2e-8f10-123456789abc', recordsShown: false,
    });
    expect(cursor({ conversation_id: ID_129, hook_event_name: 'postToolUse' })).toBeNull();
    expect(cursor({ session_id: 'conv-456', hook_event_name: 'postToolUse' })).toBeNull();
    expect(cursor({ conversation_id: 'conv-456', hook_event_name: 'PostToolUse' })).toBeNull();
    expect(cursor({ conversation_id: 'conv-456', hook_event_name: 'beforeSubmitPrompt' })).toBeNull();
  });

  it('a host outside the three, or input that is not a JSON object, gives nothing', () => {
    const input = stdin({ session_id: UUID_V7, conversation_id: 'conv-456', hook_event_name: 'PostToolUse' });
    expect(parseHookInput('claude-code', input)?.readerKey).toBe('hook:claude-code:0192f1a4-7b3c-7d2e-8f10-123456789abc');
    for (const host of ['windsurf', 'Cursor', 'claude-desktop', '', '__proto__', 'constructor']) expect(parseHookInput(host, input)).toBeNull();
    for (const raw of ['null', '[]', '"PostToolUse"', '42', 'not json', '']) expect(parseHookInput('codex', raw)).toBeNull();
  });
});

describe('ADR 0079 hook output per host', () => {
  const claim: NoteView = {
    id: 'claim-1', kind: 'claim', from: 'cursor', to: 'all', text: 'on it', subject: 'bug-1234',
    expires_at: '2026-10-21T13:00:00.000Z', created_at: '2026-10-21T09:00:00.000Z',
  };
  const reply: NoteView = {
    id: 'note-2', kind: 'note', from: 'claude-desktop', to: 'cursor', text: 'Yes, until noon.',
    reply_to: 'note-1', thread: 'note-1', created_at: '2026-10-21T09:05:00.000Z',
  };
  const orphan: NoteView = {
    id: 'note-4', kind: 'note', from: 'codex', to: 'all', text: 'Same here.', reply_to: 'gone', thread: 'gone', created_at: '2026-10-21T09:06:00.000Z',
  };
  const note: NoteView = { id: 'note-3', kind: 'note', from: 'codex', to: 'all', text: 'Tests are green', created_at: '2026-10-21T09:10:00.000Z' };
  const block: NotesBlock = { notes: [note, orphan, reply], notes_count: 4, active_claims: [claim], notes_notice: NOTES_NOTICE };
  const roots = new Map([['note-1', 'Are you in vault.ts? I want to change the lock timeout before the release tonight.']]);
  const CONTEXT = [
    'NorthKeep notes for project "rental":',
    '- Claim: cursor holds "bug-1234" until 2026-10-21T13:00:00.000Z (on it)',
    '- Note from codex: Tests are green',
    '- Reply from codex: Same here.',
    '- Reply from claude-desktop to cursor (re "Are you in vault.ts? I want to change the lock timeout befor"): Yes, until noon.',
    '(1 older unseen notes not shown)',
    NOTES_NOTICE,
  ].join('\n');
  const render = (host: string, fields: Record<string, unknown>) => {
    const request = parseHookInput(host, stdin(fields));
    if (request === null) throw new Error('gate refused the fixture');
    return renderHook(request, 'rental', block, roots);
  };

  it('claude-code prints hookSpecificOutput with its event name', () => {
    expect(render('claude-code', { session_id: UUID_V7, hook_event_name: 'PostToolUse' })).toEqual({
      output: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":${JSON.stringify(CONTEXT)}}}`,
      shown: ['note-3', 'note-4', 'note-2'],
    });
  });

  it('codex prints the same shape as claude-code, SessionStart included', () => {
    expect(render('codex', { session_id: 'thr_123', hook_event_name: 'SessionStart' })).toEqual({
      output: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":${JSON.stringify(CONTEXT)}}}`,
      shown: ['note-3', 'note-4', 'note-2'],
    });
  });

  it('cursor prints additional_context; sessionStart records nothing as shown, postToolUse records what it printed', () => {
    const output = `{"additional_context":${JSON.stringify(CONTEXT)}}`;
    expect(render('cursor', { conversation_id: 'conv-456', hook_event_name: 'sessionStart' })).toEqual({ output, shown: [] });
    expect(render('cursor', { conversation_id: 'conv-456', hook_event_name: 'postToolUse' })).toEqual({ output, shown: ['note-3', 'note-4', 'note-2'] });
  });

  it('cuts each claim and note to 280 characters with an ellipsis, and keeps the worst case under 7,500 characters', () => {
    const request = parseHookInput('codex', stdin({ session_id: 'thr_123', hook_event_name: 'PostToolUse' }))!;
    const long = `${'y'.repeat(278)}\u{1F600}tail${'z'.repeat(700)}`;
    const one: NotesBlock = { notes: [{ ...note, text: long }], notes_count: 1, active_claims: [{ ...claim, text: long }], notes_notice: NOTES_NOTICE };
    const lines = JSON.parse(renderHook(request, 'rental', one, roots).output).hookSpecificOutput.additionalContext.split('\n');
    expect(lines.slice(1, 3)).toEqual([
      `- Claim: cursor holds "bug-1234" until 2026-10-21T13:00:00.000Z (${'y'.repeat(278)}\u{1F600}\u2026)`,
      `- Note from codex: ${'y'.repeat(278)}\u{1F600}\u2026`,
    ]);

    const claims = Array.from({ length: 10 }, (_, i) => ({ ...claim, id: `c${i}`, from: 'claude-desktop', subject: 's'.repeat(80), text: 'x'.repeat(1000) }));
    const replies = Array.from({ length: 5 }, (_, i) => ({ ...reply, id: `r${i}`, from: 'claude-desktop', to: 'claude-code', text: 'x'.repeat(1000) }));
    const worst: NotesBlock = { notes: replies, notes_count: 200, active_claims: claims, notes_notice: NOTES_NOTICE };
    const context: string = JSON.parse(renderHook(request, 'rental', worst, new Map([['note-1', 'q'.repeat(1000)]])).output).hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThan(7_500);
  });

  it('quotes a root by code point, so an emoji at the cut is not split', () => {
    const request = parseHookInput('cursor', stdin({ conversation_id: 'conv-456', hook_event_name: 'postToolUse' }))!;
    const one: NotesBlock = { notes: [reply], notes_count: 1, active_claims: [], notes_notice: NOTES_NOTICE };
    const { output } = renderHook(request, 'rental', one, new Map([['note-1', `${'x'.repeat(59)}\u{1F600}tail`]]));
    expect(JSON.parse(output).additional_context.split('\n')[1]).toBe(`- Reply from claude-desktop to cursor (re "${'x'.repeat(59)}\u{1F600}"): Yes, until noon.`);
  });
});

describe('ADR 0079 owner view', () => {
  const at = (minute: number) => new Date(`2026-10-21T09:${String(minute).padStart(2, '0')}:00.000Z`);

  function write(rows: Array<{ host: string; sender: string; request: NoteRequest; at: Date }>): string[] {
    const notes = NotesFile.open(notesFilePath(vaultPath)!, deriveNotesKey(Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex')));
    try {
      return rows.map((r) => notes.insert('rental', randomUUID(), r.sender, (existing) => planNote(r.request, { host: r.host, sender_key: r.sender }, existing, r.at), r.at).note.id);
    } finally { notes.close(); }
  }

  function show(readerKey: string, host: string, ids: string[]): void {
    const notes = NotesFile.open(notesFilePath(vaultPath)!, deriveNotesKey(Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex')));
    try { notes.markShown('rental', readerKey, host, ids, at(30)); } finally { notes.close(); }
  }

  const master = () => Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex');

  it('prints threads newest first, replies indented, each line with its receipts', () => {
    const [root] = write([{ host: 'cursor-vscode', sender: 'k-cursor', request: { kind: 'note', to: 'claude-desktop', text: 'Are you in vault.ts?' }, at: at(0) }]);
    const [, green] = write([
      { host: 'local-agent-mode-northkeep', sender: 'k-desk', request: { kind: 'note', reply_to: root!, text: 'Yes, until noon.' }, at: at(5) },
      { host: 'codex-mcp-client', sender: 'k-codex', request: { kind: 'note', text: 'Tests are green' }, at: at(10) },
    ]);
    show('k-desk', 'claude-desktop', [root!]);
    show('hook:codex:thr_123', 'codex', [root!]);
    show('hook:cursor:conv-456', 'cursor', [green!]);
    show('hook:codex:other-session', 'codex', [green!]);
    expect(notesOwnerView(vaultPath, 'rental', master(), at(30))).toBe([
      'Active claims (0):',
      'Newest threads (2 of 2):',
      '2026-10-21T09:10 - Note from codex: Tests are green | seen by cursor',
      '2026-10-21T09:00 - Note from cursor to claude-desktop: Are you in vault.ts? | seen by claude-desktop, codex',
      '  2026-10-21T09:05 - Reply from claude-desktop to cursor: Yes, until noon. | not seen yet',
    ].join('\n'));
  });

  it('lists an active claim with its id and no receipt, and caps the threads at the newest 20', () => {
    const [claimId] = write([{ host: 'cursor', sender: 'k-cursor', request: { kind: 'claim', subject: 'bug-1234', hours: 4, text: 'on it' }, at: at(0) }]);
    write(Array.from({ length: 20 }, (_, i) => ({ host: 'codex', sender: 'k-codex', request: { kind: 'note' as const, text: `note ${i + 1}` }, at: at(i + 1) })));
    const lines = notesOwnerView(vaultPath, 'rental', master(), at(30)).split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Active claims (1):',
      `- Claim: cursor holds "bug-1234" until 2026-10-21T13:00:00.000Z (on it)  [id ${claimId}]`,
      'Newest threads (20 of 21):',
      '2026-10-21T09:20 - Note from codex: note 20 | not seen yet',
    ]);
    expect(lines.at(-1)).toBe('2026-10-21T09:01 - Note from codex: note 1 | not seen yet');
    expect(lines).toHaveLength(23);
  });
});

const linuxOnly = it.runIf(process.platform === 'linux');

describe('ADR 0079 hook against a stored key (Linux file backend)', () => {
  function storeKeyInFileBackend(): void {
    delete process.env.NORTHKEEP_NO_KEYCHAIN;
    process.env.NORTHKEEP_SECRET_BACKEND = 'file';
    resetMasterKeyStoreProbe();
    keychainSetMasterKey(process.env.NORTHKEEP_MASTER_KEY!);
  }

  function seedNote(to: string): string {
    const notes = NotesFile.open(notesFilePath(vaultPath)!, deriveNotesKey(Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex')));
    try {
      return notes.insert('rental', randomUUID(), 'k-desk', (existing) => planNote({ kind: 'note', to, text: 'Leave auth.ts alone' }, { host: 'claude-ai', sender_key: 'k-desk' }, existing, new Date()), new Date()).note.id;
    } finally { notes.close(); }
  }

  function shownRows(): unknown[] {
    const notes = NotesFile.open(notesFilePath(vaultPath)!, deriveNotesKey(Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex')));
    try { return notes.shownRows('rental').map((r) => [r.note_id, r.reader_key, r.host]); } finally { notes.close(); }
  }

  linuxOnly('cursor sessionStart prints the note without recording it; postToolUse records it once', () => {
    const id = seedNote('cursor');
    storeKeyInFileBackend();
    const hook = (event: string) => runNotesHook({ vaultPath, project: 'rental', host: 'cursor', stdin: stdin({ conversation_id: 'conv-456', hook_event_name: event }) });
    expect(JSON.parse(hook('sessionStart')).additional_context).toContain('- Note from claude-desktop to cursor: Leave auth.ts alone');
    expect(shownRows()).toEqual([]);
    expect(JSON.parse(hook('postToolUse')).additional_context).toContain('- Note from claude-desktop to cursor: Leave auth.ts alone');
    expect(shownRows()).toEqual([[id, 'hook:cursor:conv-456', 'cursor']]);
    expect(hook('postToolUse')).toBe('');
    expect(runNotesHook({ vaultPath, project: 'rental', host: 'windsurf', stdin: stdin({ conversation_id: 'conv-2', session_id: 'thr_123', hook_event_name: 'postToolUse' }) })).toBe('');
  });

  linuxOnly('codex sees the same note under its own reader key', () => {
    const id = seedNote('all');
    storeKeyInFileBackend();
    const out = runNotesHook({ vaultPath, project: 'rental', host: 'codex', stdin: stdin({ session_id: 'THR_123', hook_event_name: 'SessionStart' }) });
    expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('- Note from claude-desktop: Leave auth.ts alone');
    expect(shownRows()).toEqual([[id, 'hook:codex:thr_123', 'codex']]);
  });
});
