/**
 * ADR 0063 D2: which row is a project's live document on the connector.
 * Pure, over rows already decrypted (the stored type column is '' for every
 * encrypted row, so storage cannot tell a document from an archive). Reads
 * only write_seq, pending and base_revision; never created_at.
 *
 * P is the pushed document: the non-pending working row with the highest
 * write_seq. A pending working row is current when its base is P's id, or when
 * there is no P and its base is BASE_NEW. The newest current row is the head,
 * else P. Every other pending working row is stale, legacy rows included: it
 * is never served and never merged into, only delivered to devices to hold.
 */

import { parseProjectSlug } from './project-doc.js';
import { BASE_NEW, type SharedEntry } from './storage.js';

export type ProjectHead =
  | { kind: 'head'; row: SharedEntry }
  /** Two pushed documents share the top write_seq: a vault with several live heads was pushed. */
  | { kind: 'several' }
  | { kind: 'none' };

export interface ProjectScopeView {
  head: ProjectHead;
  /** Ids of pending working rows that are not the head. */
  stale: Set<string>;
}

function newer(a: SharedEntry, b: SharedEntry): boolean {
  const sa = a.writeSeq ?? 0;
  const sb = b.writeSeq ?? 0;
  return sa > sb || (sa === sb && a.entryId > b.entryId);
}

/** The D2 view of one project scope's rows. */
export function projectScopeView(rows: SharedEntry[]): ProjectScopeView {
  const working = rows.filter((e) => e.type === 'working');
  const pushed = working.filter((e) => e.pending !== true);
  const top = Math.max(-1, ...pushed.map((e) => e.writeSeq ?? 0));
  const tied = pushed.filter((e) => (e.writeSeq ?? 0) === top);
  const several = tied.length > 1;
  const p = tied.length === 1 ? tied[0]! : null;

  let current: SharedEntry | null = null;
  const pendingWorking = working.filter((e) => e.pending === true);
  if (!several) {
    for (const c of pendingWorking) {
      const isCurrent = p ? c.baseRevision === p.entryId : c.baseRevision === BASE_NEW;
      if (isCurrent && (current === null || newer(c, current))) current = c;
    }
  }
  const stale = new Set(pendingWorking.filter((e) => e !== current).map((e) => e.entryId));
  const head: ProjectHead = several
    ? { kind: 'several' }
    : current
      ? { kind: 'head', row: current }
      : p
        ? { kind: 'head', row: p }
        : { kind: 'none' };
  return { head, stale };
}

/** Every stale pending document id across the project scopes in `rows`. */
export function staleProjectRowIds(rows: SharedEntry[]): Set<string> {
  const byScope = new Map<string, SharedEntry[]>();
  for (const e of rows) {
    if (parseProjectSlug(e.scope) === null) continue;
    const group = byScope.get(e.scope);
    if (group) group.push(e);
    else byScope.set(e.scope, [e]);
  }
  const out = new Set<string>();
  for (const group of byScope.values()) for (const id of projectScopeView(group).stale) out.add(id);
  return out;
}
