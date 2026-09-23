/**
 * The project board (ADR 0054 Decision 1): stale, dated items, open
 * sessions, drafts and needs repair, computed from data the caller already
 * loaded. Pure: no vault handle, no clock beyond the injected `now`, no I/O,
 * no model, no network. The call-log read and payload assembly live in
 * mcp-server and the CLI; core only shapes rows.
 *
 * Every text field passes tameBoardText (Decision 3) before it is returned,
 * and every section is capped at BOARD_SECTION_CAP rows with its total, so
 * the payload has a ceiling for any number of projects and any document size.
 */
import type { ProjectSummary, ProjectView } from './project-handoff.js';
import { importLogEntryDate, splitImportedLogEntries } from './project-import.js';
import { tameOneLine } from './text-safe.js';

export const BOARD_SECTION_CAP = 50;
export const BOARD_STATUS_MAX_CHARS = 120;
export const BOARD_LINE_MAX_CHARS = 160;
export const BOARD_HOST_MAX_CHARS = 80;
export const BOARD_OPEN_SESSIONS_PER_PROJECT = 3;
export const BOARD_DEFAULT_STALE_DAYS = 14;
export const BOARD_MAX_STALE_DAYS = 3650;

export const BOARD_DONE_RULE =
  'A project counts as Done only when the first line of its Current Status that is not empty once cleaned (the line the board shows) begins with the word Done, ' +
  'Complete or Completed, followed by the end of the line or by a period, colon or exclamation mark. ' +
  'Anything else is active. There is no state field; this is a text convention.';

export const BOARD_FENCE_MARKERS = ['===BEGIN MEMORY DATA===', '===END MEMORY DATA==='] as const;

/** Every line terminator a reader honours, not only \n (ADR 0052's round-2 lesson). */
const LINE_TERMINATORS = /\r\n|[\r\n\u0085\u2028\u2029]/;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BoardSection<T> { total: number; shown: number; rows: T[] }
export interface BoardStaleRow { project: string; last_activity: string; activity_source: 'last write' | 'last log entry'; status: string }
export interface BoardDatedRow { date: string; project: string; line: string }
export interface BoardOpenSessionRow { project: string; session_id: string; host: string; opened_at: string; last_read_at: string }
export interface BoardDraftRow { project: string; updated_at: string }
export interface BoardRepairRow { project: string; reason: 'conflict' | 'unreadable' }
export type BoardOpenSessions = BoardSection<BoardOpenSessionRow> | { unavailable: string };

export interface ProjectBoard {
  generated_at: string;
  stale_days: number;
  done_rule: string;
  stale: BoardSection<BoardStaleRow>;
  dated: BoardSection<BoardDatedRow>;
  open_sessions: BoardOpenSessions;
  drafts: BoardSection<BoardDraftRow>;
  needs_repair: BoardSection<BoardRepairRow>;
}

/** The fields the board reads from a document. A whole ProjectView fits. */
export type BoardView = Pick<ProjectView, 'status' | 'next_actions' | 'open_questions' | 'log'>;

/** Already derived per project (newest first), as mcp-server's openSessions returns them. */
export interface BoardSessionInput { session_id: string; host: string; opened_at: string; last_read_at: string }

export interface BuildBoardInput {
  summaries: ProjectSummary[];
  /** Keyed by slug. A non-conflicted summary with no view here is unreadable. */
  views: ReadonlyMap<string, BoardView>;
  now: Date;
  staleDays: number;
  /** Per project slug, or the reason the call log could not be read. */
  openSessions: ReadonlyMap<string, BoardSessionInput[]> | { unavailable: string };
}

/** Code-point order, so the sort never depends on the machine's locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One linear pass over text tameOneLine has already cleaned: whitespace
 * collapses as it is pushed, and a marker is popped the moment it completes,
 * so a marker assembled by removing another (nested, or joined across a
 * collapsed space) is removed in the same pass. The output holds no marker.
 */
