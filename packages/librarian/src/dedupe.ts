import type { MemoryEntry } from '@northkeep/core';
import type { MemoryCandidate } from '@northkeep/importers';

/**
 * Lexical near-duplicate detection (token Jaccard). Deliberately simple:
 * catches "I take my coffee black" showing up in forty conversations.
 * Semantic (embedding) dedupe arrives with semantic retrieval.
 */
const DUPLICATE_THRESHOLD = 0.6;
const RELATED_THRESHOLD = 0.35;

export interface DedupeResult {
  unique: MemoryCandidate[];
  duplicatesDropped: number;
  /** Candidate pairs (or candidate/existing pairs) that look related but not
   * identical — possible contradictions, surfaced for the user, never
   * auto-resolved. */
  conflicts: Array<{ candidate: string; existing: string }>;
}

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().normalize('NFC').matchAll(/[a-z0-9]{3,}/g)) {
    if (!STOPWORDS.has(match[0])) tokens.add(match[0]);
  }
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function dedupeCandidates(
  candidates: MemoryCandidate[],
  existing: MemoryEntry[],
): DedupeResult {
  const existingTokens = existing
    .filter((e) => e.forgotten_at === null)
    .map((e) => ({ content: e.content, tokens: tokenize(e.content) }));
  const kept: Array<{ candidate: MemoryCandidate; tokens: Set<string> }> = [];
  const conflicts: DedupeResult['conflicts'] = [];
  let duplicatesDropped = 0;

  for (const candidate of candidates) {
    const tokens = tokenize(candidate.content);
    let duplicate = false;
    for (const prior of kept) {
      const similarity = jaccard(tokens, prior.tokens);
      if (similarity >= DUPLICATE_THRESHOLD) {
        duplicate = true;
        // Keep the higher-confidence phrasing of the same fact.
        if (candidate.confidence > prior.candidate.confidence) {
          prior.candidate = candidate;
          prior.tokens = tokens;
        }
        break;
      }
    }
    if (duplicate) {
      duplicatesDropped += 1;
      continue;
    }
    for (const entry of existingTokens) {
      const similarity = jaccard(tokens, entry.tokens);
      if (similarity >= DUPLICATE_THRESHOLD) {
        duplicate = true;
        break;
      }
      if (similarity >= RELATED_THRESHOLD) {
        conflicts.push({ candidate: candidate.content, existing: entry.content });
      }
    }
    if (duplicate) {
      duplicatesDropped += 1;
      continue;
    }
    kept.push({ candidate, tokens });
  }
  return { unique: kept.map((k) => k.candidate), duplicatesDropped, conflicts };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'was', 'were', 'are', 'is', 'been', 'being', 'they', 'their', 'them',
  'user', 'users', 'about', 'when', 'what', 'which', 'would', 'could',
  'should', 'will', 'can', 'not', 'but', 'his', 'her', 'its', 'also', 'into',
  'than', 'then', 'there', 'these', 'those', 'some', 'very', 'just', 'like',
  'likes', 'prefers', 'wants', 'needs',
]);
