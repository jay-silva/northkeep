import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@northkeep/core';
import {
  clusterReviewEntries,
  makeExactDuplicateProposal,
  normalizeReviewText,
  reviewContentHash,
  splitReviewPack,
  tokenizeReview,
} from '../src/reviewCluster.js';

function mem(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'content'>): MemoryEntry {
  return {
    type: 'semantic',
    scope: 'personal',
    source: 'test',
    source_model: null,
    confidence: 1,
    created_at: '2026-01-01T00:00:00Z',
    valid_from: null,
    superseded_at: null,
    superseded_by: null,
    forgotten_at: null,
    prev_hash: '0'.repeat(64),
    entry_hash: '0'.repeat(64),
    metadata: null,
    ...partial,
  };
}

describe('normalizeReviewText + reviewContentHash', () => {
  it('preserves punctuation, case, symbols, decimals, and internal whitespace', () => {
    const a = reviewContentHash('Jay is a paramedic.');
    const b = reviewContentHash('jay  is a  PARAMEDIC!');
    expect(a).not.toBe(b);
    expect(reviewContentHash('$12.50')).not.toBe(reviewContentHash('1250'));
    expect(normalizeReviewText('Jay is a paramedic.')).toBe('Jay is a paramedic.');
  });

  it('does not Unicode-normalize distinct byte sequences', () => {
    const nfc = reviewContentHash('café');
    const nfd = reviewContentHash('cafe\u0301');
    expect(nfc).not.toBe(nfd);
  });

  it('preserves BOM and canonicalizes only CRLF line endings', () => {
    expect(reviewContentHash('\uFEFFJay drinks coffee')).not.toBe(reviewContentHash('Jay drinks coffee'));
    expect(reviewContentHash('one\r\ntwo')).toBe(reviewContentHash('one\ntwo'));
  });

  it('does not hash-collide a Cyrillic homoglyph with ASCII', () => {
    // Cyrillic а (U+0430), not Latin a.
    const homoglyph = reviewContentHash('Jаy');
    const ascii = reviewContentHash('Jay');
    expect(homoglyph).not.toBe(ascii);
  });

  it('keeps "14 units" and "15 units" as distinct hashes', () => {
    expect(reviewContentHash('14 units')).not.toBe(reviewContentHash('15 units'));
    expect(tokenizeReview('14 units').has('14')).toBe(true);
    expect(tokenizeReview('15 units').has('15')).toBe(true);
  });

  it('does not exact-hash a paramedic paraphrase', () => {
    expect(reviewContentHash('Jay is a paramedic in Bourne.')).not.toBe(
      reviewContentHash('Jay works as a paramedic in Bourne.'),
    );
  });
});

describe('clusterReviewEntries', () => {
  it('returns no clusters for an empty or singleton vault', () => {
    expect(clusterReviewEntries([])).toEqual([]);
    expect(
      clusterReviewEntries([mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'only one' })]),
    ).toEqual([]);
  });

  it('emits an exact cluster only for strict same-scope and same-type matches', () => {
    const a = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'Jay is a paramedic.' });
    const b = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'Jay is a paramedic.' });
    const otherScope = mem({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', content: a.content, scope: 'work' });
    const otherType = mem({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', content: a.content, type: 'episodic' });
    const clusters = clusterReviewEntries([a, b, otherScope, otherType]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.kind).toBe('exact');
    expect(clusters[0]!.members.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('does not cosine-pack entries across scope or type boundaries', () => {
    const a = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'A', scope: 'personal' });
    const b = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'B', scope: 'work' });
    const c = mem({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', content: 'C', type: 'episodic' });
    const vec = new Float32Array([1, 0]);
    expect(clusterReviewEntries([a, b, c], new Map([[a.id, vec], [b.id, vec], [c.id, vec]]))).toEqual([]);
  });

  it('packs close embeddings as candidate and does not emit them as duplicates', () => {
    const a = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'Jay is a paramedic in Bourne.' });
    const b = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'Jay works as a paramedic in Bourne.' });
    const vec = new Float32Array([1, 0, 0]);
    const clusters = clusterReviewEntries(
      [a, b],
      new Map([
        [a.id, vec],
        [b.id, vec],
      ]),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.kind).toBe('candidate');
    expect(clusters[0]!.members.map((e) => e.id)).toEqual([a.id, b.id]);
  });
});

describe('splitReviewPack', () => {
  it('keeps a boundary pair together with one-member overlap', () => {
    const members = Array.from({ length: 9 }, (_, i) =>
      mem({
        id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
        content: `item ${i}`,
      }),
    );
    const { packs, splitCount } = splitReviewPack(members, 8, 12_000);
    expect(splitCount).toBe(1);
    expect(packs).toHaveLength(2);
    expect(packs[0]!.map((e) => e.content)).toEqual(members.slice(0, 8).map((e) => e.content));
    expect(packs[1]!.map((e) => e.id)).toEqual([members[7]!.id, members[8]!.id]);
  });

  it('skips an entry that cannot fit in a bounded pack', () => {
    const huge = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'x'.repeat(21) });
    const small = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'small' });
    const result = splitReviewPack([huge, small], 8, 20);
    expect(result.skipped.map((entry) => entry.id)).toEqual([huge.id]);
    expect(result.packs).toEqual([[small]]);
  });

  it('drops overlap when overlap plus the next entry would exceed the character cap', () => {
    const a = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'a'.repeat(7_000) });
    const b = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'b'.repeat(7_000) });
    const result = splitReviewPack([a, b], 8, 12_000);
    expect(result.packs.map((pack) => pack.map((entry) => entry.id))).toEqual([[a.id], [b.id]]);
    expect(result.packs.every((pack) => pack.reduce((sum, entry) => sum + entry.content.length, 0) <= 12_000)).toBe(true);
  });
});

describe('makeExactDuplicateProposal', () => {
  it('quotes each member full content and leaves proposed_content null', () => {
    const a = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'Jay is a paramedic.' });
    const b = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'Jay is a paramedic.' });
    const p = makeExactDuplicateProposal([a, b]);
    expect(p.kind).toBe('duplicate');
    expect(p.status).toBe('pending');
    expect(p.proposed_content).toBeNull();
    expect(p.quotes.map((q) => q.quote)).toEqual([a.content, b.content]);
    expect(p.member_decisions).toEqual({ [a.id]: 'pending', [b.id]: 'pending' });
    expect(p.id).toMatch(/^[0-9a-f]{8}$/);
  });
});
