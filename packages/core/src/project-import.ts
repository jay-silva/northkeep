/**
 * Import of a folder of Markdown project files (ADR 0053 Decision 10). Pure:
 * planImport takes names and text, never paths, so the source cannot be
 * touched, and returns the whole plan, which is the dry run. Vault.importProject
 * is the write. Headerless files and NorthKeep's own `kind document` files
 * import; `kind log` files reattach their archives to the slug; `kind index`
 * and `kind marker` files are skipped. The header is stripped and never
 * stored. Log entries keep their own dates: they are moved into ADR 0045
 * archives, not replayed through project_update. When every entry has a
 * readable date the newest ten by date stay live and archives run oldest
 * first; otherwise the source's sequence is kept, turned newest first when its
 * dated entries run oldest first, and the plan says so. A Log written as
 * headings becomes ordinary dash entries. If the document
 * is still over the cap, extra sections move, last first, into numbered
 * overflow memories, then older live entries join the archives, then the
 * largest remaining bodies move whole, leaving a pointer. No row exceeds
 * 60,000 bytes: a longer one is split into numbered parts. Nothing is ever cut.
 */
import {
  PROJECT_DOC_MAX_CHARS,
  PROJECT_LOG_ARCHIVE_HEADING,
  PROJECT_LOG_KEEP_ENTRIES,
  PROJECT_SECTION_HEADINGS,
  isValidProjectSlug,
  parseProjectDoc,
  serializeProjectDoc,
  splitLogEntries,
  type ProjectDoc,
  type ProjectDocSection,
} from './project-doc.js';
import { MIRROR_ARCHIVE_SECTION_PREFIX, parseMirrorHeader, splitLogArchive } from './project-export.js';

export const PROJECT_IMPORT_OVERFLOW_HEADING = '## Import overflow';
/** Left in place of a section body that import moved to the overflow memories. */
export const PROJECT_IMPORT_OVERFLOW_POINTER = 'Moved whole to the Import overflow memories in this project scope: too long for the live document.';

/** Sections getProjectView reads by name; a duplicate of any of them makes the project unreadable. */
const OWNED_HEADINGS = [...PROJECT_SECTION_HEADINGS, 'Open Questions', 'Files'] as const;
const HEADING_MAP: Record<string, string> = { 'Open Questions / Risks': 'Open Questions' };

export interface ImportSectionMapping { from: string; to: string; chars: number }

export interface ImportFilePlan {
  /** The file the document came from. */
  name: string;
  slug: string;
  /** Source headings in order and what each is stored as. */
  sections: ImportSectionMapping[];
  /** The live document as it will be stored. */
  document: string;
  /** Archive memory contents in write order, oldest first (by date, or as the source's dated entries run). */
  archives: string[];
  /** 'by date' when every Log entry had a readable date; otherwise the source's sequence, reversed when it ran oldest first. */
  log_order: ImportLogOrder;
  /** The whole overflow text for the dry run, or null. Not written as one row. */
  overflow: string | null;
  /** What importProject writes: the overflow split into rows of at most 60,000 bytes, in order. */
  overflow_parts: string[];
  /** Section titles moved into the overflow memory, in source order. */
  overflow_sections: string[];
  /** `kind log` files whose archives were reattached here. */
  log_files: string[];
  /** Log entries moved into archives from the document itself. */
  archived_entries: number;
  /** UTF-8 bytes of the largest row this plan writes; the connector refuses a shared row over 65,536. */
  largest_row_bytes: number;
  /** UTF-8 bytes of every row this plan writes, to set against the 4 MB push limit. */
  total_bytes: number;
}

export type ImportLogOrder = 'by date' | 'source order' | 'source order reversed';
export interface ImportSkip { name: string; reason: string }
export interface ImportPlan {
  projects: ImportFilePlan[];
  skipped: ImportSkip[];
  /** Largest row across the run. */
  largest_row_bytes: number;
  /** Bytes across the run; one push carries at most PROJECT_IMPORT_PUSH_MAX_BYTES. */
  total_bytes: number;
}

/** The connector's content cap for one push (MAX_TOTAL_CONTENT_BYTES), shown beside total_bytes in a dry run. */
/** The refusal for a slug with entries left, even archives only; the command it names is the way out. */
export function projectInUseMessage(slug: string): string {
  return `Project ${slug} already has entries in this vault. Remove them with \`northkeep projects delete ${slug}\` first, then import again.`;
}

