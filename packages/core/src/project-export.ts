/**
 * The local git mirror's renderer (ADR 0053 M-A1, Decisions 1, 3, 7 and 9).
 * Pure: it takes project views and summaries and returns file bytes, the
 * header, the INDEX table, the one-line staleness summary and the commit
 * message. No filesystem, no git, no clock except the `now` a caller passes to
 * summarizeMirror. The same vault state renders the same bytes: no generation
 * timestamp, dates from stored created_at as YYYY-MM-DD UTC, the document's
 * own section order, plain code-unit slug order, LF endings and one trailing
 * newline. The git layer in packages/mcp-server owns writing, hashing,
 * journaling and committing; this module never decides ownership, it only
 * prints the header that classifyTarget reads back. No node:* import, so core
 * stays usable on mobile.
 */
import { firstNonEmptyLine, splitLogEntries } from './project-doc.js';
import {
  ProjectHandoffError,
  getProjectView,
  listProjectViews,
  type ProjectArchive,
  type ProjectSummary,
  type ProjectVaultReader,
  type ProjectView,
} from './project-handoff.js';

export type MirrorKind = 'document' | 'log' | 'index';
export type MirrorHeaderKind = MirrorKind | 'marker';

export interface MirrorFile {
  path: string;
  bytes: Uint8Array;
  slug: string | null;
  kind: 'document' | 'log' | 'index';
  revision: string | null;
}

/** The root marker is not a MirrorFile so an exhaustive switch on MirrorFile.kind stays exhaustive. */
export interface MirrorMarkerFile {
  path: '.northkeep-mirror';
  bytes: Uint8Array;
  kind: 'marker';
}

export interface MirrorHeader {
  vaultId: string;
  slug: string | null;
  revision: string | null;
  kind: MirrorHeaderKind;
  /** UTF-16 length of the header text including its final newline, for slicing it off. */
  length: number;
}

export const MIRROR_HEADER_MAX_BYTES = 257;
/** Target size of one log part (Decision 9). One archive can exceed it and then stands alone. */
export const MIRROR_LOG_PART_TARGET_BYTES = 65536;
export const MIRROR_STATUS_MAX_CHARS = 120;
export const MIRROR_INDEX_PATH = 'INDEX.md';
export const MIRROR_MARKER_PATH = '.northkeep-mirror';
export const MIRROR_CONFLICT_STATUS = 'two live documents, not exported';

const HEADER_OPEN = '<!-- northkeep: ';
const HEADER_SECOND_LINE = '     The vault is canonical. This file is regenerated. Edits here are not read back. -->';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const HEADER_RE = new RegExp(
  `^<!-- northkeep: vault (${UUID})(?: project ([a-z0-9-]{1,40}) revision (${UUID}))? kind (document|log|index|marker)\\n` +
    `${HEADER_SECOND_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`,
);
/** Built per call, never at import time, so loading core needs no TextEncoder. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Code-unit order, so the output does not depend on the host's locale collation. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isoDay(stamp: string | null): string {
  if (stamp === null) return '';
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/**
 * The two-line HTML comment every generated file opens with (Decision 3).
 * Document and log headers name a project and revision; index and marker
 * headers name only the vault. Throws on an id that would make it ambiguous.
 */
export function formatMirrorHeader(input: { vaultId: string; kind: MirrorHeaderKind; slug?: string | null; revision?: string | null }): string {
  if (!UUID_RE.test(input.vaultId)) throw new Error('Mirror header needs a lowercase UUID vault id.');
  const perProject = input.kind === 'document' || input.kind === 'log';
  let subject = '';
  if (perProject) {
    if (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug)) throw new Error('Mirror header needs a valid project slug.');
    if (typeof input.revision !== 'string' || !UUID_RE.test(input.revision)) throw new Error('Mirror header needs a lowercase UUID revision.');
    subject = ` project ${input.slug} revision ${input.revision}`;
  } else if (input.slug != null || input.revision != null) {
    throw new Error(`A ${input.kind} header names no project.`);
  }
  const header = `${HEADER_OPEN}vault ${input.vaultId}${subject} kind ${input.kind}\n${HEADER_SECOND_LINE}\n`;
  if (utf8(header).length > MIRROR_HEADER_MAX_BYTES) throw new Error('Mirror header exceeds its byte cap.');
  return header;
}

/**
 * The header at offset 0, or null for anything that is not exactly
 * NorthKeep's: a header later in the text, a BOM, CRLF, extra spaces, a
 * per-project kind without a project, or an index naming one.
 */
