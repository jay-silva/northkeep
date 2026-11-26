import { ClearReplacedError, flatLine, parseProjectSlug, type MemoryEntry, type Vault } from '@northkeep/core';
import { NO_READABLE_TEXT, applyPendingToVault, planDownSync, type AppliedPending, type PendingSnapshot } from './connector-client.js';

/**
 * ADR 0095: what waits for the user's yes, read from the connector's queues
 * and this device's vault, and the one-item Yes and Undo. No network here:
 * the caller fetches, holds the vault, and tells the connector afterwards.
 */

/** Shown for an app whose name is empty once made safe, and for a forget, which records no app. */
export const APP_UNKNOWN = 'a connected app';
const APP_VALUE_MAX = 40;
/** One box shows this many characters before "Show all". */
export const BOX_LIMIT = 280;
/** Two long boxes open this many characters before their first difference. */
export const BOX_LEAD = 40;

/** An app's own name as a value: one line, no quotes or brackets it could use to pose as NorthKeep's words. */
export function appValue(raw: string | null | undefined): string {
  const flat = flatLine(raw ?? '').replace(/["'`«»“”‘’()[\]{}<>]/g, '').replace(/ {2,}/g, ' ').trim();
  let out = '';
  for (const cp of flat) {
    if (out.length + cp.length > APP_VALUE_MAX) break;
    out += cp;
  }
  return out.trim() === '' ? APP_UNKNOWN : out.trim();
}

/** The whole text as one line; a text with no letter or digit reads as the fixed placeholder. */
function boxText(content: string): string {
  const flat = flatLine(content);
  return /[\p{L}\p{N}]/u.test(flat.replace(/[ᅟᅠㅤﾠ]/g, '')) ? flat : NO_READABLE_TEXT;
}

export interface NeedsYesBox {
  label: 'Old' | 'New' | 'Memory';
  /** A vault id, or the connector's id for a memory this sync is about to add. */
  memory_id: string;
  /** The full flattened text. The screen decides how much to show. */
  text: string;
}

export type CloudRequest = { kind: 'replace'; replace_id: string } | { kind: 'forget'; entry_id: string };

export interface NeedsYesItem {
  /** Stable across refreshes: `replace:<replace_id>` or `forget:<entry_id>`. */
  id: string;
  kind: 'replace' | 'forget';
  scope: string;
  /** The app as a safe value. Null for a forget: the connector never recorded who asked. */
  app: string | null;
  /** When the new memory reached this vault; null while it is still only on the connector, and for a forget. */
  arrived: string | null;
  boxes: NeedsYesBox[];
  /** A forget asked for while its collection was shared, which is not Shared on this device now. */
  not_shared_now: boolean;
  request: CloudRequest;
  /** Covers the item id, kind, and every box's memory id, label and full text. Yes refuses when it differs. */
  hash: string;
}

export interface NeedsYesList {
  /** Oldest request first, as the connector queued them: replaces, then forgets. */
  items: NeedsYesItem[];
  /** Changes to projects that only the Mac's review can show. */
  waiting_on_mac: number;
}

function itemHash(id: string, kind: string, boxes: NeedsYesBox[]): string {
  return JSON.stringify([id, kind, boxes.map((b) => [b.memory_id, b.label, b.text])]);
}

/** Writes nothing and sends nothing. Project changes are counted, never listed (ADR 0095 section 1). */
export function listNeedsYes(opts: { vault: Vault; pending: PendingSnapshot }): NeedsYesList {
  const { vault, pending } = opts;
  const plan = planDownSync({ vault, pending });
  const rows = new Map(vault.list({ includeSuperseded: true, includeForgotten: true }).map((e) => [e.id, e]));
  const waitingRows = new Map(pending.entries.map((r) => [r.server_id, r]));
  const shared = new Set(vault.sharedScopes());
  const items: NeedsYesItem[] = [];
  let waitingOnMac = plan.replacements.length + plan.conflicts.length;

  const side = (id: string): { text: string; entry: MemoryEntry | null; app: string | undefined } | null => {
    const entry = rows.get(id);
    if (entry !== undefined) {
      const connector = entry.metadata?.connector;
      const app = connector !== null && typeof connector === 'object' ? (connector as { app?: unknown }).app : undefined;
      return { text: boxText(entry.content), entry, app: typeof app === 'string' ? app : undefined };
    }
    const row = waitingRows.get(id);
    return row !== undefined ? { text: boxText(row.content), entry: null, app: row.app } : null;
  };

  for (const r of plan.cloud_replaces) {
    if (parseProjectSlug(r.scope) !== null) {
      waitingOnMac++;
      continue;
    }
    const oldSide = side(r.old_id);
    const newSide = side(r.new_id);
    if (oldSide === null || newSide === null) continue;
    const id = `replace:${r.replace_id}`;
    const boxes: NeedsYesBox[] = [
      { label: 'Old', memory_id: r.old_id, text: oldSide.text },
      { label: 'New', memory_id: r.new_id, text: newSide.text },
    ];
    items.push({
      id,
      kind: 'replace',
      scope: r.scope,
      app: appValue(newSide.app),
      arrived: newSide.entry?.created_at ?? null,
      boxes,
      not_shared_now: false,
      request: { kind: 'replace', replace_id: r.replace_id },
      hash: itemHash(id, 'replace', boxes),
    });
  }

  for (const f of plan.forgets) {
    if (parseProjectSlug(f.scope) !== null) {
      waitingOnMac++;
      continue;
    }
    const memory = side(f.entry_id);
    if (memory === null) continue;
    const id = `forget:${f.entry_id}`;
    const boxes: NeedsYesBox[] = [{ label: 'Memory', memory_id: f.entry_id, text: memory.text }];
    items.push({
      id,
      kind: 'forget',
      scope: f.scope,
      app: null,
      arrived: null,
      boxes,
      not_shared_now: !shared.has(f.scope),
      request: { kind: 'forget', entry_id: f.entry_id },
      hash: itemHash(id, 'forget', boxes),
    });
  }
  return { items, waiting_on_mac: waitingOnMac };
}

export interface BoxWindow {
  /** The slice to draw before "Show all". */
  text: string;
  /** The slice starts after the text's start: draw "…" before it. */
  cut_start: boolean;
  /** More text follows the slice. */
  cut_end: boolean;
}

/** Never cut between the two halves of one character. */
function safeIndex(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

/**
 * How much of each box to draw before "Show all" (ADR 0095 section 3). One
 * long text shows its first 280 characters. Two texts, when either is long,
 * both open 40 characters before the first place they differ, so a long shared
 * opening cannot hide the change.
 */
export function boxWindows(texts: string[]): BoxWindow[] {
  if (texts.every((t) => t.length <= BOX_LIMIT)) return texts.map((text) => ({ text, cut_start: false, cut_end: false }));
  let start = 0;
  if (texts.length === 2) {
    const [a, b] = texts as [string, string];
    let diff = 0;
    while (diff < a.length && diff < b.length && a[diff] === b[diff]) diff++;
    start = Math.max(0, diff - BOX_LEAD);
  }
  return texts.map((text) => {
    const from = safeIndex(text, Math.min(start, text.length));
    const to = safeIndex(text, Math.min(text.length, from + BOX_LIMIT));
    return { text: text.slice(from, to), cut_start: from > 0, cut_end: to < text.length };
  });
}

/** True when some text is not fully drawn: the action stays disabled until "Show all" has been opened. */
export function needsShowAll(item: Pick<NeedsYesItem, 'boxes'>): boolean {
  return boxWindows(item.boxes.map((b) => b.text)).some((w) => w.cut_start || w.cut_end);
}

/** What this device keeps about a Yes it applied: ids, kind and time. Never text. */
export interface YesRecord {
  /** The item id it answered. */
  id: string;
  kind: 'replace' | 'forget';
  at: string;
  /** Replace: the vault ids marked. */
  old_id?: string;
  new_id?: string;
  /** Forget: the vault id forgotten. */
  entry_id?: string;
  undone_at?: string;
}

export type YesOutcome =
  | { status: 'gone' }
  | { status: 'changed'; item: NeedsYesItem }
  | { status: 'applied'; applied: AppliedPending; record: YesRecord };

/**
 * One Yes, inside the caller's vault section, on a snapshot fetched just
 * before it. Refuses when the item is no longer waiting or is not what was
 * shown. Applies that one request plus the additions this sync carries, and saves.
 */
export function applyYesToVault(opts: {
  vault: Vault;
  pending: PendingSnapshot;
  clientLabel: string;
  itemId: string;
  shownHash: string;
  now?: Date;
}): YesOutcome {
  const item = listNeedsYes(opts).items.find((i) => i.id === opts.itemId);
  if (item === undefined) return { status: 'gone' };
  if (item.hash !== opts.shownHash) return { status: 'changed', item };
  const approve = item.request.kind === 'replace' ? { replace_ids: [item.request.replace_id] } : { forget_ids: [item.request.entry_id] };
  const applied = applyPendingToVault({ vault: opts.vault, pending: opts.pending, clientLabel: opts.clientLabel, approve });
  const at = (opts.now ?? new Date()).toISOString();
  if (item.request.kind === 'replace') {
    const replaceId = item.request.replace_id;
    const done = applied.applied_replaces.find((r) => r.replace_id === replaceId);
    // The vault refused the mark (it can never apply): the request is settled, and nothing was replaced.
    if (done === undefined) return { status: 'gone' };
    return { status: 'applied', applied, record: { id: item.id, kind: 'replace', at, old_id: done.old_id, new_id: done.new_id } };
  }
  if (!applied.applied_forgets.includes(item.request.entry_id)) return { status: 'gone' };
  return { status: 'applied', applied, record: { id: item.id, kind: 'forget', at, entry_id: item.request.entry_id } };
}

export interface YesAcks {
  /** Safe to send straight after the save: rows added, and requests with nothing left to change. */
  now: { acked: Array<{ server_id: string; local_entry_id: string }>; forgets: string[]; replaces: string[] };
  /** What this device applied. Null with a vault sync server: another device's push, or the connector, settles those. */
  later: { forgets: string[]; replaces: string[] } | null;
}

/**
 * ADR 0095 sections 4 and 5: a device that shares its vault through a sync
 * server acknowledges nothing it applied, because a later push from another
 * copy can still undo it. A device with the only copy acknowledges after its
 * own Cloud Connect push.
 */
export function splitYesAcks(applied: AppliedPending, hasSyncServer: boolean): YesAcks {
  const appliedForgets = new Set(applied.applied_forgets);
  const appliedReplaces = new Set(applied.applied_replaces.map((r) => r.replace_id));
  const settledForgets = applied.forgets.filter((id) => !appliedForgets.has(id));
  const settledReplaces = applied.replaces.filter((id) => !appliedReplaces.has(id));
  return {
    now: { acked: applied.acked, forgets: settledForgets, replaces: hasSyncServer ? [] : settledReplaces },
    later: hasSyncServer ? null : { forgets: [...appliedForgets], replaces: [...appliedReplaces] },
  };
}

export interface AcceptedLine {
  /** The Yes record's item id. */
  id: string;
  kind: 'replace' | 'forget';
  at: string;
  state: 'applied' | 'undone';
  /** The memory that replaced the old one, whole and flattened. Null for a forget: its text is gone. */
  box: { label: 'New'; memory_id: string; text: string } | null;
  /** Replace: the text that was retired. */
  retired: string | null;
  can_undo: boolean;
  /** Covers both memories' ids and full texts and whether the mark still stands. Undo refuses when it differs. */
  hash: string;
}

/** "Accepted lately" for the Yes records this device kept, newest first. Text comes from the vault, never the record. */
export function listAccepted(opts: { vault: Vault; records: YesRecord[] }): AcceptedLine[] {
  const rows = new Map(opts.vault.list({ includeSuperseded: true, includeForgotten: true }).map((e) => [e.id, e]));
  const lines: AcceptedLine[] = [];
  for (const record of opts.records) {
    const state = record.undone_at !== undefined ? 'undone' : 'applied';
    if (record.kind === 'forget') {
      lines.push({ id: record.id, kind: 'forget', at: record.at, state, box: null, retired: null, can_undo: false, hash: JSON.stringify([record.id, 'forget']) });
      continue;
    }
    const old = record.old_id !== undefined ? rows.get(record.old_id) : undefined;
    const next = record.new_id !== undefined ? rows.get(record.new_id) : undefined;
    const readable = (e: MemoryEntry | undefined): string | null => (e === undefined || e.forgotten_at !== null ? null : boxText(e.content));
    const newText = readable(next);
    const oldText = readable(old);
    const marked = old !== undefined && next !== undefined && old.superseded_by === next.id && old.forgotten_at === null && next.forgotten_at === null;
    lines.push({
      id: record.id,
      kind: 'replace',
      at: record.at,
      state,
      box: next !== undefined && newText !== null ? { label: 'New', memory_id: next.id, text: newText } : null,
      retired: oldText,
      can_undo: state === 'applied' && marked,
      hash: JSON.stringify([record.id, 'replace', record.old_id ?? null, oldText, record.new_id ?? null, newText, marked]),
    });
  }
  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export type UndoOutcome = { status: 'undone' } | { status: 'changed' } | { status: 'refused'; reason: string };

/** One Undo of a replace this device applied, inside the caller's vault section. Saves on success. */
export function applyUndoToVault(opts: { vault: Vault; record: YesRecord; shownHash: string }): UndoOutcome {
  const line = listAccepted({ vault: opts.vault, records: [opts.record] })[0];
  if (line === undefined || line.hash !== opts.shownHash) return { status: 'changed' };
  if (opts.record.kind !== 'replace' || opts.record.old_id === undefined || opts.record.new_id === undefined) {
    return { status: 'refused', reason: 'a forgotten memory cannot be brought back' };
  }
  try {
    opts.vault.clearReplaced(opts.record.old_id, opts.record.new_id);
  } catch (err) {
    if (err instanceof ClearReplacedError) return { status: 'refused', reason: err.reason };
    throw err;
  }
  opts.vault.save();
  return { status: 'undone' };
}