export const PROJECT_IMPORT_PUSH_MAX_BYTES = 4 * 1024 * 1024;
/** Every imported row stays at or under this, below the connector's 65,536-byte row cap. */
export const PROJECT_IMPORT_ROW_MAX_BYTES = 60000;

const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** 'oldest first' is true only when the order came from dates or from NorthKeep's own export. */
export type ImportedArchiveOrder = 'oldest first' | 'source sequence';

/** One paragraph, never a blank line, so splitLogArchive still finds where the entries start. */
function importedArchiveNote(sourceFile: string, order: ImportedArchiveOrder): string {
  const source = sourceFile.replace(UNSAFE_NAME_CHARS, ' ').trim() || 'an unnamed file';
  const ordering = order === 'oldest first'
    ? 'Oldest first.'
    : 'Not every entry had a readable date, so these are not sorted by date. They keep the source\'s sequence, turned where needed so its dated entries run oldest first.';
  return `Imported from ${source} by northkeep projects import, entries with their original dates. ${ordering} Read with project_get history, or search this scope.`;
}

/**
 * An ADR 0045 archive holding imported entries, with the
 * `## Log archive: <slug>` first line getProjectView looks for. Lives here,
 * not in project-doc.ts, because the connector never imports and that file
 * must stay byte-identical to its copy.
 */
export function formatImportedLogArchive(project: string, entries: string[], sourceFile: string, order: ImportedArchiveOrder = 'oldest first'): string {
  return `${PROJECT_LOG_ARCHIVE_HEADING}: ${project}\n\n${importedArchiveNote(sourceFile, order)}\n\n${entries.join('\n')}`;
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

const PART_NEW_LINE = 'Join the parts in order; this part starts on a new line.';
const PART_MID_LINE = 'Join the parts in order; this part continues the previous part\'s last line, cut at a character boundary.';

/**
 * One entry too large for a row, as numbered archive rows. The text is split
 * on line boundaries, or at code points inside a line longer than a row, and
 * each part's note says how it joins the one before.
 */
function splitArchiveEntry(project: string, entry: string, sourceFile: string, order: ImportedArchiveOrder): string[] {
  const head = (i: number, n: number, note: string): string =>
    `${PROJECT_LOG_ARCHIVE_HEADING}: ${project}\n\n${importedArchiveNote(sourceFile, order)} Part ${i} of ${n} of one entry too long for a single row. ${note}\n\n`;
  const budget = PROJECT_IMPORT_ROW_MAX_BYTES - utf8Length(head(999999, 999999, PART_MID_LINE));
  if (budget < 4096) throw new Error('Import archive note leaves no room for entry text.');
  const chunks = splitByBytes(entry, budget);
  return chunks.map((chunk, i) => {
    const text = chunk.cutAfter ? chunk.text : chunk.text.replace(/\n$/, '');
    const row = head(i + 1, chunks.length, chunk.cutBefore ? PART_MID_LINE : PART_NEW_LINE) + text;
    if (utf8Length(row) > PROJECT_IMPORT_ROW_MAX_BYTES) throw new Error('Import archive part exceeds its byte cap.');
    return row;
  });
}

/** Reassembles one entry from its split archive rows, in order; the inverse of the split for readers and tests. */
export function joinImportedLogArchiveParts(parts: string[]): string {
  return parts.map((part, i) => {
    const firstGap = part.indexOf('\n\n');
    const secondGap = part.indexOf('\n\n', firstGap + 2);
    const note = part.slice(firstGap + 2, secondGap);
    const text = part.slice(secondGap + 2);
    return i === 0 || note.endsWith(PART_MID_LINE) ? text : `\n${text}`;
  }).join('');
}

/**
 * Groups entries into archives under the document cap and the row byte cap.
 * An entry that alone is over the byte cap is split into numbered rows; one
 * merely over the character cap stands alone, as before.
 */
function chunkArchives(project: string, entries: string[], sourceFile: string, order: ImportedArchiveOrder, charCap = true): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const fits = (list: string[]): boolean => {
    const text = formatImportedLogArchive(project, list, sourceFile, order);
    return (!charCap || text.length <= PROJECT_DOC_MAX_CHARS) && utf8Length(text) <= PROJECT_IMPORT_ROW_MAX_BYTES;
  };
  const flush = (): void => {
    if (current.length > 0) out.push(formatImportedLogArchive(project, current, sourceFile, order));
    current = [];
  };
  for (const entry of entries) {
    if (utf8Length(formatImportedLogArchive(project, [entry], sourceFile, order)) > PROJECT_IMPORT_ROW_MAX_BYTES) {
      flush();
      out.push(...splitArchiveEntry(project, entry, sourceFile, order));
      continue;
    }
    if (current.length > 0 && !fits([...current, entry])) flush();
    current.push(entry);
  }
  flush();
  return out;
}