export function parseMirrorHeader(text: string): MirrorHeader | null {
  if (!text.startsWith(HEADER_OPEN)) return null;
  const match = HEADER_RE.exec(text);
  if (!match) return null;
  const kind = match[4] as MirrorHeaderKind;
  const slug = match[2] ?? null;
  const revision = match[3] ?? null;
  const perProject = kind === 'document' || kind === 'log';
  if (perProject !== (slug !== null)) return null;
  return { vaultId: match[1]!, slug, revision, kind, length: match[0].length };
}

/** ADR 0053's name for the same parser. */
export const parseExportHeader = parseMirrorHeader;

function withHeader(header: string, body: string): Uint8Array {
  const lf = body.replace(/\r\n?/g, '\n');
  return utf8(`${header}\n${lf}${lf.endsWith('\n') ? '' : '\n'}`);
}

/** `projects/<slug>.md`: the stored document verbatim under its header. */
export function renderProjectFile(view: ProjectView): MirrorFile {
  const header = formatMirrorHeader({ vaultId: view.vault_id, kind: 'document', slug: view.project, revision: view.revision });
  return { path: `projects/${view.project}.md`, bytes: withHeader(header, view.content), slug: view.project, kind: 'document', revision: view.revision };
}

/**
 * An archive's note paragraph and its entries. The note is whatever precedes
 * the first bullet after the heading line; rolled, imported and connector
 * archives all keep that shape.
 */
export function splitLogArchive(content: string): { note: string; entries: string[] } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
  if (rest.startsWith('- ')) return { note: '', entries: splitLogEntries(rest) };
  const gap = rest.indexOf('\n\n');
  if (gap === -1) return { note: rest.replace(/\n+$/, ''), entries: [] };
  return { note: rest.slice(0, gap), entries: splitLogEntries(rest.slice(gap + 2)) };
}

/** Heading of one archive inside a log part; import reads the date back from it. */
export const MIRROR_ARCHIVE_SECTION_PREFIX = 'Archive rolled ';

function renderArchiveSection(archive: ProjectArchive): string {
  const { note, entries } = splitLogArchive(archive.content);
  const body = [note, [...entries].reverse().join('\n')].filter((part) => part.length > 0).join('\n\n');
  return `## ${MIRROR_ARCHIVE_SECTION_PREFIX}${isoDay(archive.updated_at)}\n\n${body}\n`;
}

/**
 * Log parts from a history: true view, newest first. Splits only between
 * archives so an archive is never cut; one over the target stands alone.
 * Always numbered, so growing a second part never renames the first.
 */
export function renderLogFile(view: ProjectView): MirrorFile[] {
  if (view.archives.length === 0) return [];
  const header = formatMirrorHeader({ vaultId: view.vault_id, kind: 'log', slug: view.project, revision: view.revision });
  const title = `# Log archives: ${view.project}\n\nNewest archive first, newest entry first. The live Log is in ${view.project}.md.\n`;
  const fixed = utf8(`${header}\n${title}\n`).length;
  const parts: string[][] = [];
  let current: string[] = [];
  let size = fixed;
  for (const archive of view.archives) {
    const section = renderArchiveSection(archive);
    const bytes = utf8(`\n${section}`).length;
    if (current.length > 0 && size + bytes > MIRROR_LOG_PART_TARGET_BYTES) {
      parts.push(current);
      current = [];
      size = fixed;
    }
    current.push(section);
    size += bytes;
  }
  parts.push(current);
  return parts.map((sections, i) => ({
    path: `projects/${view.project}.log.${i + 1}.md`,
    bytes: utf8(`${header}\n${title}\n${sections.join('\n')}`),
    slug: view.project,
    kind: 'log' as const,
    revision: view.revision,
  }));
}

const UNSAFE_CELL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

/** One table cell: controls and line breaks become a space, then pipes are escaped. */
function cell(text: string): string {
  return text.replace(UNSAFE_CELL_CHARS, ' ').replace(/\|/g, '\\|');
}

/** First non-empty line, cut by code points before escaping so a cut never splits an escape. */
export function mirrorStatusLine(status: string | null): string {
  const line = firstNonEmptyLine((status ?? '').replace(/\r\n?|[\u2028\u2029]/g, '\n'));
  const points = Array.from(line);
  if (points.length <= MIRROR_STATUS_MAX_CHARS) return line;
  return `${points.slice(0, MIRROR_STATUS_MAX_CHARS - 3).join('')}...`;
}

