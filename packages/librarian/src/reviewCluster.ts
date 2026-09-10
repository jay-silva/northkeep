/**
 * Cluster-first review packing (ADR 0043 P9). Pure: no I/O, no vault writes.
 * Exact hash emits duplicates. Cosine only packs candidates for the model.
 */
import { createHash } from 'node:crypto';
import { cosineSimilarity, type MemoryEntry } from '@northkeep/core';
import { finishProposal, type MemberDecision, type ReviewProposal } from './reviewSchema.js';

const COSINE_CANDIDATE = 0.9;
const COSINE_RELATED_FLOOR = 0.78;
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_CHARS = 12_000;

export type ReviewClusterKind = 'exact' | 'candidate' | 'related';

export interface ReviewCluster {
  kind: ReviewClusterKind;
  members: MemoryEntry[];
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'was', 'were', 'are', 'is', 'been', 'being', 'they', 'their', 'them',
  'user', 'users', 'about', 'when', 'what', 'which', 'would', 'could',
  'should', 'will', 'can', 'not', 'but', 'his', 'her', 'its', 'also', 'into',
  'than', 'then', 'there', 'these', 'those', 'some', 'very', 'just', 'like',
  'likes', 'prefers', 'wants', 'needs',
]);

/** Exact-review canonicalization permits line-ending portability only. */
export function normalizeReviewText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function reviewContentHash(text: string): string {
  return createHash('sha256').update(normalizeReviewText(text)).digest('hex');
}

/**
 * Like import tokenize, but 1–2 digit numbers stay as tokens so "14 units"
 * and "15 units" do not collide. Do not reuse dedupe.ts tokenize here.
 */
export function tokenizeReview(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase().normalize('NFC');
  for (const match of normalized.matchAll(/[a-z0-9]{3,}|\d{1,2}/g)) {
    if (!STOPWORDS.has(match[0])) tokens.add(match[0]);
  }
  return tokens;
}

export function clusterReviewEntries(
  entries: MemoryEntry[],
  embeddings?: Map<string, Float32Array>,
): ReviewCluster[] {
  const byHash = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const hash = `${entry.scope}\0${entry.type}\0${reviewContentHash(entry.content)}`;
    const group = byHash.get(hash);
    if (group) group.push(entry);
    else byHash.set(hash, [entry]);
  }

  const clusters: ReviewCluster[] = [];
  const remaining: MemoryEntry[] = [];
  for (const group of byHash.values()) {
    if (group.length >= 2) clusters.push({ kind: 'exact', members: group });
    else remaining.push(group[0]!);
  }

  if (embeddings === undefined || remaining.length < 2) return clusters;

  const parent = remaining.map((_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]!);
    return parent[i]!;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < remaining.length; i += 1) {
    const va = embeddings.get(remaining[i]!.id);
    if (va === undefined) continue;
    for (let j = i + 1; j < remaining.length; j += 1) {
      if (
        remaining[i]!.scope !== remaining[j]!.scope ||
        remaining[i]!.type !== remaining[j]!.type
      ) continue;
      const vb = embeddings.get(remaining[j]!.id);
      if (vb === undefined) continue;
      if (cosineSimilarity(va, vb) >= COSINE_RELATED_FLOOR) union(i, j);
    }
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < remaining.length; i += 1) {
    const root = find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  }

  for (const indexes of components.values()) {
    if (indexes.length < 2) continue;
    let maxCos = 0;
    for (let a = 0; a < indexes.length; a += 1) {
      const va = embeddings.get(remaining[indexes[a]!]!.id);
      if (va === undefined) continue;
      for (let b = a + 1; b < indexes.length; b += 1) {
        const vb = embeddings.get(remaining[indexes[b]!]!.id);
        if (vb === undefined) continue;
        const cos = cosineSimilarity(va, vb);
        if (cos > maxCos) maxCos = cos;
      }
    }
    const kind: ReviewClusterKind = maxCos >= COSINE_CANDIDATE ? 'candidate' : 'related';
    clusters.push({ kind, members: indexes.map((i) => remaining[i]!) });
  }

  return clusters;
}

/**
 * Split an oversized pack with one-member overlap so a boundary pair stays
 * together in the next pack.
 */
export function splitReviewPack(
  members: MemoryEntry[],
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxChars = DEFAULT_MAX_CHARS,
): { packs: MemoryEntry[][]; splitCount: number; skipped: MemoryEntry[] } {
  if (members.length === 0) return { packs: [], splitCount: 0, skipped: [] };

  const packs: MemoryEntry[][] = [];
  const skipped: MemoryEntry[] = [];
  let current: MemoryEntry[] = [];
  let chars = 0;

  for (const entry of members) {
    const size = entry.content.length;
    if (size > maxChars) {
      skipped.push(entry);
      continue;
    }
    const wouldExceed =
      current.length > 0 && (current.length >= maxEntries || chars + size > maxChars);
    if (wouldExceed) {
      packs.push(current);
      const overlap = current[current.length - 1]!;
      if (overlap.content.length + size <= maxChars && maxEntries >= 2) {
        current = [overlap, entry];
        chars = overlap.content.length + size;
      } else {
        current = [entry];
        chars = size;
      }
    } else {
      current.push(entry);
      chars += size;
    }
  }
  if (current.length > 0) packs.push(current);
  return { packs, splitCount: Math.max(0, packs.length - 1), skipped };
}

export function makeExactDuplicateProposal(
  members: MemoryEntry[],
  usedIds: Set<string> = new Set(),
): ReviewProposal {
  const entry_ids = members.map((e) => e.id);
  const quotes = members.map((e) => ({ entry_id: e.id, quote: e.content }));
  const member_decisions: Record<string, MemberDecision> = {};
  for (const id of entry_ids) member_decisions[id] = 'pending';
  return finishProposal(usedIds, {
    kind: 'duplicate',
    entry_ids,
    quotes,
    explanation: 'Exact match (with CRLF line endings treated as LF).',
    target_entry_id: null,
    proposed_content: null,
    member_decisions,
    status: 'pending',
  });
}