/**
 * Chunks of at most `budget` bytes, broken after a newline where possible and
 * at a code point only inside a line longer than the budget. cutBefore and
 * cutAfter mark a boundary that falls inside a line. Joining gives the input.
 */
function splitByBytes(text: string, budget: number): Array<{ text: string; cutBefore: boolean; cutAfter: boolean }> {
  const encoder = new TextEncoder();
  const chunks: Array<{ text: string; cutBefore: boolean; cutAfter: boolean }> = [];
  let current = '';
  let size = 0;
  let cutBefore = false;
  const flush = (cutAfter: boolean): void => {
    if (current.length > 0) chunks.push({ text: current, cutBefore, cutAfter });
    current = '';
    size = 0;
    cutBefore = cutAfter;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const bytes = encoder.encode(line).length;
    if (bytes <= budget) {
      if (size + bytes > budget) flush(false);
      current += line;
      size += bytes;
      continue;
    }
    flush(false);
    for (const point of Array.from(line)) {
      const b = encoder.encode(point).length;
      if (size + b > budget) flush(true);
      current += point;
      size += b;
    }
    flush(false);
  }
  flush(false);
  return chunks;
}

/** Under the connector's 65,536-byte row cap with room to spare. */
export const PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES = PROJECT_IMPORT_ROW_MAX_BYTES;
/** Bytes kept free in each part for its heading and note, so the text budget never depends on the part count. */
const OVERFLOW_HEADER_RESERVE = 400;
const SPLIT_LINE_NOTE = 'A source line longer than this part could hold is split here at a character boundary; join the parts in order to read it.';

/**
 * Split on line boundaries so no line is broken, unless one line alone is
 * over the budget; then it is cut at code points and the part says so.
 * Joining the chunks gives back the input exactly.
 */
export function splitImportOverflow(project: string, overflow: string): string[] {
  const encoder = new TextEncoder();
  const chunks = splitByBytes(overflow, PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES - OVERFLOW_HEADER_RESERVE)
    .map((chunk) => ({ text: chunk.text, split: chunk.cutBefore || chunk.cutAfter }));
  return chunks.map((chunk, i) => {
    const heading = `${PROJECT_IMPORT_OVERFLOW_HEADING}: ${project} (part ${i + 1} of ${chunks.length})`;
    const part = `${heading}\n${chunk.split ? `${SPLIT_LINE_NOTE}\n` : ''}\n${chunk.text}`;
    if (encoder.encode(part).length > PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES) throw new Error('Import overflow part exceeds its byte cap.');
    return part;
  });
}

/** The inverse of splitImportOverflow, for readers and tests. */
export function joinImportOverflowParts(parts: string[]): string {
  return parts.map((part) => part.slice(part.indexOf('\n\n') + 2)).join('');
}

function overflowText(project: string, sections: ProjectDocSection[], sourceFile: string): string {
  const body = serializeProjectDoc({ preamble: '', sections });
  return (
    `${PROJECT_IMPORT_OVERFLOW_HEADING}: ${project}\n\n` +
    `Moved out of the live project document by import from ${sourceFile.replace(UNSAFE_NAME_CHARS, ' ')}, ` +
    `because the document exceeded ${PROJECT_DOC_MAX_CHARS} characters. Sections in source order.\n\n` +
    body
  );
}

function duplicateOwned(doc: ProjectDoc): string | null {
  for (const title of OWNED_HEADINGS) {
    if (doc.sections.filter((s) => s.title === title).length > 1) return title;
  }
  return null;
}

type Classified =
  | { kind: 'document'; name: string; slug: string; body: string }
  | { kind: 'log'; name: string; slug: string; part: number; body: string }
  | { kind: 'skip'; name: string; reason: string };

