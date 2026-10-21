/**
 * `northkeep notes` (ADR 0072 D5): the Claude Code hook path and the owner's
 * view. The hook reads only the OS key store, never prompts, prints nothing
 * when it cannot help or when a redaction tier is set, and writes only its
 * shown rows and one call-log row. It never opens the vault or its lock.
 */
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  NOTES_NOTICE,
  OWNER_SENDER_KEY,
  activeClaims,
  canonicalHost,
  deriveNotesKey,
  isValidProjectSlug,
  memzero,
  northkeepHome,
  notesForReader,
  planNote,
  tameOneLine,
  type NoteView,
} from '@northkeep/core';
import { keychainGetMasterKey, masterKeyStoreAvailable } from './keychain.js';
import { appendCallLog } from './log.js';
import { NotesFile, notesFilePath } from './notes-store.js';
import { parseReturnRedactionTier } from './return-mask.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOOK_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse']);

export interface NotesHookOptions {
  vaultPath: string;
  project: string;
  host: string;
  /** Raw hook input from stdin: Claude Code sends JSON with session_id and hook_event_name. */
  stdin: string;
  /** Skip when this reader showed notes less than this many seconds ago. */
  minIntervalSeconds?: number;
  now?: Date;
}

function line(n: NoteView): string {
  if (n.kind === 'claim') return `- Claim: ${n.from} holds "${n.subject ?? ''}" until ${n.expires_at ?? ''}${n.text ? ` (${n.text})` : ''}`;
  if (n.kind === 'release') return `- ${n.from} released "${n.subject ?? ''}"${n.text ? ` (${n.text})` : ''}`;
  return `- Note from ${n.from}${n.to === 'all' ? '' : ` to ${n.to}`}: ${n.text}`;
}

function stampPath(readerKey: string): string {
  const name = crypto.createHash('sha256').update(readerKey).digest('hex').slice(0, 32);
  return path.join(northkeepHome(), 'notes-hook', name);
}

/** True when the last showing was recent enough to skip. The stamp holds no content. */
function throttled(readerKey: string, seconds: number, now: Date): boolean {
  try {
    return now.getTime() - fs.statSync(stampPath(readerKey)).mtimeMs < seconds * 1000;
  } catch {
    return false;
  }
}

function touchStamp(readerKey: string): void {
  const file = stampPath(readerKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '', { mode: 0o600 });
}

/**
 * Returns what the hook prints: Claude Code's JSON with additionalContext,
 * or '' when there is nothing to show or anything goes wrong.
 */
export function runNotesHook(options: NotesHookOptions): string {
  try {
    return hookOutput(options);
  } catch {
    return '';
  }
}

function hookOutput(options: NotesHookOptions): string {
  // Notes are not masked, so the hook stays silent under any redaction tier.
  const tier = parseReturnRedactionTier();
  if (!tier.ok || tier.tier !== 0) return '';
  const now = options.now ?? new Date();
  let input: { session_id?: unknown; hook_event_name?: unknown };
  try {
    input = JSON.parse(options.stdin) as typeof input;
  } catch {
    return '';
  }
  const session = typeof input.session_id === 'string' ? input.session_id : '';
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
  if (!SESSION_ID.test(session) || !HOOK_EVENTS.has(event) || !isValidProjectSlug(options.project)) return '';
  const host = tameOneLine(options.host, 80) || 'claude-code';
  const readerKey = `hook:${host}:${session.toLowerCase()}`;
  if (options.minIntervalSeconds !== undefined && throttled(readerKey, options.minIntervalSeconds, now)) return '';
  const file = notesFilePath(options.vaultPath);
  if (file === null || !fs.existsSync(file)) return '';
  if (!masterKeyStoreAvailable()) return '';
  const master = keychainGetMasterKey();
  if (master === null) return '';
  let key: Buffer;
  try {
    key = deriveNotesKey(master);
  } finally {
    memzero(master);
  }
  let notes: NotesFile | null = null;
  try {
    notes = NotesFile.open(file, key, { resetOnMismatch: false, proven: false });
    const rows = notes.read(options.project);
    const { block, shown: given } = notesForReader(rows, { readerKey, host: canonicalHost(host), shown: notes.shownFor(readerKey, options.project) }, now);
    notes.markShown(options.project, readerKey, canonicalHost(host), given, now);
    if (options.minIntervalSeconds !== undefined) touchStamp(readerKey);
    if (block === null) return '';
    const shown = [...block.active_claims, ...block.notes];
    appendCallLog({
      ts: now.toISOString(), tool: 'notes_hook', provider: `${host}-hook`, host, ok: true,
      params: { scope: `project:${options.project}` }, result_count: shown.length,
      result_ids: [...new Set(shown.map((n) => n.id))], disclosed_scopes: [`project:${options.project}`],
    });
    const text = [
      `NorthKeep notes for project "${options.project}":`,
      ...block.active_claims.map(line),
      ...block.notes.map(line),
      ...(block.notes_count > block.notes.length ? [`(${block.notes_count - block.notes.length} older unseen notes not shown)`] : []),
      NOTES_NOTICE,
    ].join('\n');
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
  } finally {
    notes?.close();
    memzero(key);
  }
}

/** The owner's view: active claims and the newest notes, read only. */
export function notesOwnerView(vaultPath: string, project: string, master: Buffer, now: Date = new Date()): string {
  const file = notesFilePath(vaultPath);
  if (file === null || !fs.existsSync(file)) return 'No notes on this machine yet.';
  const key = deriveNotesKey(master);
  const notes = NotesFile.open(file, key, { resetOnMismatch: false });
  try {
    const rows = notes.read(project);
    const claims = activeClaims(rows, now);
    const recent = rows.slice(-20).reverse();
    const view = (r: (typeof rows)[number]): NoteView => ({
      id: r.id, kind: r.payload.kind, from: r.payload.host, to: r.payload.to, text: r.payload.text,
      subject: r.payload.subject, expires_at: r.payload.expires_at, created_at: r.created_at,
    });
    const out = [
      `Active claims (${claims.length}):`,
      ...claims.map((c) => `${line(view(c))}  [id ${c.id}]`),
      `Newest notes (${recent.length} of ${rows.length}):`,
      ...recent.map((r) => `${r.created_at.slice(0, 16)} ${line(view(r))}`),
    ];
    if (notes.unreadable > 0) out.push(`${notes.unreadable} notes could not be read and were skipped.`);
    return out.join('\n');
  } finally {
    notes.close();
    memzero(key);
  }
}

/** The owner releases any claim, for a claim whose app is gone. */
export function notesOwnerRelease(vaultPath: string, project: string, claimId: string, master: Buffer, now: Date = new Date()): string {
  const file = notesFilePath(vaultPath);
  if (file === null || !fs.existsSync(file)) throw new Error('No notes on this machine yet.');
  const key = deriveNotesKey(master);
  const notes = NotesFile.open(file, key, { resetOnMismatch: false });
  try {
    const { note } = notes.insert(project, randomUUID(), OWNER_SENDER_KEY, (existing) =>
      planNote({ kind: 'release', releases: claimId, text: 'Released by the owner.' }, { host: 'owner', sender_key: OWNER_SENDER_KEY }, existing, now), now);
    return `Released "${note.payload.subject ?? ''}".`;
  } finally {
    notes.close();
    memzero(key);
  }
}
