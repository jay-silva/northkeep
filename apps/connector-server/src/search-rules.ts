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
 * How much each query word counts (ADR 0090 D1): a word rare among the rows
 * searched counts for more, and one no row holds counts for nothing. The 10
 * keeps weights close together until a vault is big enough to tell.
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

/** The share of the query's weight a row holds; 0 when it holds none of the query's words. */
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
 * A long row matches many query words by sheer size, so its match is marked
 * down by this share: 15% per doubling past 64 distinct words, up to half
 * (ADR 0090 D3). A memory the user confirmed is not marked down.
 */
export function lengthPenalty(distinctWords: number): number {
  return Math.min(0.5, 0.15 * Math.log2(Math.max(1, distinctWords / 64)));
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
 * What both search tools return, best match first (ADR 0084 D5, ADR 0090 D5).
 * A query word counts by how rare it is among the rows; a word found only in a
 * scope or type name counts at half its weight among those names. A query with
 * no words lists everything; one made only of stopwords finds nothing.
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
  const inText = wordWeights(terms, rows.map((row) => row.text));
  const inNames = wordWeights(terms, rows.map((row) => row.names));
  let total = 0;
  for (const term of terms) total += Math.max(inText.get(term) ?? 0, 0.5 * (inNames.get(term) ?? 0));
  if (total === 0) return [];
  return rows
    .map(({ entry, text, names }) => {
      let matched = 0;
      for (const term of terms) {
        if (text.has(term)) matched += inText.get(term) ?? 0;
        else if (names.has(term)) matched += 0.5 * (inNames.get(term) ?? 0);
      }
      // The connector knows no recency or source, so confirmed is the only bonus (ADR 0090 D2, D3).
      const kept = entry.confirmed === true ? 1 + CONFIRMED_BOOST : 1 - lengthPenalty(text.size);
      return { entry, score: (matched / total) * kept };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}