function classify(name: string, raw: string): Classified {
  if (!name.endsWith('.md')) return { kind: 'skip', name, reason: 'not a .md file' };
  // The name is quoted in archive notes; a bounded name keeps every note inside its row budget.
  if (utf8Length(name) > 255) return { kind: 'skip', name, reason: 'file name is longer than 255 bytes' };
  const text = raw.replace(/\r\n?/g, '\n');
  const header = parseMirrorHeader(text);
  if (header === null) {
    if (/^[\s\uFEFF\u200B]*<!--\s*northkeep:/i.test(text)) {
      return { kind: 'skip', name, reason: 'opens with a NorthKeep-style header that is not exact; remove that first comment or export again' };
    }
    const stem = name.slice(0, -3);
    if (!isValidProjectSlug(stem)) return { kind: 'skip', name, reason: 'file name is not a project slug (1 to 40 lowercase letters, digits or hyphens)' };
    return { kind: 'document', name, slug: stem, body: text };
  }
  const body = text.slice(header.length).replace(/^\n/, '');
  if (header.kind === 'index') return { kind: 'skip', name, reason: 'NorthKeep INDEX file, regenerated from the vault' };
  if (header.kind === 'marker') return { kind: 'skip', name, reason: 'NorthKeep mirror marker' };
  const slug = header.slug!;
  if (header.kind === 'document') {
    if (name !== `${slug}.md`) return { kind: 'skip', name, reason: `header names project ${slug} but the file is not ${slug}.md` };
    return { kind: 'document', name, slug, body };
  }
  const part = new RegExp(`^${slug}\\.log\\.([1-9][0-9]{0,5})\\.md$`).exec(name);
  if (!part) return { kind: 'skip', name, reason: `header names the log of ${slug} but the file is not ${slug}.log.<n>.md` };
  return { kind: 'log', name, slug, part: Number(part[1]), body };
}

/** A heading quoted in a skip reason, kept to one short line. */
function shortTitle(title: string): string {
  const points = Array.from(title.replace(UNSAFE_NAME_CHARS, ' '));
  return points.length <= 80 ? points.join('') : `${points.slice(0, 77).join('')}...`;
}

/** Archives from one rendered log part, newest first as the part lists them; each is one or more rows in write order. */
function readLogPart(slug: string, name: string, body: string): string[][] | string {
  const doc = parseProjectDoc(body);
  const archives: string[][] = [];
  for (const section of doc.sections) {
    if (section.level === 1) continue;
    if (section.level !== 2 || !section.title.startsWith(MIRROR_ARCHIVE_SECTION_PREFIX)) return `unexpected heading "${shortTitle(section.title)}" in a log file`;
    const rolled = section.title.slice(MIRROR_ARCHIVE_SECTION_PREFIX.length);
    // The export writes a date or nothing here; anything else would be quoted into every archive note.
    if (rolled !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(rolled)) return `unexpected heading "${shortTitle(section.title)}" in a log file`;
    const { entries } = splitLogArchive(`heading\n\n${section.body}`);
    if (entries.length === 0) continue;
    // One row per exported archive, as before, unless it would pass the byte cap.
    archives.push(chunkArchives(slug, [...entries].reverse(), `${name}, archive rolled ${rolled}`, 'oldest first', false));
  }
  return archives;
}

/**
 * The dry run: per file, what would be stored. Pure over names and text.
 * A slug that appears twice is skipped both times rather than guessed.
 */
export function planImport(files: { name: string; text: string }[]): ImportPlan {
  const skipped: ImportSkip[] = [];
  const documents: Array<Extract<Classified, { kind: 'document' }>> = [];
  const logs = new Map<string, Array<Extract<Classified, { kind: 'log' }>>>();
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const c = classify(file.name, file.text);
    if (c.kind === 'skip') skipped.push({ name: c.name, reason: c.reason });
    else if (c.kind === 'document') documents.push(c);
    else logs.set(c.slug, [...(logs.get(c.slug) ?? []), c]);
  }

  const counts = new Map<string, number>();
  for (const d of documents) counts.set(d.slug, (counts.get(d.slug) ?? 0) + 1);
  const projects: ImportFilePlan[] = [];
  for (const d of documents) {
    if (counts.get(d.slug)! > 1) {
      skipped.push({ name: d.name, reason: `more than one file is project ${d.slug}` });
      continue;
    }
    const result = planDocument(d.name, d.slug, d.body, (logs.get(d.slug) ?? []).sort((a, b) => a.part - b.part));
    const problem = typeof result === 'string' ? result : importPlanProblem(result);
    if (problem !== null) skipped.push({ name: d.name, reason: problem });
    else projects.push(result as ImportFilePlan);
  }
  for (const [slug, parts] of logs) {
    if (documents.some((d) => d.slug === slug && counts.get(slug) === 1)) continue;
    for (const p of parts) skipped.push({ name: p.name, reason: `log of ${slug} with no importable ${slug}.md beside it` });
  }
  return {
    projects,
    skipped,
    largest_row_bytes: projects.reduce((max, p) => Math.max(max, p.largest_row_bytes), 0),
    total_bytes: projects.reduce((sum, p) => sum + p.total_bytes, 0),
  };
}

