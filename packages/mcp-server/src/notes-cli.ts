/**
 * `northkeep notes` (ADR 0072 D5, ADR 0079 D5): one hook command for Claude
 * Code, Codex and Cursor, and the owner's view. The hook reads only the OS key
 * store, never prompts, prints nothing when it cannot help or when a redaction
 * tier is set, and writes only its shown rows and one call-log row. It never
 * opens the vault or its lock.
 */
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  NOTES_NOTICE,
  OWNER_SENDER_KEY,
  activeClaims,
  deriveNotesKey,
  isValidProjectSlug,
  memzero,
  northkeepHome,
  notesForReader,
  planNote,
  threadsOf,
  type NoteView,
  type NotesBlock,
  type StoredNote,
} from '@northkeep/core';
import { keychainGetMasterKey, masterKeyStoreAvailable } from './keychain.js';
import { appendCallLog } from './log.js';
import { NotesFile, notesFilePath } from './notes-store.js';
import { parseReturnRedactionTier } from './return-mask.js';

export type HookHost = 'claude-code' | 'codex' | 'cursor';

interface HookHostSpec {
  idField: 'session_id' | 'conversation_id';
  idGate: RegExp;
  /** Accepted events; false where delivery is best effort, so printing there records nothing. */
  events: ReadonlyMap<string, boolean>;
  output: (event: string, context: string) => unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codex and Cursor do not document their id format, so the gate is a bounded character class. */
const VENDOR_ID = /^[A-Za-z0-9_.:-]{4,128}$/;
const hookSpecificOutput = (event: string, context: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });

/** The design record's host table (docs/design/agent-conversations.md, Hooks). */
const HOOK_HOSTS: ReadonlyMap<string, HookHostSpec> = new Map<HookHost, HookHostSpec>([
  ['claude-code', {
    idField: 'session_id', idGate: UUID, output: hookSpecificOutput,
    events: new Map([['UserPromptSubmit', true], ['PostToolUse', true]]),
  }],
  ['codex', {
    idField: 'session_id', idGate: VENDOR_ID, output: hookSpecificOutput,
    events: new Map([['SessionStart', true], ['UserPromptSubmit', true], ['PostToolUse', true]]),
  }],
  ['cursor', {
    idField: 'conversation_id', idGate: VENDOR_ID, output: (_event, context) => ({ additional_context: context }),
    // Cursor's sessionStart is fire and forget; postToolUse is the delivery path.
    events: new Map([['sessionStart', false], ['postToolUse', true], ['postToolUseFailure', true]]),
  }],
]);

/** One hook call that passed its host's gates. */
export interface HookRequest {
  host: HookHost;
  event: string;
  readerKey: string;
  /** Whether what this call prints is recorded as shown. */
  recordsShown: boolean;
}

/** Null for an unknown host, input that is not a JSON object, an id that fails the gate, or an event the host does not send. */
export function parseHookInput(host: string, stdin: string): HookRequest | null {
  const spec = HOOK_HOSTS.get(host);
  if (spec === undefined) return null;
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return null;
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  const id = fields[spec.idField];
  const event = fields.hook_event_name;
  if (typeof id !== 'string' || !spec.idGate.test(id) || typeof event !== 'string') return null;
  const recordsShown = spec.events.get(event);
  if (recordsShown === undefined) return null;
  return { host: host as HookHost, event, readerKey: `hook:${host}:${id.toLowerCase()}`, recordsShown };
}

const ROOT_QUOTE_CHARS = 60;
/** Per note in hook output, so ten claims and five notes stay under Codex's 2,500-token context limit; tool results keep full text. */
export const HOOK_TEXT_MAX_CHARS = 280;

function clip(text: string): string {
  const points = Array.from(text);
  return points.length <= HOOK_TEXT_MAX_CHARS ? text : `${points.slice(0, HOOK_TEXT_MAX_CHARS - 1).join('')}\u2026`;
}

function quoteRoot(text: string | undefined): string {
  if (text === undefined || text === '') return '';
  return ` (re "${Array.from(text).slice(0, ROOT_QUOTE_CHARS).join('')}")`;
}

/** One line per note; `rootText` adds the thread root's opening words to a reply. */
function line(n: NoteView, rootText?: string): string {
  if (n.kind === 'claim') return `- Claim: ${n.from} holds "${n.subject ?? ''}" until ${n.expires_at ?? ''}${n.text ? ` (${n.text})` : ''}`;
  if (n.kind === 'release') return `- ${n.from} released "${n.subject ?? ''}"${n.text ? ` (${n.text})` : ''}`;
  const to = n.to === 'all' ? '' : ` to ${n.to}`;
  if (n.reply_to !== undefined) return `- Reply from ${n.from}${to}${quoteRoot(rootText)}: ${n.text}`;
  return `- Note from ${n.from}${to}: ${n.text}`;
}

