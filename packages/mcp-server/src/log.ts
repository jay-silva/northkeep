import fs from 'node:fs';
import path from 'node:path';
import { callLogPath } from '@northkeep/core';

/**
 * Content-free call log (invariant: memory content is never written to disk
 * outside the encrypted vault). Logged: what was asked of the vault and how
 * much came back — never what it said. One JSON object per line.
 */
export interface CallLogEntry {
  ts: string;
  tool: string;
  /** MCP client that made the call (from its initialize handshake). */
  provider?: string;
  /** Scopes this connection was granted (undefined = full/owner access). */
  granted_scopes?: string[];
  /** Redaction tier applied to returned content (0 = none). */
  redaction_tier?: number;
  params: {
    type?: string;
    scope?: string;
    id?: string;
    query_terms?: number;
    content_chars?: number;
    limit?: number;
  };
  ok: boolean;
  /** True when the call was refused by a scope grant. */
  denied?: boolean;
  result_count?: number;
  result_id?: string;
  /** Exactly which vault entries were disclosed by this call — the
   * disclosure ledger (ids only, never content). */
  result_ids?: string[];
  /** Distinct scopes of the disclosed entries. */
  disclosed_scopes?: string[];
  error?: string;
}

export function appendCallLog(entry: CallLogEntry): void {
  const file = callLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readCallLog(lastN?: number): CallLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(callLogPath(), 'utf8');
  } catch {
    return [];
  }
  const entries: CallLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as CallLogEntry);
    } catch {
      // a truncated line (crash mid-append) must not take the whole log down
    }
  }
  return lastN === undefined ? entries : entries.slice(-lastN);
}