/** Lines that open a Log entry written as a bold date paragraph, the Command Repo's other log shape. */
const BOLD_DATE_START = /^\*\*\d{4}-\d{2}-\d{2}(?!\d)/;

function realDate(y: string, m: string, d: string): string | null {
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const date = new Date(ms);
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

/** The date an entry opens with: `- YYYY-MM-DD`, `- **YYYY-MM-DD`, `**YYYY-MM-DD`, or the first date in a heading. */
export function importLogEntryDate(entry: string): string | null {
  const first = entry.split('\n', 1)[0]!;
  const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(first);
  const match = heading
    ? /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(heading[1]!)
    : /^(?:- (?:\*\*)?|\*\*)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(first);
  return match ? realDate(match[1]!, match[2]!, match[3]!) : null;
}

/**
 * A dash or bold-date Log body as entries, choosing the shape the way import
 * does from its first non-empty line. The project board reads the live Log
 * with this so a dated bullet inside an entry's body is never an entry.
 */
export function splitImportedLogEntries(body: string): string[] {
  const first = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  return BOLD_DATE_START.test(first) ? splitBoldDateEntries(body) : splitLogEntries(body);
}

/** Entries of a bold-date Log: each starts at a `**YYYY-MM-DD` line; text before the first is its own entry. */
function splitBoldDateEntries(body: string): string[] {
  const entries: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (BOLD_DATE_START.test(line)) {
      if (current) entries.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    } else if (line.trim().length > 0) {
      current = [line];
    }
  }
  if (current) entries.push(current.join('\n'));
  return entries.map((e) => e.replace(/\n+$/, ''));
}

interface LogEntry { text: string; date: string | null }

/** The Log as import reads it. `preamble` is text before the first entry; it is never an entry and never moves. */
interface LogRead { rule: 'dash' | 'bold' | 'heading'; preamble: string | null; entries: LogEntry[]; absorbed: Set<ProjectDocSection> }

/** parseProjectDoc's heading rule, repeated here because project-doc.ts must stay byte-identical to the connector's copy. */
const HEADING_LINE = /^( {0,3})(#{1,6})[ \t]+(\S.*?)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Four spaces, one past the three HEADING_LINE allows, so a heading inside a
 * converted entry stays text and no body line opens a new dash entry.
 */
const HEADING_ENTRY_INDENT = '    ';
const indentLines = (lines: string[]): string => lines.map((line) => (line.length === 0 ? line : HEADING_ENTRY_INDENT + line)).join('\n');
const trimBlankLines = (lines: string[]): string[] => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim().length === 0) a += 1;
  while (b > a && lines[b - 1]!.trim().length === 0) b -= 1;
  return lines.slice(a, b);
};

/**
 * Indexes of lines inside a code fence, fence lines included. Only a fence
 * that closes counts: an unclosed one is read as if it never opened, so it
 * cannot swallow the rest of the Log.
 */
function fencedLines(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open || (open[1]![0] === '`' && open[2]!.includes('`'))) continue;
    const marker = open[1]!;
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \t]*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j]!)) j += 1;
    if (j === lines.length) continue;
    for (let k = i; k <= j; k += 1) fenced.add(k);
    i = j;
  }
  return fenced;
}

/**
 * A heading Log as dash entries, read from the source lines so fenced code
 * is never parsed. Only a dated heading at the entry level (the shallowest
 * level any dated heading uses) opens an entry; every other line, undated
 * and deeper headings included, is text of the entry above it, or of the
 * preamble before the first. An owned section heading ends the Log and stays
 * a section. Null when no heading is dated: the Log is then left as written.
 */
