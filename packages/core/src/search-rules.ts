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
 * ADR 0090 D1. Counting every query word the same let a row that shared only
 * the user's name outrank the answer. The 10 keeps a tiny vault from calling
 * a word rare on two rows' evidence.
 */
export function wordWeights(queryTerms: ReadonlySet<string>, rows: ReadonlyArray<ReadonlySet<string>>): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of queryTerms) {
    let holding = 0;
    for (const row of rows) if (row.has(term)) holding += 1;
    weights.set(term, holding === 0 ? 0 : Math.log((rows.length + 10.5) / (holding + 0.5)));
  }
  return weights;
}

/** Zero exactly when the row holds none of the query's words, so it doubles as the admission test. */
export function weightedMatch(weights: ReadonlyMap<string, number>, rowTerms: ReadonlySet<string>): number {
  let matched = 0;
  let total = 0;
  for (const [term, weight] of weights) {
    total += weight;
    if (rowTerms.has(term)) matched += weight;
  }
  return total === 0 ? 0 : matched / total;
}

/** ADR 0085 D3: the share of a save's word weight a memory must already hold for the save to be held. */
export const SAVE_HOLD_COVER = 0.6;
/** How many near matches a held save lists. */
export const SAVE_HOLD_LIST = 3;

/**
 * Text as the identical-save test compares it. Only sentence punctuation at
 * word edges is dropped: a sign or symbol there ("O+", "-500", a currency
 * mark, brackets round an amount) changes the fact; calling those identical lost the save.
 */
export function saveNormalForm(text: string): string {
  return text.normalize('NFC').toLowerCase().split(/\s+/).map(saveWord).filter((word) => word.length > 0).join(' ');
}

const SAVE_STOPS = '.,;:';
const SAVE_QUOTES = `"'“”‘’`;

/** A loop, not a regex: a long run of punctuation inside a word made the regex quadratic. */
function saveWord(word: string): string {
  let start = 0;
  while (start < word.length && SAVE_QUOTES.includes(word[start]!)) start += 1;
  let end = word.length;
  while (end > start && (SAVE_STOPS + SAVE_QUOTES + '!?').includes(word[end - 1]!)) end -= 1;
  const body = word.slice(start, end);
  // After a digit a quote is a unit (6' and 6") and ! or ? can change the value, so those stay.
  if (!/[0-9]$/.test(body)) return body;
  let kept = '';
  for (const mark of word.slice(end)) if (!SAVE_STOPS.includes(mark)) kept += mark;
  return body + kept;
}

/**
 * ADR 0085 D3. A word no memory holds weighs most here, where wordWeights
 * gives it nothing: in a save the new word is the new information. Only the
 * save's side is measured, or a short memory would hold every later fact.
 */
export function checkSave<T extends { content: string }>(content: string, candidates: readonly T[]): { identical: T | null; held: T[] } {
  const normal = saveNormalForm(content);
  const identical = normal === '' ? undefined : candidates.find((row) => saveNormalForm(row.content) === normal);
  if (identical !== undefined) return { identical, held: [] };
  const terms = searchTerms(content);
  const rows = candidates.map((row) => ({ row, terms: searchTerms(row.content) }));
  const weights = new Map<string, number>();
  let total = 0;
  for (const term of terms) {
    let holding = 0;
    for (const row of rows) if (row.terms.has(term)) holding += 1;
    const weight = Math.log((rows.length + 10.5) / (holding + 0.5));
    weights.set(term, weight);
    total += weight;
  }
  if (total === 0) return { identical: null, held: [] };
  const held: Array<{ row: T; cover: number }> = [];
  for (const row of rows) {
    let shared = 0;
    let matched = 0;
    for (const [term, weight] of weights) {
      if (!row.terms.has(term)) continue;
      shared += 1;
      matched += weight;
    }
    if (shared >= 2 && matched / total >= SAVE_HOLD_COVER) held.push({ row: row.row, cover: matched / total });
  }
  held.sort((a, b) => b.cover - a.cover);
  return { identical: null, held: held.slice(0, SAVE_HOLD_LIST).map((entry) => entry.row) };
}

/**
 * A long row matches many query words by sheer size. The share taken off is
 * capped at 30%: at half, a long memory that held every word of the question
 * fell behind short ones holding one (ADR 0090 D3).
 */
export function lengthPenalty(distinctWords: number): number {
  return Math.min(0.3, 0.1 * Math.log2(Math.max(1, distinctWords / 64)));
}

/** An AI app's session note older than this ranks below every other match (D8). */
export const OLD_NOTE_DAYS = 30;

/**
 * D8: an episodic memory an AI app wrote ("mcp", "mcp:<host>", "connector:<host>")
 * more than OLD_NOTE_DAYS ago. Old notes are often stale, so search lists them
 * after every other match instead of dropping them. A confirmed one is not demoted.
 */
export function isOldAgentNote(
  row: { type: string; source: string; created_at: string; metadata?: Record<string, unknown> | null },
  now: number,
): boolean {
  if (row.type !== 'episodic' || isConfirmed(row.metadata)) return false;
  if (!(row.source === 'mcp' || row.source.startsWith('mcp:') || row.source.startsWith('connector:'))) return false;
  return now - Date.parse(row.created_at) > OLD_NOTE_DAYS * 86_400_000;
}

/** Search order: old agent notes last, then by score. */
export function compareSearchResults(
  a: { entry: { type: string; source: string; created_at: string; metadata?: Record<string, unknown> | null }; score: number },
  b: { entry: { type: string; source: string; created_at: string; metadata?: Record<string, unknown> | null }; score: number },
  now: number,
): number {
  const tier = Number(isOldAgentNote(a.entry, now)) - Number(isOldAgentNote(b.entry, now));
  return tier !== 0 ? tier : b.score - a.score;
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
