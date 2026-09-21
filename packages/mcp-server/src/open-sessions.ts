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

interface Tracked {
  opened_at: string;
  last_read_at: string;
  last_write_at: string | null;
  host: string;
}

/** The handshake name half of a provider string ("name@version"). */
function hostOf(provider: string | undefined): string {
  if (!provider) return 'unknown';
  return provider.split('@')[0] || 'unknown';
}

export function openSessions(
  rows: CallLogEntry[],
  scope: string,
  currentSessionId: string,
  now: Date,
  days = 30,
): OpenSession[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const tracked = new Map<string, Tracked>();
  for (const row of rows) {
    const session = row.session_id;
    if (!session || session === currentSessionId) continue;
    if (row.params?.scope !== scope) continue;
    const isRead = READ_TOOLS.has(row.tool);
    const isWrite = row.ok === true && WRITE_TOOLS.has(row.tool);
    if (!isRead && !isWrite) continue;
    const at = Date.parse(row.ts);
    if (Number.isNaN(at)) continue;
    // Only reads are windowed: an old write still closes a read it precedes,
    // and a write after the read closes the session whenever it happened.
    if (isRead && at < cutoff) continue;
    const seen = tracked.get(session);
    if (isRead) {
      if (seen === undefined) {
        tracked.set(session, {
          opened_at: row.ts,
          last_read_at: row.ts,
          last_write_at: null,
          host: hostOf(row.provider),
        });
      } else if (Date.parse(seen.last_read_at) <= at) {
        seen.last_read_at = row.ts;
        seen.host = hostOf(row.provider);
      }
    } else if (seen !== undefined) {
      if (seen.last_write_at === null || Date.parse(seen.last_write_at) < at) {
        seen.last_write_at = row.ts;
      }
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