function stripFenceMarkers(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    const c = /\s/.test(ch) ? ' ' : ch;
    if (c === ' ' && out[out.length - 1] === ' ') continue;
    out.push(c);
    for (const marker of BOARD_FENCE_MARKERS) {
      if (out.length >= marker.length && out.slice(out.length - marker.length).join('') === marker) {
        out.length -= marker.length;
        break;
      }
    }
  }
  return out.join('');
}

/**
 * tameOneLine, then fence removal, then the cut. Linear in the input: the
 * removal cannot reintroduce anything tameOneLine removes, so no second
 * round is needed.
 */
export function tameBoardText(input: string, max: number): string {
  return tameOneLine(stripFenceMarkers(tameOneLine(input, Number.MAX_SAFE_INTEGER)), max);
}

export function splitBoardLines(text: string): string[] {
  return text.split(LINE_TERMINATORS);
}

/** ADR 0054's narrowed Done rule, over the displayed first line of Current Status. */
export function isProjectDone(status: string): boolean {
  // The same cleaned line the board displays, so an invisible character in
  // front of "Done." cannot make the rule and the display disagree.
  return /^(?:done|complete|completed)(?:$|[.:!])/i.test(boardStatusLine(status));
}

/** One line for display: the first non-empty line, made safe and capped. */
export function boardStatusLine(status: string): string {
  for (const line of splitBoardLines(status)) {
    const tamed = tameBoardText(line, BOARD_STATUS_MAX_CHARS);
    if (tamed.length > 0) return tamed;
  }
  return '';
}

/**
 * Newest date an entry of the live Log opens with, split the way import splits
 * it, ignoring dates after `now`'s UTC day: a deadline inside an entry's body
 * is not an entry, and a future date (a year typo) is not activity. Null when
 * no entry has a usable date.
 */
export function newestLogDate(log: string, now: Date): string | null {
  const today = now.toISOString().slice(0, 10);
  let newest: string | null = null;
  for (const entry of splitImportedLogEntries(log)) {
    const date = importLogEntryDate(entry);
    if (date !== null && date <= today && (newest === null || date > newest)) newest = date;
  }
  return newest;
}

function utcDay(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (year < 1 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ms;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
/** Title-case month names only, so the verb "may" in running text is not a date. */
const MONTH_DATE = /(?<![A-Za-z])(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?(?![\dA-Za-z])/g;

/**
 * Dates in one line, in the order found. A yearless month date resolves to
 * the occurrence nearest `now` (UTC days): last year, this year or next year,
 * ties to the later. Impossible dates are not matches.
 */
export function sweepDates(line: string, now: Date): string[] {
  const found: Array<{ at: number; date: string }> = [];
  for (const m of line.matchAll(ISO_DATE)) {
    const ms = utcDay(Number(m[1]), Number(m[2]), Number(m[3]));
    if (ms !== null) found.push({ at: m.index!, date: isoOf(ms) });
  }
  const today = utcDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())!;
  for (const m of line.matchAll(MONTH_DATE)) {
    const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()]!;
    const day = Number(m[2]);
    if (m[3] !== undefined) {
      const ms = utcDay(Number(m[3]), month, day);
      if (ms !== null) found.push({ at: m.index!, date: isoOf(ms) });
      continue;
    }
    const year = now.getUTCFullYear();
    let best: number | null = null;
    for (const y of [year - 1, year, year + 1]) {
      const ms = utcDay(y, month, day);
      if (ms === null) continue;
      if (best === null || Math.abs(ms - today) <= Math.abs(best - today)) best = ms;
    }
    if (best !== null) found.push({ at: m.index!, date: isoOf(best) });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.date);
}

/** Dated rows for one project's Next Actions and Open Questions, one per match. The sweep runs on the cut line. */
export function datedItems(project: string, view: Pick<BoardView, 'next_actions' | 'open_questions'>, now: Date): BoardDatedRow[] {
  const rows: BoardDatedRow[] = [];
  for (const body of [view.next_actions, view.open_questions]) {
    for (const raw of splitBoardLines(body)) {
      const line = tameBoardText(raw, BOARD_LINE_MAX_CHARS);
      if (line.length === 0) continue;
      for (const date of sweepDates(line, now)) rows.push({ date, project, line });
    }
  }
  return rows;
}

function section<T>(rows: T[]): BoardSection<T> {
  const shown = rows.slice(0, BOARD_SECTION_CAP);
  return { total: rows.length, shown: shown.length, rows: shown };
}

export function assertStaleDays(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > BOARD_MAX_STALE_DAYS) {
    throw new RangeError(`stale days must be a whole number from 0 to ${BOARD_MAX_STALE_DAYS}.`);
  }
}