/** `INDEX.md`: one row per project, slug order, conflicted projects named but not exported. */
export function renderIndexFile(summaries: ProjectSummary[], vaultId: string): MirrorFile {
  const header = formatMirrorHeader({ vaultId, kind: 'index' });
  const rows = [...summaries].sort((a, b) => byCodeUnit(a.project, b.project)).map((s) => {
    const cells = s.conflict
      ? [s.project, 'conflict', MIRROR_CONFLICT_STATUS, '', '']
      : [s.project, s.draft ? 'draft' : 'active', mirrorStatusLine(s.status), isoDay(s.updated_at), s.last_writer_host ?? '(unknown host)'];
    return `| ${cells.map(cell).join(' | ')} |`;
  });
  const body = [
    '# NorthKeep projects',
    '',
    'The vault is canonical; this table is regenerated on every export.',
    '',
    '| Project | State | Status | Updated | Last writer |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
  return { path: MIRROR_INDEX_PATH, bytes: withHeader(header, body), slug: null, kind: 'index', revision: null };
}

/** `.northkeep-mirror`, the root marker that says this folder is a NorthKeep mirror of one vault (Decision 4). */
export function renderMarkerFile(vaultId: string): MirrorMarkerFile {
  const header = formatMirrorHeader({ vaultId, kind: 'marker' });
  const body = 'This folder is a NorthKeep project mirror. NorthKeep writes only projects/, INDEX.md and this file.';
  return { path: MIRROR_MARKER_PATH, bytes: withHeader(header, body), kind: 'marker' };
}

/**
 * Every project in the grant (no exclusion, no hold): its document and log
 * parts, then INDEX.md. A conflicted project gets only its INDEX row. A
 * project whose document cannot be read throws rather than being left out.
 */
export function renderMirror(vault: ProjectVaultReader, allowedScopes?: string[]): MirrorFile[] {
  const summaries = [...listProjectViews(vault, allowedScopes)].sort((a, b) => byCodeUnit(a.project, b.project));
  const files: MirrorFile[] = [];
  for (const summary of summaries) {
    if (summary.conflict) continue;
    let view: ProjectView;
    try {
      view = getProjectView(vault, summary.project, allowedScopes, { history: true });
    } catch (error) {
      if (error instanceof ProjectHandoffError) {
        throw new ProjectHandoffError(error.code, `Project ${summary.project} could not be rendered: ${error.message}`);
      }
      throw error;
    }
    files.push(renderProjectFile(view), ...renderLogFile(view));
  }
  files.push(renderIndexFile(summaries, vault.getVaultId()));
  return files;
}

/** The Decision 7 state file, as far as the summary reads it. Field names are the ADR's. */
export interface MirrorState {
  last_success?: { at: string; commit?: string } | null;
  last_failure?: { at: string; code?: string } | null;
  projects?: Record<string, { revision: string; exported_at?: string }>;
}

function ago(from: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(from)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

function stampAndAgo(at: string, now: Date): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return 'at an unreadable time';
  return `${new Date(ms).toISOString().slice(0, 16)}Z (${ago(at, now)})`;
}

/**
 * Fixed text, times and a count only, so no path or content reaches a
 * resume. A conflicted project cannot be exported, so counting it would
 * report a change no export can clear.
 */
export function summarizeMirror(state: MirrorState, summaries: ProjectSummary[], now: Date): string {
  const exported = state.projects ?? {};
  const changed = summaries.filter((s) => !s.conflict && s.revision !== null && exported[s.project]?.revision !== s.revision).length;
  const success = state.last_success ?? null;
  const failure = state.last_failure ?? null;
  const count = `${changed} project${changed === 1 ? '' : 's'} changed since`;
  let line = success ? `mirror last exported ${stampAndAgo(success.at, now)}; ${count}` : `mirror never exported; ${count}`;
  const failedLater = failure !== null && (success === null || Date.parse(failure.at) > Date.parse(success.at));
  if (failedLater) line += `; last export failed ${stampAndAgo(failure.at, now)}`;
  return line;
}

/**
 * One commit per run (Decision 9): subject `export: <n> projects (<host>)`,
 * then one line per project written with its last writer host from the ADR
 * 0052 block, then each removed path. Goes to commit-tree on stdin.
 */
export function formatExportCommitMessage(input: {
  host: string;
  written: Array<{ slug: string; lastWriterHost: string | null }>;
  removed?: string[];
}): string {
  const clean = (text: string): string => text.replace(UNSAFE_CELL_CHARS, ' ').trim() || 'unknown host';
  const n = input.written.length;
  const lines = [`export: ${n} project${n === 1 ? '' : 's'} (${clean(input.host)})`, ''];
  for (const w of [...input.written].sort((a, b) => byCodeUnit(a.slug, b.slug))) {
    lines.push(`${w.slug} (${w.lastWriterHost === null ? 'unknown host' : clean(w.lastWriterHost)}, model not exposed)`);
  }
  for (const removed of [...(input.removed ?? [])].sort(byCodeUnit)) lines.push(`removed ${clean(removed)}`);
  if (lines.length === 2) lines.pop();
  return `${lines.join('\n')}\n`;
}