function readHeadingLog(doc: ProjectDoc, logSection: ProjectDocSection, lines: string[]): LogRead | null {
  const starts: number[] = [];
  lines.forEach((line, i) => { if (HEADING_LINE.test(line)) starts.push(i); });
  // Same rule, same lines, so starts[k] is where doc.sections[k] begins.
  if (starts.length !== doc.sections.length) return null;
  const at = doc.sections.indexOf(logSection);
  const owned = new Set<string>(OWNED_HEADINGS);
  let end = at + 1;
  while (end < doc.sections.length && doc.sections[end]!.level > logSection.level) end += 1;
  const regionEnd = end < doc.sections.length ? starts[end]! : lines.length;
  const region = lines.slice(starts[at]! + 1, regionEnd);
  const offset = starts[at]! + 1;
  const fenced = fencedLines(region);
  // An owned heading ends the Log even inside a fence, as it always has, so a Log never takes over Next Actions.
  let cut = region.length;
  for (let i = 0; i < region.length; i += 1) {
    const m = HEADING_LINE.exec(region[i]!);
    // Trimmed as parseProjectDoc trims titles, so NBSP, BOM or a Unicode space at the end still matches.
    const title = m ? m[3]!.trim() : '';
    if (m && owned.has(HEADING_MAP[title] ?? title)) { cut = i; break; }
  }
  const headings: Array<{ line: number; level: number; title: string; date: string | null }> = [];
  for (let i = 0; i < cut; i += 1) {
    if (fenced.has(i)) continue;
    const m = HEADING_LINE.exec(region[i]!);
    if (m) headings.push({ line: i, level: m[2]!.length, title: m[3]!, date: importLogEntryDate(`# ${m[3]!}`) });
  }
  const dated = headings.filter((h) => h.date !== null);
  if (dated.length === 0) return null;
  const level = Math.min(...dated.map((h) => h.level));
  const openers = dated.filter((h) => h.level === level);
  const before = trimBlankLines(region.slice(0, openers[0]!.line));
  // Kept verbatim unless a line would re-read as a heading or an entry.
  const preamble = before.length === 0 ? null : before.some((line) => HEADING_LINE.test(line) || /^- /.test(line)) ? indentLines(before) : before.join('\n');
  const entries = openers.map((h, k) => {
    const opener = importLogEntryDate(`- ${h.title}`) !== h.date ? `- ${h.date} - ${h.title}` : `- ${h.title}`;
    const body = trimBlankLines(region.slice(h.line + 1, k + 1 < openers.length ? openers[k + 1]!.line : cut));
    const text = body.length === 0 ? opener : `${opener}\n\n${indentLines(body)}`;
    return { text, date: importLogEntryDate(text) };
  });
  const cutLine = offset + cut;
  const absorbed = new Set(doc.sections.slice(at + 1, end).filter((_, k) => starts[at + 1 + k]! < cutLine));
  return { rule: 'heading', preamble, entries, absorbed };
}

/**
 * The Log's entries, with the rule picked from its first line so one shape's
 * marker inside another's entry never splits it. Text before the first dash
 * entry is the preamble. A Log whose body is empty and is followed by deeper
 * headings is a heading Log (readHeadingLog).
 */
function readLogEntries(doc: ProjectDoc, logSection: ProjectDocSection | null, lines: string[]): LogRead {
  const none: LogRead = { rule: 'dash', preamble: null, entries: [], absorbed: new Set() };
  if (logSection === null) return none;
  const first = logSection.body.split('\n').find((line) => line.trim().length > 0);
  if (first === undefined) return readHeadingLog(doc, logSection, lines) ?? none;
  const bold = BOLD_DATE_START.test(first);
  const texts = bold ? splitBoldDateEntries(logSection.body) : splitLogEntries(logSection.body);
  const preamble = !bold && texts.length > 0 && !/^- /.test(texts[0]!) ? texts.shift()! : null;
  return { rule: bold ? 'bold' : 'dash', preamble, entries: texts.map((text) => ({ text, date: importLogEntryDate(text) })), absorbed: new Set() };
}

/**
 * Whether the source Log runs oldest first, read from its dated entries in
 * source order: the direction most adjacent pairs take (equal dates cast no
 * vote), then first against last on a tie. Otherwise newest first, the live
 * Log's own direction.
 */
function runsOldestFirst(entries: LogEntry[]): boolean {
  const dates = entries.flatMap((e) => (e.date === null ? [] : [e.date]));
  let up = 0;
  let down = 0;
  for (let i = 1; i < dates.length; i += 1) {
    if (dates[i]! > dates[i - 1]!) up += 1;
    else if (dates[i]! < dates[i - 1]!) down += 1;
  }
  if (up !== down) return up > down;
  return dates.length > 1 && dates[0]! < dates[dates.length - 1]!;
}

