/**
 * The Review tab's decisions (ADR 0095), with no React Native or Expo imports
 * so they are unit-tested under Node in apps/mobile/test/needs-yes-flow.test.ts,
 * like connect-flow. The screen (app/review.tsx) and VaultSession wire the
 * ports and stay thin.
 *
 * What this module holds to:
 *  - Yes and Undo change the vault only when this phone holds the copy the
 *    sync server holds, the item is still waiting, and it is what was shown.
 *  - With a sync server, the phone acknowledges nothing it applied: another
 *    copy of the vault can still win, and an unacknowledged request asks again.
 *  - Cloud Connect is told only after a clean vault push, never after one the
 *    phone had to recover from.
 *  - No and Not now never touch the vault.
 */

import {
  OlderConnectorError,
  needsShowAll,
  splitYesAcks,
  type AcceptedLine,
  type CloudRequest,
  type NeedsYesItem,
  type NeedsYesList,
  type PendingSnapshot,
  type UndoOutcome,
  type YesOutcome,
  type YesRecord,
} from '@northkeep/sync';

export const REVIEW_NOT_IN_SYNC = 'This phone is not in sync with your other devices yet, so nothing changed. Let sync finish, then try again.';
export const REVIEW_CHANGED = 'This changed since you looked, so nothing changed. Here is the new version.';
export const REVIEW_SETTLED = 'Already decided on another device.';
export const REVIEW_SHOW_ALL_FIRST = 'Open "Show all" to read the whole text first.';
export const REVIEW_OLDER_CONNECTOR = "NorthKeep's server could not record that yet. Nothing changed; try again later.";
export const REVIEW_SAVED_NOT_LISTED = 'Saved on this phone, but this phone could not list it under Accepted lately, so it cannot be undone here.';
export const REVIEW_SAVED_NOT_SENT = 'Saved on this phone. Your AI apps will see it after your devices next sync.';
export const reviewUndoRefused = (reason: string): string => `This can't be undone here: ${reason}.`;

/** What the phone keeps outside the vault: ids, kinds and times. Never memory text. */
export interface ReviewState {
  /** Every Yes given on this phone, newest first. */
  records: YesRecord[];
  /** Item id to the instant its "Not now" ends. */
  notNow: Record<string, string>;
  /** The item ids of the last refresh, for the count between refreshes. */
  lastItemIds: string[];
}

export const EMPTY_REVIEW_STATE: ReviewState = { records: [], notNow: {}, lastItemIds: [] };

/** How the vault push after a save ended. Only a clean one may be followed by a Cloud Connect push. */
export type VaultPushOutcome =
  | { kind: 'clean'; version: number }
  | { kind: 'recovered' }
  | { kind: 'no-server' }
  | { kind: 'failed' };

export interface ReviewPorts {
  now(): Date;
  loadState(): Promise<ReviewState>;
  saveState(state: ReviewState): Promise<void>;
  /** `no-server`: no vault sync is set up. `behind`: the phone's vault file is not the sync server's copy. */
  syncCheck(): Promise<'in-sync' | 'behind' | 'no-server'>;
  /** `/client/pending?v=3`, outside the vault gate. */
  fetchPending(): Promise<PendingSnapshot>;
  /** Under the vault gate; writes nothing. */
  list(pending: PendingSnapshot): Promise<NeedsYesList>;
  accepted(records: YesRecord[]): Promise<AcceptedLine[]>;
  /** Under the vault gate: re-check, apply one request, save. */
  applyYes(pending: PendingSnapshot, itemId: string, shownHash: string): Promise<YesOutcome>;
  applyUndo(record: YesRecord, shownHash: string): Promise<UndoOutcome>;
  ack(body: { acked: Array<{ server_id: string; local_entry_id: string }>; forgets: string[]; replaces: string[] }): Promise<void>;
  decline(request: CloudRequest): Promise<{ settled: boolean }>;
  /** Push the saved vault to the sync server, as every save on the phone does. */
  pushVault(): Promise<VaultPushOutcome>;
  /** Push the Shared collections to Cloud Connect, stamped with the vault version, or unstamped with no sync server. */
  pushCloud(vaultVersion: number | null): Promise<void>;
  setBadge(count: number): Promise<void>;
}

export interface ReviewView {
  /** What needs a yes and is not hidden by Not now. */
  items: NeedsYesItem[];
  /** Hidden until midnight on this phone. */
  hidden: number;
  waiting_on_mac: number;
  accepted: AcceptedLine[];
  checked_at: string;
}

