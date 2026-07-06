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

/**
 * CSV cell rendering that is safe to open in a spreadsheet. Two concerns:
 *  - RFC-4180 quoting for commas/quotes/newlines;
 *  - formula injection: a cell starting with = + - @ (or tab/CR) is executed
 *    as a formula by Excel/Sheets. The audit CSV is opened by an auditor and
 *    the provider field is attacker-controlled, so any such cell is neutered
 *    with a leading apostrophe and force-quoted.
 */
function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
