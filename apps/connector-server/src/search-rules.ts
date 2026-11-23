/**
 * ADR 0084 on the connector: copy of packages/core/src/search-rules.ts (the
 * connector cannot import core). A test keeps the stopword lists identical.
 */
import { isProjectLogArchive, parseProjectSlug } from './project-doc.js';

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

/** A query word found in more than this share of the rows searched says little about any one of them. */
export const COMMON_WORD_SHARE = 0.1;
/** With fewer rows than this, no word is treated as common. */
export const COMMON_WORD_MIN_ROWS = 20;

/**
 * The query words that are not common. A row that matches none of them, only
 * a word such as the user's own name, is listed after rows that do: every
 * confirmed memory matched the name and crowded out the answer (ADR 0087).
 */
export function rareTerms(queryTerms: ReadonlySet<string>, rows: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  if (rows.length < COMMON_WORD_MIN_ROWS) return new Set(queryTerms);
  const rare = new Set<string>();
  for (const term of queryTerms) {
    let found = 0;
    for (const row of rows) if (row.has(term)) found += 1;
    if (found <= rows.length * COMMON_WORD_SHARE) rare.add(term);
  }
  return rare;
}

/**
 * A long row matches many query words by sheer size, so its keyword score is
 * cut by up to 0.3 once it holds more than 64 distinct words.
 */
export function lengthPenalty(distinctWords: number): number {
  return Math.min(0.3, 0.1 * Math.log2(Math.max(1, distinctWords / 64)));
}

/** How much a confirmed memory rises once admitted. It never admits a row on its own. */
export const CONFIRMED_BOOST = 0.5;

/** D3: rows search leaves to the project tools (connector rows are always live). */
export function isProjectPaperwork(row: { type: string; scope: string; content: string; archive?: boolean }): boolean {
  const inProject = parseProjectSlug(row.scope) !== null;
  if (inProject && row.type === 'working') return true;
  if (inProject && isProjectLogArchive(row.content)) return true;
  return row.archive === true;
}

/**
 * D5: whole-word matches on non-stopwords. A word in the memory counts 1, a
 * word only in its scope or type counts half. A query of stopwords alone
 * scores 0; an empty query keeps the old list-everything behaviour.
 */
export function scoreSharedEntry(
  entry: { type: string; scope: string; content: string; confirmed?: boolean },
  query: string,
): number {
  if (!/[a-z0-9]{2,}/i.test(query)) return 1;
  const terms = searchTerms(query);
  if (terms.size === 0) return 0;
  const body = searchTerms(entry.content);
  const label = searchTerms(`${entry.scope} ${entry.type}`);
  let score = 0;
  for (const t of terms) {
    if (body.has(t)) score += 1;
    else if (label.has(t)) score += 0.5;
  }
  if (score === 0) return 0;
  return score + (entry.confirmed === true ? CONFIRMED_BOOST : 0);
}

/**
 * What both search tools return: paperwork skipped, best match first. A row
 * that matched only common words, in its text or its scope and type names, is
 * listed after every row that matched something rarer (ADR 0087).
 */
export function rankSharedEntries<T extends { type: string; scope: string; content: string; confirmed?: boolean; archive?: boolean }>(
  entries: readonly T[],
  query: string,
  limit: number,
): T[] {
  const rows = entries.filter((entry) => !isProjectPaperwork(entry))
    .map((entry) => ({ entry, body: searchTerms(entry.content), label: searchTerms(`${entry.scope} ${entry.type}`) }));
  const terms = searchTerms(query);
  const rareInText = rareTerms(terms, rows.map((row) => row.body));
  // Measured apart from the text: "personal" can be on most rows while one project scope is on a few.
  const rareInLabel = rareTerms(terms, rows.map((row) => row.label));
  return rows
    .map(({ entry, body, label }) => {
      let strong = false;
      for (const term of terms) if ((rareInText.has(term) && body.has(term)) || (rareInLabel.has(term) && label.has(term))) strong = true;
      return { entry, score: scoreSharedEntry(entry, query), weak: !strong };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => Number(a.weak) - Number(b.weak) || b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}
