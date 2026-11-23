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

/**
 * A long row matches many query words by sheer size. The share taken off is
 * capped at 30%: at half, a long memory that held every word of the question
 * fell behind short ones holding one (ADR 0090 D3).
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
 * One ranker for both search tools, so they cannot drift (ADR 0090 D5). A
 * word found only in a scope or type name counts half, as before, so filing
 * a memory under a word never counts for more than saying it.
 */
export function rankSharedEntries<T extends { type: string; scope: string; content: string; confirmed?: boolean; archive?: boolean }>(
  entries: readonly T[],
  query: string,
  limit: number,
): T[] {
  const rows = entries.filter((entry) => !isProjectPaperwork(entry))
    .map((entry) => ({ entry, text: searchTerms(entry.content), names: searchTerms(`${entry.scope} ${entry.type}`) }));
  if (!/[a-z0-9]{2,}/i.test(query)) return rows.slice(0, limit).map((row) => row.entry);
  const terms = searchTerms(query);
  const weights = wordWeights(terms, rows.map((row) => new Set([...row.text, ...row.names])));
  let total = 0;
  for (const weight of weights.values()) total += weight;
  if (total === 0) return [];
  return rows
    .map(({ entry, text, names }) => {
      let matched = 0;
      for (const [term, weight] of weights) matched += text.has(term) ? weight : names.has(term) ? 0.5 * weight : 0;
      // The connector knows no recency or source, so confirmed is the only bonus (ADR 0090 D2, D3).
      const kept = entry.confirmed === true ? 1 + CONFIRMED_BOOST : 1 - lengthPenalty(text.size);
      return { entry, score: (matched / total) * kept };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}
