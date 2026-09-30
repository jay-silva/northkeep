import {
  ProjectHandoffError,
  boardStatusLine,
  getProjectView,
  listProjectViews,
  splitLogEntries,
  type ListFilter,
  type MemoryEntry,
  type ProjectFileReference,
  type ProjectVaultReader,
} from '@northkeep/core';

/**
 * Read-only project data for the Projects tab. Everything is derived from the
 * session's live entries, the same array the Memories tab shows, so the phone
 * reads nothing it could not already read. Core's own listProjectViews and
 * getProjectView do the parsing, so the phone and the Mac agree on what a
 * project document says.
 */

const HANDLED_FILTER_KEYS = new Set(['type', 'scope', 'allowedScopes', 'includeSuperseded', 'includeForgotten']);

/**
 * A ProjectVaultReader over already-listed live entries. includeSuperseded and
 * includeForgotten are no-ops because the input holds no such rows. An unknown
 * filter key throws, so a new core filter fails a test instead of quietly
 * returning too much.
 */
export function entriesReader(entries: readonly MemoryEntry[]): ProjectVaultReader {
  return {
    list(filter: ListFilter = {}) {
      for (const key of Object.keys(filter)) {
        if (!HANDLED_FILTER_KEYS.has(key)) throw new Error(`entriesReader does not support the "${key}" filter.`);
      }
      return entries.filter(
        (e) =>
          (filter.type === undefined || e.type === filter.type) &&
          (filter.scope === undefined || e.scope === filter.scope) &&
          (filter.allowedScopes === undefined || filter.allowedScopes.includes(e.scope)),
      );
    },
    getVaultId: () => '',
    sharedScopes: () => [],
  };
}

export interface ProjectRow {
  slug: string;
  name: string;
  /** One cleaned line from Current Status, or a plain note when there is none. */
  statusLine: string;
  /** ISO time of the newest save, or null for a project with conflicting documents. */
  updatedAt: string | null;
  /** App name recorded with the newest save, when the save carried one. */
  appName: string | null;
  /** Extra plain-language notes: draft, imported, conflicting copies. */
  notes: string[];
}

/** Every project on this phone, newest update first; conflicting projects last. */
export function projectRows(entries: readonly MemoryEntry[]): ProjectRow[] {
  const rows = listProjectViews(entriesReader(entries)).map((p): ProjectRow => {
    const notes: string[] = [];
    if (p.conflict) notes.push('Has more than one current document. Open it on your Mac to fix.');
    if (p.draft) notes.push('Draft, not yet confirmed');
    if (p.imported) notes.push('Imported; the date is when it was imported');
    const line = p.status === null ? '' : boardStatusLine(p.status);
    return {
      slug: p.project,
      name: p.title ?? p.project,
      statusLine: line.length > 0 ? line : p.conflict ? 'Status unavailable' : 'No status yet',
      updatedAt: p.updated_at,
      appName: p.last_writer_host,
      notes,
    };
  });
  return rows.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.slug.localeCompare(b.slug);
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

/** A section body split for display: bullet lines become items, other text stays a paragraph. */
export type TextBlock = { kind: 'item'; text: string } | { kind: 'paragraph'; text: string };

export function textBlocks(body: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ kind: 'item', text: bullet[1]! });
    } else if (line.trim().length === 0) {
      flush();
    } else if (paragraph.length === 0 && blocks.at(-1)?.kind === 'item' && /^\s+\S/.test(raw)) {
      // An indented continuation line belongs to the item above it.
      const last = blocks.at(-1)!;
      last.text += '\n' + line.trim();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export interface ProjectDetail {
  slug: string;
  name: string;
  updatedAt: string;
  appName: string | null;
  draft: boolean;
  whatWhy: TextBlock[];
  status: TextBlock[];
  nextActions: TextBlock[];
  decisions: TextBlock[];
  openQuestions: TextBlock[];
  /** Log entries in stored order, which is newest first (core prepends). */
  log: string[];
  files: ProjectFileReference[];
  /** The raw Files section when it is not NorthKeep's structured block. */
  filesText: string | null;
}

export type ProjectDetailResult = { ok: true; detail: ProjectDetail } | { ok: false; message: string };

/** Strip the "- " bullet from a log entry so the list reads as dated lines. */
function logLine(entry: string): string {
  return entry.replace(/^- /, '');
}

export function projectDetail(entries: readonly MemoryEntry[], slug: string): ProjectDetailResult {
  try {
    const view = getProjectView(entriesReader(entries), slug);
    return {
      ok: true,
      detail: {
        slug: view.project,
        name: view.title ?? view.project,
        updatedAt: view.updated_at,
        appName: view.last_writer?.host ?? null,
        draft: view.draft,
        whatWhy: textBlocks(view.what_why),
        status: textBlocks(view.status),
        nextActions: textBlocks(view.next_actions),
        decisions: textBlocks(view.decisions),
        openQuestions: textBlocks(view.open_questions),
        log: splitLogEntries(view.log).map(logLine),
        files: view.files ?? [],
        filesText: view.files === null && view.files_text.trim().length > 0 ? view.files_text : null,
      },
    };
  } catch (err) {
    if (err instanceof ProjectHandoffError && err.code === 'project_conflict') {
      return { ok: false, message: 'This project has more than one current document. Open it on your Mac to fix it.' };
    }
    if (err instanceof ProjectHandoffError && err.code === 'invalid_request') {
      return { ok: false, message: 'This project document cannot be read here. Open it on your Mac to fix it.' };
    }
    // not_found, and an invalid slug from a hand-typed route.
    return { ok: false, message: 'That project is not on this phone. Pull down on Memories to sync.' };
  }
}

/** "Updated 2026-09-30" style label; the day is enough on a phone list. */
export function updatedLabel(iso: string | null): string {
  return iso === null ? 'Update time unknown' : `Updated ${iso.slice(0, 10)}`;
}

export const FILE_ACCESS_LABELS: Record<ProjectFileReference['access'], string> = {
  reported_available: 'reported available',
  unavailable: 'unavailable',
  unverified: 'unverified',
};

export const FILE_TYPE_LABELS: Record<ProjectFileReference['type'], string> = {
  local_path: 'File on a computer',
  url: 'Web link',
  memory: 'Memory',
};