export function buildBoard(input: BuildBoardInput): ProjectBoard {
  const { summaries, views, now, staleDays } = input;
  assertStaleDays(staleDays);
  const nowMs = now.getTime();
  const stale: Array<BoardStaleRow & { ms: number }> = [];
  const dated: BoardDatedRow[] = [];
  const drafts: BoardDraftRow[] = [];
  const repair: BoardRepairRow[] = [];
  const healthy: string[] = [];

  for (const summary of summaries) {
    if (summary.conflict) { repair.push({ project: summary.project, reason: 'conflict' }); continue; }
    const view = views.get(summary.project);
    if (view === undefined || summary.updated_at === null) { repair.push({ project: summary.project, reason: 'unreadable' }); continue; }
    healthy.push(summary.project);
    if (summary.draft) drafts.push({ project: summary.project, updated_at: summary.updated_at });
    dated.push(...datedItems(summary.project, view, now));
    if (isProjectDone(view.status)) continue;
    const logDate = summary.imported ? newestLogDate(view.log, input.now) : null;
    const lastActivity = logDate ?? summary.updated_at;
    const ms = logDate !== null ? Date.parse(`${logDate}T00:00:00.000Z`) : Date.parse(summary.updated_at);
    if (!Number.isFinite(ms) || nowMs - ms <= staleDays * DAY_MS) continue;
    stale.push({
      project: summary.project,
      last_activity: lastActivity,
      activity_source: logDate !== null ? 'last log entry' : 'last write',
      status: boardStatusLine(view.status),
      ms,
    });
  }

  stale.sort((a, b) => a.ms - b.ms || cmp(a.project, b.project));
  dated.sort((a, b) => cmp(a.date, b.date) || cmp(a.project, b.project) || cmp(a.line, b.line));
  drafts.sort((a, b) => cmp(a.project, b.project));
  repair.sort((a, b) => cmp(a.project, b.project));

  let open_sessions: BoardOpenSessions;
  if ('unavailable' in input.openSessions) {
    open_sessions = { unavailable: tameBoardText(String(input.openSessions.unavailable), BOARD_LINE_MAX_CHARS) };
  } else {
    const rows: BoardOpenSessionRow[] = [];
    for (const project of healthy) {
      for (const s of (input.openSessions.get(project) ?? []).slice(0, BOARD_OPEN_SESSIONS_PER_PROJECT)) {
        rows.push({ project, session_id: s.session_id, host: tameBoardText(s.host, BOARD_HOST_MAX_CHARS), opened_at: s.opened_at, last_read_at: s.last_read_at });
      }
    }
    rows.sort((a, b) => cmp(b.last_read_at, a.last_read_at) || cmp(a.project, b.project) || cmp(a.session_id, b.session_id));
    open_sessions = section(rows);
  }

  return {
    generated_at: now.toISOString(),
    stale_days: staleDays,
    done_rule: BOARD_DONE_RULE,
    stale: section(stale.map(({ ms: _ms, ...row }) => row)),
    dated: section(dated),
    open_sessions,
    drafts: section(drafts),
    needs_repair: section(repair),
  };
}
