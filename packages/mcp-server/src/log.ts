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
  /** Converse (M6): where the outbound call went — host only, never a full
   * URL with credentials, and never content. */
  endpoint_host?: string;
  /** Converse (M6): model id the endpoint was asked for. */
  model?: string;
  /** Converse (M6): privacy badge shown to the user for this turn. */
  privacy?: 'private' | 'bounded';
  /** Converse (M6): vault entries distilled and stored by this turn. */
  created_ids?: string[];
  /** Concierge (M7b): how auto-routing chose the endpoint/model — task kind +
   * endpoint labels only, never content. */
  route_reason?: string;
  /** Agent loop (M10b, ADR 0028): one row per tool call, denials included.
   * Content-free by construction: the URL and the arguments appear ONLY as
   * sha256 hashes plus a length — enough to prove "this exact call happened"
   * against a value the user shows, never enough to recover it from the log. */
  tool_call?: {
    name: string;
    /** Hostname the call egressed to (host only, like endpoint_host). */
    domain?: string;
    /** sha256 of the full egress URL (the URL itself is never logged). */
    url_hash?: string;
    /** sha256 of the plaintext argument JSON (never the arguments). */
    args_hash: string;
    arg_chars: number;
    decision: 'approved' | 'denied' | 'timeout';
    /** Decision provenance (M10c, ADR 0029): the scope the user chose at the
     * prompt, 'auto' when an existing grant satisfied it, 'never' when a
     * persisted deny refused it, 'screen' when the exfiltration screens
     * hard-denied before the gate. */
    scope?: 'once' | 'session' | 'always' | 'never' | 'auto' | 'screen' | 'budget';
    /** Content-free exfil-screen flag descriptors when any fired (ADR 0029),
     * e.g. "secret:ssn:query:decoded" — never matched text. */
    screen?: string[];
    result_bytes?: number;
    ok: boolean;
  };
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
