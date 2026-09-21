import { isProjectScope, parseProjectSlug } from '@northkeep/core';
import type { CallLogEntry } from './log.js';

/**
 * Open sessions (ADR 0052 Decision 2), derived from the call log rather than
 * stored: resume stays a read, so nothing is written to the vault when a
 * project is opened. A session is open when it read the project and no
 * successful write from the same session followed that read.
 *
 * Pure over rows so it is testable without a vault, a server, or a clock.
 * The call log is per machine, so hosted sessions are invisible here.
 */

export interface OpenSession {
  session_id: string;
  host: string;
  opened_at: string;
  last_read_at: string;
}

export const OPEN_SESSIONS_NOTE =
  'These sessions read this project and did not write back. Nothing was recorded on their behalf.';

const READ_TOOLS = new Set(['project_get', 'project_resume']);
const WRITE_TOOLS = new Set(['project_update', 'project_checkpoint', 'project_wrap']);

const MAX_OPEN_SESSIONS = 3;

/** The shape the provenance block demands of a writer, for the same reason. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const HOST_MAX_CHARS = 80;

interface Tracked {
  opened_at: string;
  last_read_at: string;
  last_write_at: string | null;
  host: string;
}

interface ValidRow {
  session_id: string;
  host: string;
  ts: string;
  at: number;
  isRead: boolean;
}

/**
 * The handshake name half of a provider string ("name@version"), stripped of
 * control characters and capped. The call log is a plain local file, so a row
 * is attacker-shaped input to a brief the model reads: a host must never carry
 * newlines into it. Null when nothing usable survives.
 */
function hostOf(provider: unknown): string | null {
  if (typeof provider !== 'string') return null;
  const host = (provider.split('@')[0] ?? '').replace(CONTROL_CHARS, '').slice(0, HOST_MAX_CHARS);
  return host.length > 0 ? host : null;
}

/** Null for a row malformed in any field. A bad row is skipped, never fatal. */
function validateRow(row: CallLogEntry, scope: string, currentSessionId: string): ValidRow | null {
  if (!row || typeof row !== 'object') return null;
  const session_id = row.session_id;
  if (typeof session_id !== 'string' || !SESSION_ID_PATTERN.test(session_id)) return null;
  if (session_id === currentSessionId) return null;
  const rowScope = row.params?.scope;
  if (typeof rowScope !== 'string' || !isProjectScope(rowScope)) return null;
  if (parseProjectSlug(rowScope) === null || rowScope !== scope) return null;
  if (typeof row.tool !== 'string') return null;
  // A denied read disclosed nothing, so it never opens a session.
  const isRead = row.ok === true && READ_TOOLS.has(row.tool);
  const isWrite = row.ok === true && WRITE_TOOLS.has(row.tool);
  if (!isRead && !isWrite) return null;
  if (typeof row.ts !== 'string') return null;
  const at = Date.parse(row.ts);
  if (Number.isNaN(at)) return null;
  const host = hostOf(row.provider);
  if (host === null) return null;
  return { session_id, host, ts: row.ts, at, isRead };
}

export function openSessions(
  rows: CallLogEntry[],
  scope: string,
  currentSessionId: string,
  now: Date,
  days = 30,
): OpenSession[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const valid: ValidRow[] = [];
  for (const row of rows ?? []) {
    const parsed = validateRow(row, scope, currentSessionId);
    if (parsed !== null) valid.push(parsed);
  }
  // Derive in time order, not file order: a write appended out of order still
  // closes the read it followed. Sort is stable, so ties keep file order.
  valid.sort((a, b) => a.at - b.at);
  const tracked = new Map<string, Tracked>();
  for (const row of valid) {
    // Only reads are windowed: an old write still closes a read it precedes,
    // and a write after the read closes the session whenever it happened.
    if (row.isRead && row.at < cutoff) continue;
    const seen = tracked.get(row.session_id);
    if (row.isRead) {
      if (seen === undefined) {
        tracked.set(row.session_id, {
          opened_at: row.ts,
          last_read_at: row.ts,
          last_write_at: null,
          host: row.host,
        });
      } else {
        seen.last_read_at = row.ts;
        seen.host = row.host;
      }
    } else if (seen !== undefined) {
      seen.last_write_at = row.ts;
    }
  }
  const open: OpenSession[] = [];
  for (const [session_id, t] of tracked) {
    if (t.last_write_at !== null && Date.parse(t.last_write_at) >= Date.parse(t.last_read_at)) continue;
    open.push({ session_id, host: t.host, opened_at: t.opened_at, last_read_at: t.last_read_at });
  }
  open.sort((a, b) => Date.parse(b.last_read_at) - Date.parse(a.last_read_at));
  return open.slice(0, MAX_OPEN_SESSIONS);
}