/**
 * Newest first. By date when every entry has one; ties keep source order,
 * read newest first. Otherwise the source's own sequence, reversed when it
 * runs oldest first, so an undated entry stays between the same neighbours.
 */
function orderLogEntries(entries: LogEntry[]): { ordered: LogEntry[]; order: ImportLogOrder } {
  const ascending = runsOldestFirst(entries);
  const oriented = ascending ? [...entries].reverse() : [...entries];
  if (entries.some((e) => e.date === null)) return { ordered: oriented, order: ascending ? 'source order reversed' : 'source order' };
  const ordered = oriented
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry.date === b.entry.date ? a.i - b.i : a.entry.date! < b.entry.date! ? 1 : -1))
    .map(({ entry }) => entry);
  return { ordered, order: 'by date' };
}

function planDocument(name: string, slug: string, body: string, logParts: Array<{ name: string; part: number; body: string }>): ImportFilePlan | string {
  const source = parseProjectDoc(body);
  const doc: ProjectDoc = { preamble: source.preamble, sections: source.sections.map((s) => ({ ...s, title: HEADING_MAP[s.title] ?? s.title })) };
  const duplicate = duplicateOwned(doc);
  if (duplicate) return `has more than one ${duplicate} section after mapping headings; merge them in the source first`;
  const logSection = doc.sections.find((section) => section.title === 'Log') ?? null;
  const { rule, preamble: logPreamble, entries, absorbed: entrySections } = readLogEntries(doc, logSection, body.split('\n'));
  // A heading-log entry is stored as Log text, not as the section it was.
  const sections: ImportSectionMapping[] = source.sections.map((s, i) => ({ from: s.title, to: entrySections.has(doc.sections[i]!) ? 'Log' : HEADING_MAP[s.title] ?? s.title, chars: s.body.length }));

  // A missing middle part would drop its archives unseen.
  if (logParts.some((part, i) => part.part !== i + 1)) return `log parts are not numbered 1 to ${logParts.length} without gaps: ${logParts.map((p) => p.name).join(', ')}`;
  // Parts are numbered newest first; archives go in oldest first.
  const reattached: string[] = [];
  for (const part of [...logParts].reverse()) {
    const read = readLogPart(slug, part.name, part.body);
    if (typeof read === 'string') return `${part.name}: ${read}`;
    // Reverse archives, never the rows of one split archive.
    reattached.push(...[...read].reverse().flat());
  }

  const over = (): boolean => serializeProjectDoc(doc).length > PROJECT_DOC_MAX_CHARS;
  const order = new Map(doc.sections.map((section, i) => [section, i]));
  const { ordered, order: logOrder } = orderLogEntries(entries);
  const reordered = ordered.some((entry, i) => entry !== entries[i]);
  let keep = Math.min(ordered.length, PROJECT_LOG_KEEP_ENTRIES);
  let preamble = logPreamble;
  // Rewrites only when an entry moves, so an already ordered Log keeps its exact spacing; a heading Log always converts.
  const setLog = (): void => {
    if (logSection === null || (rule !== 'heading' && keep >= ordered.length && !reordered && preamble === logPreamble)) return;
    const live = ordered.slice(0, keep).map((e) => e.text);
    if (rule === 'heading') {
      const rest = doc.sections.filter((section) => !entrySections.has(section));
      doc.sections.splice(0, doc.sections.length, ...rest);
    }
    logSection.body = (preamble === null ? live : [preamble, ...live]).join(rule === 'bold' ? '\n\n' : '\n');
  };
  setLog();

  // Extras first, last first: they are the least needed at session start.
  const moved: Array<{ ord: number; section: ProjectDocSection }> = [];
  const owned = new Set<string>(OWNED_HEADINGS);
  for (let i = doc.sections.length - 1; i >= 0 && over(); i -= 1) {
    const section = doc.sections[i]!;
    if (owned.has(section.title) || entrySections.has(section) || (i === 0 && section.level === 1)) continue;
    moved.push({ ord: order.get(section)!, section: { ...section } });
    doc.sections.splice(i, 1);
  }
  // Then older live entries go to the archives, where entries belong.
  while (over() && keep > 0) {
    keep -= 1;
    setLog();
  }
  // A preamble too long to stay with no entries left joins the archives, ahead of the entries.
  if (over() && preamble !== null) {
    preamble = null;
    setLog();
  }
  // Last, the largest remaining body moves whole, leaving a pointer so a reader knows where it went.
  while (over()) {
    const candidates = doc.sections.filter((section) => section !== logSection && !entrySections.has(section) && section.body.length > PROJECT_IMPORT_OVERFLOW_POINTER.length);
    if (candidates.length === 0) break;
    const target = candidates.reduce((a, b) => (b.body.length > a.body.length ? b : a));
    moved.push({ ord: order.get(target)!, section: { ...target } });
    target.body = PROJECT_IMPORT_OVERFLOW_POINTER;
  }
  const document = serializeProjectDoc(doc);
  if (document.length > PROJECT_DOC_MAX_CHARS) {
    return `still ${document.length} characters after moving every section body out; the text before the first heading exceeds ${PROJECT_DOC_MAX_CHARS}; shorten it in the source`;
  }
  if (document.trim().length === 0) return 'has no content';
  // Newest first before the cut, so reversing the rest gives oldest first.
  const rolled = [...(preamble === null && logPreamble !== null ? [logPreamble] : []), ...ordered.slice(keep).reverse().map((e) => e.text)];
  const inSourceOrder = moved.sort((a, b) => a.ord - b.ord).map((m) => m.section);
  const archives = [...reattached, ...chunkArchives(slug, rolled, name, logOrder === 'by date' ? 'oldest first' : 'source sequence')];
  const overflow = inSourceOrder.length > 0 ? overflowText(slug, inSourceOrder, name) : null;
  const overflow_parts = overflow === null ? [] : splitImportOverflow(slug, overflow);
  const rowBytes = [document, ...archives, ...overflow_parts].map(utf8Length);
  if (rowBytes.some((bytes) => bytes > PROJECT_IMPORT_ROW_MAX_BYTES)) throw new Error('Import produced a row over its byte cap.');
  return {
    name,
    slug,
    sections,
    document,
    archives,
    log_order: logOrder,
    overflow,
    overflow_parts,
    overflow_sections: inSourceOrder.map((section) => section.title),
    log_files: logParts.map((part) => part.name),
    archived_entries: rolled.length,
    largest_row_bytes: Math.max(...rowBytes),
    total_bytes: rowBytes.reduce((sum, bytes) => sum + bytes, 0),
  };
}

