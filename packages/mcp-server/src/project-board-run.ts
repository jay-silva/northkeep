/**
 * Assembles the project board (ADR 0054 Decision 2) for the MCP tool and the
 * CLI. Reads projects through core only (never the project_get or
 * project_resume tools, which would plant the open sessions the board
 * reports), narrowed by the connection grant on both reads and on open
 * sessions. Takes a reader, not a Vault, so it has no write to make.
 */
import {
  ProjectHandoffError,
  buildBoard,
  getProjectView,
  listProjectViews,
  type BoardSessionInput,
  type BoardView,
  type ProjectBoard,
  type ProjectVaultReader,
} from '@northkeep/core';
import type { CallLogEntry } from './log.js';
import { openSessions } from './open-sessions.js';

export const BOARD_CALL_LOG_UNREADABLE = "The call log on this machine exists but could not be read, so open sessions are unknown.";

export interface BoardRunOptions {
  /** The connection grant; undefined is the owner's full view (the CLI). */
  granted: string[] | undefined;
  now: Date;
  staleDays: number;
  /** Excluded from open sessions; the CLI has none and passes ''. */
  currentSessionId: string;
  /** Strict: returns [] only when the log does not exist, throws when it cannot be read. */
  readLog: () => CallLogEntry[];
}

export interface BoardRunResult {
  board: ProjectBoard;
  /** Scopes named in a shown row, for the call log's disclosure ledger. */
  disclosed_scopes: string[];
  /** Current revisions of those projects, where one exists. */
  result_ids: string[];
}

export function collectBoard(reader: ProjectVaultReader, options: BoardRunOptions): BoardRunResult {
  const summaries = listProjectViews(reader, options.granted);
  const views = new Map<string, BoardView>();
  for (const summary of summaries) {
    if (summary.conflict) continue;
    try {
      views.set(summary.project, getProjectView(reader, summary.project, options.granted));
    } catch (error) {
      // One refused document goes to needs repair; any other failure fails the call.
      if (!(error instanceof ProjectHandoffError)) throw error;
    }
  }

  let sessions: Map<string, BoardSessionInput[]> | { unavailable: string };
  let rows: CallLogEntry[] | null = null;
  try {
    rows = options.readLog();
  } catch {
    rows = null;
  }
  if (rows === null) {
    sessions = { unavailable: BOARD_CALL_LOG_UNREADABLE };
  } else {
    sessions = new Map();
    // Only projects already in the granted result, so a row about any other scope never reaches the payload.
    for (const slug of views.keys()) {
      const summary = summaries.find((s) => s.project === slug)!;
      sessions.set(slug, openSessions(rows, summary.scope, options.currentSessionId, options.now));
    }
  }

  const board = buildBoard({ summaries, views, now: options.now, staleDays: options.staleDays, openSessions: sessions });
  const named = new Set<string>();
  for (const section of [board.stale, board.dated, board.drafts, board.needs_repair]) {
    for (const row of section.rows) named.add(row.project);
  }
  if (!('unavailable' in board.open_sessions)) for (const row of board.open_sessions.rows) named.add(row.project);
  const shown = summaries.filter((s) => named.has(s.project));
  return {
    board,
    disclosed_scopes: shown.map((s) => s.scope).sort(),
    result_ids: shown.flatMap((s) => (s.revision ? [s.revision] : [])),
  };
}
