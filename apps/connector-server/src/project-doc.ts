/**
 * Project documents: a Markdown convention on an ordinary vault memory
 * (ADR 0039). Pure and dependency-free so MCP, GUI, and tests share one parse /
 * merge / serialize path.
 *
 * Five fixed headings: What & Why, Current Status, Next Actions, Decisions,
 * Log. Extra headings are preserved verbatim. There is no stored INDEX memory.
 */

export const PROJECT_DOC_MAX_CHARS = 16384;

export const PROJECT_SCOPE_PREFIX = 'project:';

/** Slug half of `project:<slug>`. Fits inside the existing MCP scopeSchema. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** How many Log entries the live document keeps once it has to roll (ADR 0045). */
export const PROJECT_LOG_KEEP_ENTRIES = 10;
/** First line of an archive memory holding rolled Log entries; project_get --history lists these. */
export const PROJECT_LOG_ARCHIVE_HEADING = '## Log archive';

export const PROJECT_DOC_CAP_MESSAGE =
  `This project document exceeds ${PROJECT_DOC_MAX_CHARS} characters even after rolling its Log. Shorten What & Why, Current Status, or Next Actions, then try again. NorthKeep will not silently truncate.`;

export const PROJECT_SECTION_HEADINGS = [
  'What & Why',
  'Current Status',
  'Next Actions',
  'Decisions',
  'Log',
] as const;

export type ProjectSectionHeading = (typeof PROJECT_SECTION_HEADINGS)[number];

export interface ProjectDocSection {
  /** 1–6, from the ATX heading that opened this section. */
  level: number;
  title: string;
  body: string;
}

export interface ProjectDoc {
  /** Text before the first heading, if any. Preserved on serialize. */
  preamble: string;
  sections: ProjectDocSection[];
}

export interface ProjectDocUpdate {
  whatWhy?: string;
  status?: string;
  nextActions?: string;
  /** Appended to Decisions with a dated prefix. */
  decision?: string;
  /** Prepended to Log (newest first) with a dated prefix. */
  logEntry?: string;
}

/** A line that opens a Markdown section: 0–3 spaces, 1–6 hashes, space, title. */
const HEADING_RE = /^( {0,3})(#{1,6})[ \t]+(\S.*?)[ \t]*$/;

function isKnownHeading(title: string): title is ProjectSectionHeading {
  return (PROJECT_SECTION_HEADINGS as readonly string[]).includes(title);
}

export function isValidProjectSlug(slug: string): boolean {
  return PROJECT_SLUG_PATTERN.test(slug);
}

export function projectScope(slug: string): string {
  if (!isValidProjectSlug(slug)) {
    throw new Error(
      `Invalid project slug "${slug}". Use 1–40 lowercase letters, digits, or hyphens.`,
    );
  }
  return `${PROJECT_SCOPE_PREFIX}${slug}`;
}

/** The slug if `scope` is `project:` plus a valid slug; otherwise null. */
export function parseProjectSlug(scope: string): string | null {
  if (!scope.startsWith(PROJECT_SCOPE_PREFIX)) return null;
  const slug = scope.slice(PROJECT_SCOPE_PREFIX.length);
  return isValidProjectSlug(slug) ? slug : null;
}

export function isProjectScope(scope: string): boolean {
  return scope.startsWith(PROJECT_SCOPE_PREFIX);
}

export function emptyProjectDoc(): ProjectDoc {
  return {
    preamble: '',
    sections: PROJECT_SECTION_HEADINGS.map((title) => ({ level: 2, title, body: '' })),
  };
}

/**
 * Split Markdown into preamble + sections on ATX headings at the start of a
 * line. Mid-line `## Heading` lookalikes and hashes without a following space
 * do not open a section.
 */
export function parseProjectDoc(markdown: string): ProjectDoc {
  const text = markdown.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const preambleLines: string[] = [];
  const sections: ProjectDocSection[] = [];
  let current: ProjectDocSection | null = null;

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      const level = match[2]!.length;
      const title = match[3]!.trim();
      if (current) sections.push(finalizeSection(current));
      current = { level, title, body: '' };
      continue;
    }
    if (current === null) preambleLines.push(line);
    else current.body += (current.body.length > 0 ? '\n' : '') + line;
  }
  if (current) sections.push(finalizeSection(current));

  return {
    preamble: trimSectionBody(preambleLines.join('\n')),
    sections,
  };
}