/** What importProject re-checks before writing, since a plan is caller data. Returns a reason or null. */
export function importPlanProblem(plan: ImportFilePlan): string | null {
  if (!plan || typeof plan !== 'object') return 'Import plan is malformed.';
  if (typeof plan.slug !== 'string' || !isValidProjectSlug(plan.slug)) return 'Import plan slug is invalid.';
  if (typeof plan.document !== 'string' || plan.document.trim().length === 0) return 'Import plan has no document.';
  if (plan.document.length > PROJECT_DOC_MAX_CHARS || utf8Length(plan.document) > PROJECT_IMPORT_ROW_MAX_BYTES) return 'Import plan document exceeds the project document cap.';
  const lead = plan.document.replace(/^[\s\uFEFF\u200B]+/, '');
  if (/^<!--\s*northkeep:/i.test(lead)) return 'Import plan document still carries a NorthKeep header.';
  if (duplicateOwned(parseProjectDoc(plan.document))) return 'Import plan document has a duplicated section.';
  if (!Array.isArray(plan.archives) || plan.archives.some((a) => typeof a !== 'string' || !a.startsWith(`${PROJECT_LOG_ARCHIVE_HEADING}: ${plan.slug}\n`))) {
    return 'Import plan archives are malformed.';
  }
  if (plan.archives.some((a) => utf8Length(a) > PROJECT_IMPORT_ROW_MAX_BYTES)) return 'Import plan archives are over the row cap.';
  const parts = plan.overflow_parts;
  const encoder = new TextEncoder();
  if (!Array.isArray(parts) || parts.some((part, i) => typeof part !== 'string' || !part.startsWith(`${PROJECT_IMPORT_OVERFLOW_HEADING}: ${plan.slug} (part ${i + 1} of ${parts.length})\n`) || encoder.encode(part).length > PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES)) {
    return 'Import plan overflow parts are malformed or over the row cap.';
  }
  return null;
}
