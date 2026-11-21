/**
 * ADR 0084: what memory search skips, which words count as a match, and the
 * confirmed marker. The connector keeps a copy of these rules
 * (apps/connector-server/src/search-rules.ts); a test keeps the two identical.
 */
import { parseProjectSlug, isProjectLogArchive } from './project-doc.js';

/**
 * Words too common to count as a keyword match on their own (D5). A query
 * made only of these finds nothing by keyword.
 */
export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before',
  'being', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me',
  'my', 'no', 'not', 'now', 'of', 'on', 'or', 'our', 'ours', 'she', 'so', 'some', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'us',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours',
]);

/**
 * Lower-cased words of two or more letters or digits, stopwords removed, with
 * a plain trailing "s" folded so "dogs" finds "dog".
 */
export function searchTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().normalize('NFC').matchAll(/[a-z0-9]{2,}/g)) {
    const word = match[0];
    if (SEARCH_STOPWORDS.has(word)) continue;
    terms.add(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return terms;
}

/**
 * A long row matches many query words by sheer size, so its keyword score is
 * cut by up to 0.3 once it holds more than 64 distinct words.
 */
export function lengthPenalty(distinctWords: number): number {
  return Math.min(0.3, 0.1 * Math.log2(Math.max(1, distinctWords / 64)));
}

/** Metadata key for a memory the user confirmed (D4). Only the app and CLI write it. */
export const CONFIRMED_METADATA_KEY = 'confirmed';
/** Metadata key NorthKeep's own writers set on a row moved out of a project document. */
export const ARCHIVE_METADATA_KEY = 'archive';

/** How much a confirmed memory rises once admitted. It never admits a row on its own. */
export const CONFIRMED_BOOST = 0.5;

export function isConfirmed(metadata: Record<string, unknown> | null | undefined): boolean {
  const value = metadata?.[CONFIRMED_METADATA_KEY];
  return typeof value === 'object' && value !== null && (value as { by?: unknown }).by === 'user';
}

export function isMarkedArchive(metadata: Record<string, unknown> | null | undefined): boolean {
  const value = metadata?.[ARCHIVE_METADATA_KEY];
  return typeof value === 'object' && value !== null;
}

/**
 * D3: rows memory search leaves to the project tools. A live project document
 * is read with project_get, a log archive with project_get history, and a
 * marked archive is old project paperwork that would outrank real facts.
 */
export function isProjectPaperwork(row: {
  type: string;
  scope: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  superseded_at?: string | null;
  forgotten_at?: string | null;
}): boolean {
  const inProject = parseProjectSlug(row.scope) !== null;
  if (inProject && row.type === 'working' && !row.superseded_at && !row.forgotten_at) return true;
  if (inProject && isProjectLogArchive(row.content)) return true;
  return isMarkedArchive(row.metadata);
}