function finalizeSection(section: ProjectDocSection): ProjectDocSection {
  return { ...section, body: trimSectionBody(section.body) };
}

/** Strip a single leading and trailing newline run; keep internal blank lines. */
function trimSectionBody(body: string): string {
  return body.replace(/^\n+/, '').replace(/\n+$/, '');
}

export function serializeProjectDoc(doc: ProjectDoc): string {
  const parts: string[] = [];
  if (doc.preamble.length > 0) parts.push(doc.preamble);
  for (const section of doc.sections) {
    const hashes = '#'.repeat(section.level);
    if (section.body.length === 0) parts.push(`${hashes} ${section.title}`);
    else parts.push(`${hashes} ${section.title}\n\n${section.body}`);
  }
  return parts.join('\n\n');
}

export function getProjectSection(doc: ProjectDoc, heading: ProjectSectionHeading): string {
  const found = doc.sections.find((s) => s.title === heading);
  return found?.body ?? '';
}

export function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/**
 * Structured merge: replace What & Why / Current Status / Next Actions;
 * append a dated decision; prepend a dated log entry (newest first).
 * Throws if the serialized result exceeds PROJECT_DOC_MAX_CHARS.
 */
export function mergeProjectDoc(
  doc: ProjectDoc,
  update: ProjectDocUpdate,
  now: Date = new Date(),
): ProjectDoc {
  const next: ProjectDoc = {
    preamble: doc.preamble,
    sections: doc.sections.map((s) => ({ ...s })),
  };
  ensureKnownSections(next);

  if (update.whatWhy !== undefined) setKnownBody(next, 'What & Why', update.whatWhy);
  if (update.status !== undefined) setKnownBody(next, 'Current Status', update.status);
  if (update.nextActions !== undefined) setKnownBody(next, 'Next Actions', update.nextActions);

  const date = isoDate(now);
  if (update.decision !== undefined) {
    const line = datedBullet(date, update.decision);
    const existing = getProjectSection(next, 'Decisions');
    setKnownBody(next, 'Decisions', existing.length === 0 ? line : `${existing}\n${line}`);
  }
  if (update.logEntry !== undefined) {
    const line = datedBullet(date, update.logEntry);
    const existing = getProjectSection(next, 'Log');
    setKnownBody(next, 'Log', existing.length === 0 ? line : `${line}\n${existing}`);
  }

  // Size is NOT enforced here (ADR 0045): the host rolls the Log with
  // rollProjectLog and then asserts. A document whose hand-written sections
  // alone exceed the cap still fails, from assertProjectDocSize.
  return next;
}

export function assertProjectDocSize(markdown: string): void {
  if (markdown.length > PROJECT_DOC_MAX_CHARS) {
    throw new Error(PROJECT_DOC_CAP_MESSAGE);
  }
}

/**
 * The Log section as entries, in document order (newest first). An entry is a
 * top-level bullet (`- `) and every following line until the next one, so a
 * multi-line entry stays whole. Text before the first bullet is its own item.
 */
