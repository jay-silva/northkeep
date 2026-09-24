import fs from 'node:fs';
import path from 'node:path';
import { callLogPath } from '@northkeep/core';

/**
 * Content-free call log. Memory content is never written to disk outside the
 * encrypted vault, with one opt-in exception (ADR 0053): project documents the
 * user exports to a git folder they chose. Logged: what was asked of the vault
 * and how much came back, never what it said. One JSON object per line.
 */
export interface CallLogEntry {
  ts: string;
  tool: string;
  /** MCP client that made the call (from its initialize handshake). */
  provider?: string;
  /** One id per server process (ADR 0052), so a session that read a project
   * and never wrote back is derivable from these rows alone. */
  session_id?: string;
  /** The tamed handshake name on its own (ADR 0052 fourth pass): `provider` is
   * name@version, and a name that itself holds an @ split wrongly. */
  host?: string;
  /** Scopes this connection was granted (undefined = full/owner access). */
  granted_scopes?: string[];
  /** Redaction tier applied to returned content (0 = none). */
  redaction_tier?: number;
  /** A Tier 3 whose name model was offline for some text (ADR 0060). */
  redaction_degraded?: boolean;
  /**
   * Log before acting (ADR 0060 Decision 5). A `pending` row (ok:false, error
   * "pending") is written before the call runs; the `done` row with the same
   * call_id carries the outcome. Rows without a phase are read as before.
   */
  phase?: 'pending' | 'done';
  call_id?: string;
  /** When the call finished; `ts` stays the start time. */
  completed_at?: string;
  params: {
    type?: string;
    scope?: string;
    id?: string;
    query_terms?: number;
    content_chars?: number;
    limit?: number;
    /** project_board's stale window, as applied (ADR 0054 Decision 4). */
    stale_days?: number;
  };
  ok: boolean;
  /** 'unknown': a tool call cancelled while in flight, which may still have
   * completed. Readers show it as unknown, not as a failure; ok stays false
   * only because older readers require the field. */
  outcome?: 'unknown';
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
    /** For an MCP tool call (M11, ADR 0033), the configured server id. Such a
     * call has no domain, and a row that named neither would not say WHAT ran.
     * A config value, never model-supplied text, so it stays content-free. */
    mcp_server?: string;
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
    /** Absent when outcome is 'unknown'. */
    ok?: boolean;
    /** 'unknown': cancelled while in flight, so it may still have completed. */
    outcome?: 'unknown';
  };
}

export function appendCallLog(entry: CallLogEntry): void {
  const file = callLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** A pending row with no outcome is shown as this, never as success (ADR 0060 D7). */
export type CallOutcomeLabel = 'in progress' | 'outcome unknown (interrupted)';

export interface FoldedCallLogEntry extends CallLogEntry {
  outcome_label?: CallOutcomeLabel;
}

/** How long an unmatched pending row reads as in progress before it reads as interrupted. */
export const IN_PROGRESS_MS = 5 * 60 * 1000;

/**
 * One row per call for people reading the log: a pending row whose done row
 * exists is dropped (the done row carries the outcome); one without is kept
 * and labelled. Rows without a phase (chat, older builds) pass unchanged.
 */
export function foldCallLog(rows: CallLogEntry[], now: Date = new Date()): FoldedCallLogEntry[] {
  const finished = new Set<string>();
  // The log is a plain local file: a row can be any JSON value, never assume an object.
  const isObject = (row: unknown): row is CallLogEntry => row !== null && typeof row === 'object';
  for (const row of rows) {
    if (isObject(row) && row.phase === 'done' && typeof row.call_id === 'string') finished.add(row.call_id);
  }
  const out: FoldedCallLogEntry[] = [];
  for (const row of rows) {
    if (!isObject(row) || row.phase !== 'pending') {
      out.push(row);
      continue;
    }
    if (typeof row.call_id === 'string' && finished.has(row.call_id)) continue;
    const started = Date.parse(row.ts);
    const label: CallOutcomeLabel = Number.isFinite(started) && now.getTime() - started < IN_PROGRESS_MS
      ? 'in progress'
      : 'outcome unknown (interrupted)';
    out.push({ ...row, outcome_label: label });
  }
  return out;
}

/** Folded, then the last N calls (not the last N raw rows). */
export function readCallLog(lastN?: number): FoldedCallLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(callLogPath(), 'utf8');
  } catch {
    return [];
  }
  const entries = foldCallLog(parseCallLog(raw));
  return lastN === undefined ? entries : entries.slice(-lastN);
}

/**
 * For derivations whose empty answer is a claim, such as "no open sessions".
 * A missing file is a machine with no calls yet, so empty is true; any other
 * read error throws rather than looking like an empty log.
 */
export function readCallLogStrict(): CallLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(callLogPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('The call log exists but could not be read.');
  }
  return parseCallLog(raw);
}

function parseCallLog(raw: string): CallLogEntry[] {
  const entries: CallLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as CallLogEntry);
    } catch {
      // a truncated line (crash mid-append) must not take the whole log down
    }
  }
  return entries;
}
