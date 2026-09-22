/**
 * Import of a folder of Markdown project files (ADR 0053 Decision 10). Pure:
 * planImport takes names and text, never paths, so the source cannot be
 * touched, and returns the whole plan, which is the dry run. Vault.importProject
 * is the write. Headerless files and NorthKeep's own `kind document` files
 * import; `kind log` files reattach their archives to the slug; `kind index`
 * and `kind marker` files are skipped. The header is stripped and never
 * stored. Log entries keep their own dates: they are moved into ADR 0045
 * archives, oldest first, not replayed through project_update. The newest ten
 * stay live. If the document is still over the cap, extra sections move, last
 * first, into numbered overflow memories, then older live entries join the archives,
 * then the largest remaining bodies move whole, leaving a pointer. Nothing is
 * ever cut.
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
  /** Archive memory contents, oldest first. */
  archives: string[];
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
}

export interface ImportSkip { name: string; reason: string }
export interface ImportPlan { projects: ImportFilePlan[]; skipped: ImportSkip[] }

const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * An ADR 0045 archive holding imported entries, oldest first, with the
 * `## Log archive: <slug>` first line getProjectView looks for. Lives here,
 * not in project-doc.ts, because the connector never imports and that file
 * must stay byte-identical to its copy.
 */
export function formatImportedLogArchive(project: string, entries: string[], sourceFile: string): string {
  const source = sourceFile.replace(UNSAFE_NAME_CHARS, ' ').trim() || 'an unnamed file';
  return (
    `${PROJECT_LOG_ARCHIVE_HEADING}: ${project}\n\n` +
    `Imported from ${source} by northkeep projects import, entries with their original dates. ` +
    `Oldest first. Read with project_get history, or search this scope.\n\n` +
    entries.join('\n')
  );
}

/** Groups oldest-first entries into archives under the document cap, so each row stays under the 64 KiB share cap. */
function chunkArchives(project: string, entries: string[], sourceFile: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const entry of entries) {
    const next = [...current, entry];
    if (current.length > 0 && formatImportedLogArchive(project, next, sourceFile).length > PROJECT_DOC_MAX_CHARS) {
      out.push(formatImportedLogArchive(project, current, sourceFile));
      current = [entry];
    } else {
      current = next;
    }
  }
  if (current.length > 0) out.push(formatImportedLogArchive(project, current, sourceFile));
  return out;
}

/** Under the connector's 65,536-byte row cap with room to spare. */
export const PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES = 60000;
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
  const budget = PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES - OVERFLOW_HEADER_RESERVE;
  const chunks: Array<{ text: string; split: boolean }> = [];
  let current = '';
  let size = 0;
  let split = false;
  const flush = (): void => {
    if (current.length > 0) chunks.push({ text: current, split });
    current = '';
    size = 0;
    split = false;
  };
  for (const line of overflow.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const bytes = encoder.encode(line).length;
    if (bytes <= budget) {
      if (size + bytes > budget) flush();
      current += line;
      size += bytes;
      continue;
    }
    flush();
    for (const point of Array.from(line)) {
      const b = encoder.encode(point).length;
      if (size + b > budget) {
        split = true;
        flush();
      }
      current += point;
      size += b;
      split = true;
    }
    flush();
  }
  flush();
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