export function splitLogEntries(body: string): string[] {
  const entries: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (/^- /.test(line)) {
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

export interface RolledProjectDoc {
  doc: ProjectDoc;
  /** Entries moved out of the live document, oldest first. Empty when nothing rolled. */
  archived: string[];
}

/**
 * Keep the live document under the cap by rolling the oldest Log entries out
 * (ADR 0045). Nothing rolls while the document fits. When it does not, the
 * newest `keep` entries stay; if the document still does not fit, fewer stay,
 * down to one. If it still does not fit, the hand-written sections are the
 * problem and the caller's assertProjectDocSize reports it. Decisions never
 * roll: they are short and a cold session needs them.
 */
export function rollProjectLog(
  doc: ProjectDoc,
  options: { maxChars?: number; keep?: number } = {},
): RolledProjectDoc {
  const maxChars = options.maxChars ?? PROJECT_DOC_MAX_CHARS;
  const keepAtMost = Math.max(1, options.keep ?? PROJECT_LOG_KEEP_ENTRIES);
  if (serializeProjectDoc(doc).length <= maxChars) return { doc, archived: [] };
  const entries = splitLogEntries(getProjectSection(doc, 'Log'));
  if (entries.length <= 1) return { doc, archived: [] };
  for (let keep = Math.min(keepAtMost, entries.length - 1); keep >= 1; keep -= 1) {
    const next: ProjectDoc = { preamble: doc.preamble, sections: doc.sections.map((s) => ({ ...s })) };
    ensureKnownSections(next);
    setKnownBody(next, 'Log', entries.slice(0, keep).join('\n'));
    if (serializeProjectDoc(next).length <= maxChars) {
      return { doc: next, archived: entries.slice(keep).reverse() };
    }
  }
  // Even one entry does not fit: roll everything but the newest and let the
  // caller's size assertion name the real problem.
  const next: ProjectDoc = { preamble: doc.preamble, sections: doc.sections.map((s) => ({ ...s })) };
  ensureKnownSections(next);
  setKnownBody(next, 'Log', entries[0]!);
  return { doc: next, archived: entries.slice(1).reverse() };
}

/** The content of the archive memory that holds rolled entries (oldest first). */
export function formatLogArchive(project: string, archived: string[], now: Date = new Date()): string {
  return (
    `${PROJECT_LOG_ARCHIVE_HEADING}: ${project}\n\n` +
    `Rolled ${isoDate(now)} out of the live project document, which keeps only its newest ` +
    `entries. Oldest first. Read with project_get history, or search this scope.\n\n` +
    archived.join('\n')
  );
}

export function isProjectLogArchive(content: string): boolean {
  return content.startsWith(`${PROJECT_LOG_ARCHIVE_HEADING}:`) || content.startsWith(`${PROJECT_LOG_ARCHIVE_HEADING}\n`);
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Tool owns the date. Strip a caller-supplied leading stamp
 * (`- YYYY-MM-DD - ` or `YYYY-MM-DD - `, repeated) so agents that
 * date the line do not double-stamp.
 */
function datedBullet(date: string, text: string): string {
  const stamp = /^(?:-\s*)?\d{4}-\d{2}-\d{2}\s*-\s*/;
  let stripped = text.trim();
  while (stamp.test(stripped)) stripped = stripped.replace(stamp, '').trim();
  return `- ${date} - ${stripped}`;
}

function setKnownBody(doc: ProjectDoc, heading: ProjectSectionHeading, body: string): void {
  const found = doc.sections.find((s) => s.title === heading);
  if (found) {
    found.body = trimSectionBody(body);
    return;
  }
  // ensureKnownSections should have inserted it; keep a defensive append.
  doc.sections.push({ level: 2, title: heading, body: trimSectionBody(body) });
}

/**
 * Insert any missing known headings in canonical order, without reordering
 * extras that are already present.
 */
function ensureKnownSections(doc: ProjectDoc): void {
  for (const title of PROJECT_SECTION_HEADINGS) {
    if (doc.sections.some((s) => s.title === title)) continue;
    const insertAt = insertionIndex(doc.sections, title);
    doc.sections.splice(insertAt, 0, { level: 2, title, body: '' });
  }
}

function insertionIndex(sections: ProjectDocSection[], title: ProjectSectionHeading): number {
  const order = PROJECT_SECTION_HEADINGS;
  const target = order.indexOf(title);
  // Place after the last known heading that precedes this one in canonical order.
  let after = -1;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    if (!isKnownHeading(section.title)) continue;
    if (order.indexOf(section.title) < target) after = i;
  }
  return after + 1;
}

/** Map a known heading to the merge field it owns. Exhaustive on purpose. */
export function projectSectionKind(
  heading: ProjectSectionHeading,
): 'whatWhy' | 'status' | 'nextActions' | 'decisions' | 'log' {
  switch (heading) {
    case 'What & Why':
      return 'whatWhy';
    case 'Current Status':
      return 'status';
    case 'Next Actions':
      return 'nextActions';
    case 'Decisions':
      return 'decisions';
    case 'Log':
      return 'log';
    default: {
      const _exhaustive: never = heading;
      return _exhaustive;
    }
  }
}
