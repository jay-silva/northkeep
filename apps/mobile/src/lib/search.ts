/**
 * Keyword filter for the memories screen: browse + search reuse Vault.list()
 * (M6-1 scope). Pure TypeScript, no React Native imports, unit-tested under
 * Node (apps/mobile/test/search.test.ts).
 *
 * Tokenization mirrors packages/core/src/vault.ts tokenize(): lowercase, NFC,
 * alphanumeric runs of 2+ characters. The filter is an AND over query terms
 * matched as prefixes against content/scope/type tokens, so typing narrows
 * results the way the web GUI's search box feels. Scored retrieval
 * (Vault.retrieve) stays reserved for Converse context in M6-3.
 */

/** The minimal shape the filter needs; MemoryEntry satisfies it. */
export interface SearchableEntry {
  content: string;
  scope: string;
  type: string;
}

function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.toLowerCase().normalize('NFC').matchAll(/[a-z0-9]{2,}/g)) {
    terms.push(match[0]);
  }
  return terms;
}

/**
 * Returns the entries matching every query term (prefix match against any
 * token of content, scope, or type), preserving input order. An empty or
 * token-less query returns the full list unchanged.
 */
export function filterMemories<T extends SearchableEntry>(entries: readonly T[], query: string): T[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [...entries];
  return entries.filter((entry) => {
    const tokens = tokenize(`${entry.content} ${entry.scope} ${entry.type}`);
    return queryTerms.every((term) => tokens.some((token) => token.startsWith(term)));
  });
}