/**
 * What one hook call prints for a block, in its host's shape, and the note ids
 * to record as shown: exactly the notes printed, or none where delivery is
 * best effort. `roots` maps note ids to their text, for reply context.
 */
export function renderHook(request: HookRequest, project: string, block: NotesBlock, roots: ReadonlyMap<string, string>): { output: string; shown: string[] } {
  const short = (n: NoteView): NoteView => ({ ...n, text: clip(n.text) });
  const context = [
    `NorthKeep notes for project "${project}":`,
    ...block.active_claims.map((n) => line(short(n))),
    ...block.notes.map((n) => line(short(n), n.thread === undefined ? undefined : roots.get(n.thread))),
    ...(block.notes_count > block.notes.length ? [`(${block.notes_count - block.notes.length} older unseen notes not shown)`] : []),
    NOTES_NOTICE,
  ].join('\n');
  const output = JSON.stringify(HOOK_HOSTS.get(request.host)!.output(request.event, context));
  return { output, shown: request.recordsShown ? block.notes.map((n) => n.id) : [] };
}

function rootTexts(rows: readonly StoredNote[]): Map<string, string> {
  return new Map(rows.map((r) => [r.id, r.payload.text || (r.payload.subject ?? '')]));
}

export interface NotesHookOptions {
  vaultPath: string;
  project: string;
  /** claude-code, codex or cursor; any other value prints nothing. */
  host: string;
  /** Raw hook input from stdin: JSON with the host's id field and hook_event_name. */
  stdin: string;
  /** Skip when this reader's last recorded check, with or without notes, was less than this many seconds ago. */
  minIntervalSeconds?: number;
  now?: Date;
}


function stampPath(readerKey: string): string {
  const name = crypto.createHash('sha256').update(readerKey).digest('hex').slice(0, 32);
  return path.join(northkeepHome(), 'notes-hook', name);
}

/** True when the last recorded check was recent enough to skip. The stamp holds no content. */
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
 * Returns what the hook prints, in its host's JSON shape, or '' when there is
 * nothing to show or anything goes wrong.
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
  const request = parseHookInput(options.host, options.stdin);
  if (request === null || !isValidProjectSlug(options.project)) return '';
  const { host, readerKey } = request;
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
    const { block } = notesForReader(rows, { readerKey, host, shown: notes.shownFor(readerKey, options.project) }, now);
    const { output, shown } = block === null ? { output: '', shown: [] } : renderHook(request, options.project, block, rootTexts(rows));
    // Recorded before printing: if this write fails the hook prints nothing and the notes stay unseen.
    notes.markShown(options.project, readerKey, host, shown, now);
    // A best-effort call must not throttle the call that actually delivers.
    if (options.minIntervalSeconds !== undefined && request.recordsShown) touchStamp(readerKey);
    if (block === null) return '';
    const printed = [...block.active_claims, ...block.notes];
    appendCallLog({
      ts: now.toISOString(), tool: 'notes_hook', provider: `${host}-hook`, host, ok: true,
      params: { scope: `project:${options.project}` }, result_count: printed.length,
      result_ids: [...new Set(printed.map((n) => n.id))], disclosed_scopes: [`project:${options.project}`],
    });
    return output;
  } finally {
    notes?.close();
    memzero(key);
  }
}

const OWNER_VIEW_THREADS = 20;

/** Claims are listed above with their ids and are never recorded as shown, so they carry no receipt. */
function ownerLine(n: NoteView): string {
  const receipt = n.kind === 'claim' ? '' : n.seen_by?.length ? ` | seen by ${n.seen_by.join(', ')}` : ' | not seen yet';
  return `${n.created_at.slice(0, 16)} ${line(n)}${receipt}`;
}

/** The owner's view: active claims, then the newest threads with replies indented and receipts. */
export function notesOwnerView(vaultPath: string, project: string, master: Buffer, now: Date = new Date()): string {
  const file = notesFilePath(vaultPath);
  if (file === null || !fs.existsSync(file)) return 'No notes on this machine yet.';
  const key = deriveNotesKey(master);
  const notes = NotesFile.open(file, key, { resetOnMismatch: false });
  try {
    const rows = notes.read(project);
    const threads = threadsOf(rows, notes.shownRows(project));
    const views = new Map(threads.flatMap((t) => [t.root, ...t.replies]).map((v) => [v.id, v]));
    const claims = activeClaims(rows, now).map((c) => views.get(c.id)!);
    const newest = threads.slice(0, OWNER_VIEW_THREADS);
    const out = [
      `Active claims (${claims.length}):`,
      ...claims.map((c) => `${line(c)}  [id ${c.id}]`),
      `Newest threads (${newest.length} of ${threads.length}):`,
      ...newest.flatMap((t) => [ownerLine(t.root), ...t.replies.map((r) => `  ${ownerLine(r)}`)]),
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
