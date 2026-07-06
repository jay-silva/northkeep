import { readCallLog, type CallLogEntry } from './log.js';

/**
 * The audit export (M4): the call log rendered for a human auditor — who
 * (provider) asked what of the vault, under which scope grant, what was
 * disclosed (entry ids + their scopes), whether it was denied, and at which
 * redaction tier. Still content-free: entry ids and scope labels only, never
 * memory content.
 */

const COLUMNS = [
  'timestamp',
  'provider',
  'tool',
  'ok',
  'denied',
  'granted_scopes',
  'redaction_tier',
  'result_count',
  'disclosed_scopes',
  'disclosed_ids',
  'error',
] as const;

export function auditAsJson(lastN?: number): CallLogEntry[] {
  return readCallLog(lastN);
}

export function auditAsCsv(lastN?: number): string {
  const rows = readCallLog(lastN);
  const lines = [COLUMNS.join(',')];
  for (const e of rows) {
    lines.push(
      [
        e.ts,
        e.provider ?? '',
        e.tool,
        String(e.ok),
        String(e.denied ?? false),
        (e.granted_scopes ?? ['(all)']).join(' '),
        String(e.redaction_tier ?? 0),
        e.result_count ?? '',
        (e.disclosed_scopes ?? []).join(' '),
        (e.result_ids ?? []).join(' '),
        e.error ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** RFC-4180 quoting: wrap in quotes if the cell has a comma, quote, or newline. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