/** Local midnight after `now`: when a "Not now" ends. */
export function nextMidnight(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(24, 0, 0, 0);
  return d;
}

/** Drops Not now entries that have ended. */
function liveNotNow(notNow: Record<string, string>, now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, until] of Object.entries(notNow)) if (new Date(until).getTime() > now.getTime()) out[id] = until;
  return out;
}

/** The count for the tab and the icon, from what the phone last saw: no network, no vault. */
export function reviewCount(state: ReviewState, now: Date): number {
  const hidden = liveNotNow(state.notNow, now);
  return state.lastItemIds.filter((id) => !(id in hidden)).length;
}

/** Read the queues and the vault; write nothing to either. Updates the kept ids and the badge. */
export async function refreshReview(ports: ReviewPorts): Promise<ReviewView> {
  const pending = await ports.fetchPending();
  const needs = await ports.list(pending);
  const now = ports.now();
  const state = await ports.loadState();
  const notNow = liveNotNow(state.notNow, now);
  const items = needs.items.filter((i) => !(i.id in notNow));
  const next: ReviewState = { records: state.records, notNow, lastItemIds: needs.items.map((i) => i.id) };
  await ports.saveState(next);
  await ports.setBadge(items.length);
  return {
    items,
    hidden: needs.items.length - items.length,
    waiting_on_mac: needs.waiting_on_mac,
    accepted: await ports.accepted(next.records),
    checked_at: now.toISOString(),
  };
}

export type ReviewResult =
  /** Done. `note` is set when the change is saved here but did not reach Cloud Connect yet. */
  | { kind: 'done'; note?: string }
  /** Nothing changed; show this fixed message. */
  | { kind: 'refused'; message: string }
  /** Nothing changed; the item is different now and must be drawn again. */
  | { kind: 'changed'; message: string; item?: NeedsYesItem };

/** Steps 6 and 7 of ADR 0095 section 4: push the vault, then tell Cloud Connect only when that was clean. */
async function pushAfterDecision(
  ports: ReviewPorts,
  hasSyncServer: boolean,
  later: { forgets: string[]; replaces: string[] } | null,
  tellCloud = true,
): Promise<string | undefined> {
  try {
    // The vault is already saved, so its push runs whatever failed before it.
    const pushed = await ports.pushVault();
    if (!tellCloud) return REVIEW_SAVED_NOT_SENT;
    if (hasSyncServer) {
      if (pushed.kind !== 'clean') return REVIEW_SAVED_NOT_SENT;
      await ports.pushCloud(pushed.version);
      return undefined;
    }
    await ports.pushCloud(null);
    if (later !== null) await ports.ack({ acked: [], forgets: later.forgets, replaces: later.replaces });
    return undefined;
  } catch {
    // The decision is saved in the vault. A Mac's push, or the next one here, carries it.
    return REVIEW_SAVED_NOT_SENT;
  }
}

/** One Yes. `opened` says the person has opened "Show all" on this card. */
export async function yesReview(ports: ReviewPorts, item: Pick<NeedsYesItem, 'id' | 'hash' | 'boxes'>, opened: boolean): Promise<ReviewResult> {
  if (needsShowAll(item) && !opened) return { kind: 'refused', message: REVIEW_SHOW_ALL_FIRST };
  const sync = await ports.syncCheck();
  if (sync === 'behind') return { kind: 'refused', message: REVIEW_NOT_IN_SYNC };
  const hasSyncServer = sync === 'in-sync';
  const pending = await ports.fetchPending();
  const out = await ports.applyYes(pending, item.id, item.hash);
  if (out.status === 'changed') return { kind: 'changed', message: REVIEW_CHANGED, item: out.item };
  if (out.status === 'gone') {
    // The run may still have saved something: acknowledge its additions, and push the vault that now holds it.
    const a = out.applied;
    if (a !== undefined && a.acked.length + a.applied_forgets.length + a.applied_replaces.length > 0) {
      // An acknowledgement that fails only makes the connector offer those additions again.
      if (a.acked.length > 0) await ports.ack({ acked: a.acked, forgets: [], replaces: [] }).catch(() => undefined);
      await ports.pushVault().catch(() => undefined);
    }
    return { kind: 'refused', message: REVIEW_SETTLED };
  }
  // From here the vault holds the decision. Nothing below may throw past the vault push,
  // or the screen would report a failure for a change that is saved.
  const listed = await keepRecords(ports, (records) => [out.record, ...records.filter((r) => r.id !== out.record.id)]);
  const acks = splitYesAcks(out.applied, hasSyncServer);
  const acked = await ports.ack(acks.now).then(() => true, () => false);
  const note = await pushAfterDecision(ports, hasSyncServer, acks.later, acked);
  if (!listed) return { kind: 'done', note: REVIEW_SAVED_NOT_LISTED };
  return note === undefined ? { kind: 'done' } : { kind: 'done', note };
}