/** Archives from one rendered log part, newest first as the part lists them. */
function readLogPart(slug: string, name: string, body: string): string[] | string {
  const doc = parseProjectDoc(body);
  const archives: string[] = [];
  for (const section of doc.sections) {
    if (section.level === 1) continue;
    if (section.level !== 2 || !section.title.startsWith(MIRROR_ARCHIVE_SECTION_PREFIX)) return `unexpected heading "${section.title}" in a log file`;
    const rolled = section.title.slice(MIRROR_ARCHIVE_SECTION_PREFIX.length);
    const { entries } = splitLogArchive(`heading\n\n${section.body}`);
    if (entries.length === 0) continue;
    archives.push(formatImportedLogArchive(slug, [...entries].reverse(), `${name}, archive rolled ${rolled}`));
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
  return { projects, skipped };
}

function planDocument(name: string, slug: string, body: string, logParts: Array<{ name: string; part: number; body: string }>): ImportFilePlan | string {
  const source = parseProjectDoc(body);
  const sections: ImportSectionMapping[] = source.sections.map((s) => ({ from: s.title, to: HEADING_MAP[s.title] ?? s.title, chars: s.body.length }));
  const doc: ProjectDoc = { preamble: source.preamble, sections: source.sections.map((s) => ({ ...s, title: HEADING_MAP[s.title] ?? s.title })) };
  const duplicate = duplicateOwned(doc);
  if (duplicate) return `has more than one ${duplicate} section after mapping headings; merge them in the source first`;

  // A missing middle part would drop its archives unseen.
  if (logParts.some((part, i) => part.part !== i + 1)) return `log parts are not numbered 1 to ${logParts.length} without gaps: ${logParts.map((p) => p.name).join(', ')}`;
  // Parts are numbered newest first; archives go in oldest first.
  const reattached: string[] = [];
  for (const part of [...logParts].reverse()) {
    const read = readLogPart(slug, part.name, part.body);
    if (typeof read === 'string') return `${part.name}: ${read}`;
    reattached.push(...[...read].reverse());
  }

  const over = (): boolean => serializeProjectDoc(doc).length > PROJECT_DOC_MAX_CHARS;
  const order = new Map(doc.sections.map((section, i) => [section, i]));
  const logSection = doc.sections.find((section) => section.title === 'Log') ?? null;
  const entries = logSection ? splitLogEntries(logSection.body) : [];
  let keep = Math.min(entries.length, PROJECT_LOG_KEEP_ENTRIES);
  const setLog = (): void => {
    if (logSection && keep < entries.length) logSection.body = entries.slice(0, keep).join('\n');
  };
  setLog();

  // Extras first, last first: they are the least needed at session start.
  const moved: Array<{ ord: number; section: ProjectDocSection }> = [];
  const owned = new Set<string>(OWNED_HEADINGS);
  for (let i = doc.sections.length - 1; i >= 0 && over(); i -= 1) {
    const section = doc.sections[i]!;
    if (owned.has(section.title) || (i === 0 && section.level === 1)) continue;
    moved.push({ ord: order.get(section)!, section: { ...section } });
    doc.sections.splice(i, 1);
  }
  // Then older live entries go to the archives, where entries belong.
  while (over() && keep > 0) {
    keep -= 1;
    setLog();
  }
  // Last, the largest remaining body moves whole, leaving a pointer so a reader knows where it went.
  while (over()) {
    const candidates = doc.sections.filter((section) => section !== logSection && section.body.length > PROJECT_IMPORT_OVERFLOW_POINTER.length);
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
  const rolled = entries.slice(keep).reverse();
  const inSourceOrder = moved.sort((a, b) => a.ord - b.ord).map((m) => m.section);
  const archives = [...reattached, ...chunkArchives(slug, rolled, name)];
  const overflow = inSourceOrder.length > 0 ? overflowText(slug, inSourceOrder, name) : null;
  const overflow_parts = overflow === null ? [] : splitImportOverflow(slug, overflow);
  const encoder = new TextEncoder();
  return {
    name,
    slug,
    sections,
    document,
    archives,
    overflow,
    overflow_parts,
    overflow_sections: inSourceOrder.map((section) => section.title),
    log_files: logParts.map((part) => part.name),
    archived_entries: rolled.length,
    largest_row_bytes: Math.max(...[document, ...archives, ...overflow_parts].map((row) => encoder.encode(row).length)),
  };
}

/** What importProject re-checks before writing, since a plan is caller data. Returns a reason or null. */
export function importPlanProblem(plan: ImportFilePlan): string | null {
  if (!plan || typeof plan !== 'object') return 'Import plan is malformed.';
  if (typeof plan.slug !== 'string' || !isValidProjectSlug(plan.slug)) return 'Import plan slug is invalid.';
  if (typeof plan.document !== 'string' || plan.document.trim().length === 0) return 'Import plan has no document.';
  if (plan.document.length > PROJECT_DOC_MAX_CHARS) return 'Import plan document exceeds the project document cap.';
  const lead = plan.document.replace(/^[\s\uFEFF\u200B]+/, '');
  if (/^<!--\s*northkeep:/i.test(lead)) return 'Import plan document still carries a NorthKeep header.';
  if (duplicateOwned(parseProjectDoc(plan.document))) return 'Import plan document has a duplicated section.';
  if (!Array.isArray(plan.archives) || plan.archives.some((a) => typeof a !== 'string' || !a.startsWith(`${PROJECT_LOG_ARCHIVE_HEADING}: ${plan.slug}\n`))) {
    return 'Import plan archives are malformed.';
  }
  const parts = plan.overflow_parts;
  const encoder = new TextEncoder();
  if (!Array.isArray(parts) || parts.some((part, i) => typeof part !== 'string' || !part.startsWith(`${PROJECT_IMPORT_OVERFLOW_HEADING}: ${plan.slug} (part ${i + 1} of ${parts.length})\n`) || encoder.encode(part).length > PROJECT_IMPORT_OVERFLOW_PART_MAX_BYTES)) {
    return 'Import plan overflow parts are malformed or over the row cap.';
  }
  return null;
}