/** Rewrites the Yes records on the state as it is now, so a refresh that ran meanwhile keeps its Not now and ids. */
async function keepRecords(ports: ReviewPorts, change: (records: YesRecord[]) => YesRecord[]): Promise<boolean> {
  try {
    const state = await ports.loadState();
    await ports.saveState({ ...state, records: change(state.records) });
    return true;
  } catch {
    return false;
  }
}

/** One Undo of a Yes given on this phone, as careful as the Yes. */
export async function undoReview(ports: ReviewPorts, line: Pick<AcceptedLine, 'id' | 'hash'>): Promise<ReviewResult> {
  const sync = await ports.syncCheck();
  if (sync === 'behind') return { kind: 'refused', message: REVIEW_NOT_IN_SYNC };
  const state = await ports.loadState();
  const record = state.records.find((r) => r.id === line.id && r.undone_at === undefined);
  if (record === undefined) return { kind: 'changed', message: REVIEW_CHANGED };
  const out = await ports.applyUndo(record, line.hash);
  if (out.status === 'changed') return { kind: 'changed', message: REVIEW_CHANGED };
  if (out.status === 'refused') return { kind: 'refused', message: reviewUndoRefused(out.reason) };
  const undoneAt = ports.now().toISOString();
  const listed = await keepRecords(ports, (records) => records.map((r) => (r.id === record.id && r.undone_at === undefined ? { ...r, undone_at: undoneAt } : r)));
  const note = await pushAfterDecision(ports, sync === 'in-sync', null);
  if (!listed) return { kind: 'done', note: REVIEW_SAVED_NOT_LISTED };
  return note === undefined ? { kind: 'done' } : { kind: 'done', note };
}

/** One No: drop the request on the connector. The vault is untouched, so no in-sync check. */
export async function noReview(ports: ReviewPorts, item: Pick<NeedsYesItem, 'request'>): Promise<ReviewResult> {
  try {
    const { settled } = await ports.decline(item.request);
    return settled ? { kind: 'done' } : { kind: 'refused', message: REVIEW_SETTLED };
  } catch (err) {
    if (err instanceof OlderConnectorError) return { kind: 'refused', message: REVIEW_OLDER_CONNECTOR };
    throw err;
  }
}

/** Hide one item on this phone until local midnight. Nothing is sent. */
export async function notNowReview(ports: ReviewPorts, item: Pick<NeedsYesItem, 'id'>): Promise<void> {
  const now = ports.now();
  const state = await ports.loadState();
  const notNow = { ...liveNotNow(state.notNow, now), [item.id]: nextMidnight(now).toISOString() };
  const next = { ...state, notNow };
  await ports.saveState(next);
  await ports.setBadge(reviewCount(next, now));
}

/** Reads kept state defensively: a damaged value starts empty rather than throwing on every open. */
export function parseReviewState(raw: string | null): ReviewState {
  if (raw === null) return EMPTY_REVIEW_STATE;
  try {
    const v = JSON.parse(raw) as Partial<ReviewState> | null;
    if (v === null || typeof v !== 'object') return EMPTY_REVIEW_STATE;
    const records = Array.isArray(v.records)
      ? v.records.filter((r): r is YesRecord => r !== null && typeof r === 'object' && typeof r.id === 'string' && (r.kind === 'replace' || r.kind === 'forget') && typeof r.at === 'string')
      : [];
    const notNow: Record<string, string> = {};
    if (v.notNow !== null && typeof v.notNow === 'object') {
      for (const [id, until] of Object.entries(v.notNow)) if (typeof until === 'string') notNow[id] = until;
    }
    const lastItemIds = Array.isArray(v.lastItemIds) ? v.lastItemIds.filter((id): id is string => typeof id === 'string') : [];
    return { records, notNow, lastItemIds };
  } catch {
    return EMPTY_REVIEW_STATE;
  }
}
