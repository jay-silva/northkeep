import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@northkeep/core';
import { runReviewPass } from '../src/review.js';
import { validateProposals } from '../src/reviewSchema.js';

function mem(id: string, content: string, partial: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id, content, type: 'semantic', scope: 'personal', source: 'test', source_model: null,
    confidence: 1, created_at: '2026-01-01T00:00:00Z', valid_from: null,
    superseded_at: null, superseded_by: null, forgotten_at: null,
    prev_hash: '0'.repeat(64), entry_hash: '0'.repeat(64), metadata: null, ...partial,
  };
}

const A = mem('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'The property has 8 units.');
const B = mem('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'The property has 8 units.');
const C = mem('cccccccc-cccc-cccc-cccc-cccccccccccc', 'The property now has 6 units.', {
  created_at: '2026-02-01T00:00:00Z',
});

describe('review quality boundaries', () => {
  it('includes an exact-group representative in semantic review with a newer contradiction', async () => {
    let prompt = '';
    const result = await runReviewPass([A, B, C], {
      generateJson: async (value) => { prompt = value; return '{"proposals":[]}'; },
    }, { embed: async () => new Float32Array([1, 0]) });
    expect(result.proposals.some((proposal) => proposal.kind === 'duplicate')).toBe(true);
    expect(prompt).toContain(A.id);
    expect(prompt).toContain(C.id);
    expect(result.coverage).toEqual({ selected: 3, compared: 3, skipped: 0, failed: 0, complete: true });
  });

  it('reports unavailable semantic coverage instead of claiming completeness', async () => {
    const result = await runReviewPass([A, mem('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Unrelated')], {
      generateJson: async () => '{"proposals":[]}',
    });
    expect(result.coverage).toEqual({ selected: 2, compared: 0, skipped: 2, failed: 0, complete: false });
    expect(result.drops.embedding_unavailable).toBe(2);
  });

  it('does not claim complete semantic coverage for exact-only entries without embeddings', async () => {
    const result = await runReviewPass([A, B], { generateJson: async () => '{"proposals":[]}' });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.failed).toBe(1);
    expect(result.drops.semantic_unavailable).toBe(1);
  });

  it('counts embedding failures and leaves coverage incomplete', async () => {
    const result = await runReviewPass([A, C], { generateJson: async () => '{"proposals":[]}' }, {
      embed: async (content) => {
        if (content === C.content) throw new Error('unavailable');
        return new Float32Array([1, 0]);
      },
    });
    expect(result.coverage).toEqual({ selected: 2, compared: 1, skipped: 0, failed: 1, complete: false });
  });

  it('rejects invalid embedding vectors and mismatched dimensions', async () => {
    const zero = await runReviewPass([A], { generateJson: async () => '{"proposals":[]}' }, {
      embed: async () => new Float32Array([0, 0]),
    });
    expect(zero.coverage).toMatchObject({ compared: 0, failed: 1, complete: false });

    const mismatch = await runReviewPass([A, C], { generateJson: async () => '{"proposals":[]}' }, {
      embed: async (content) => content === A.content ? new Float32Array([1, 0]) : new Float32Array([1]),
    });
    expect(mismatch.coverage).toMatchObject({ compared: 1, failed: 1, complete: false });
  });

  it('skips an oversized singleton before embedding', async () => {
    let embedCalls = 0;
    const huge = mem('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'x'.repeat(12_001));
    const result = await runReviewPass([huge], { generateJson: async () => '{"proposals":[]}' }, {
      embed: async () => { embedCalls += 1; return new Float32Array([1]); },
    });
    expect(embedCalls).toBe(0);
    expect(result.coverage).toEqual({ selected: 1, compared: 0, skipped: 1, failed: 0, complete: false });
  });

  it('marks a batch incomplete when model findings fail validation', async () => {
    const result = await runReviewPass([A, C], {
      generateJson: async () => JSON.stringify({ proposals: [{
        kind: 'stale', entry_ids: [A.id, C.id], quotes: [{ entry_id: A.id, quote: 'not present' }],
        explanation: 'bad', target_entry_id: A.id, proposed_content: 'replacement',
      }] }),
    }, { embed: async () => new Float32Array([1, 0]) });
    expect(result.coverage).toEqual({ selected: 2, compared: 0, skipped: 0, failed: 2, complete: false });
    expect(result.drops.fabricated_quote).toBe(1);
  });

  it('rejects a replacement without a target-specific quote or listed target', () => {
    const base = {
      kind: 'stale', entry_ids: [A.id], quotes: [{ entry_id: A.id, quote: '8 units' }],
      explanation: 'newer', target_entry_id: C.id, proposed_content: 'Updated.',
    };
    expect(validateProposals({ proposals: [base] }, [A, C]).drops.target_not_listed).toBe(1);
    const listed = { ...base, entry_ids: [A.id, C.id] };
    expect(validateProposals({ proposals: [listed] }, [A, C]).drops.missing_target_quote).toBe(1);
  });

  it('keeps an unresolved question without forced replacement content', () => {
    const result = validateProposals({ proposals: [{
      kind: 'question', entry_ids: [A.id, C.id],
      quotes: [{ entry_id: A.id, quote: '8 units' }, { entry_id: C.id, quote: '6 units' }],
      explanation: 'These disagree.', target_entry_id: null, proposed_content: null,
      question: 'How many units should this memory say?',
    }] }, [A, C]);
    expect(result.proposals[0]).toMatchObject({ kind: 'question', target_entry_id: null, proposed_content: null });
    expect(result.proposals[0]!.question).toBe('How many units should this memory say?');
  });

  it('rejects a question about only one cited memory', () => {
    const result = validateProposals({ proposals: [{
      kind: 'question', entry_ids: [A.id], quotes: [{ entry_id: A.id, quote: '8 units' }],
      explanation: 'Unclear.', target_entry_id: null, proposed_content: null,
      question: 'Is this still correct?',
    }] }, [A]);
    expect(result.proposals).toEqual([]);
    expect(result.drops.insufficient_question_members).toBe(1);
  });

  it('marks split semantic components incomplete even when every batch succeeds', async () => {
    const entries = Array.from({ length: 9 }, (_, index) =>
      mem(`${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`, `fact ${index}`),
    );
    const result = await runReviewPass(entries, { generateJson: async () => '{"proposals":[]}' }, {
      embed: async () => new Float32Array([1, 0]),
    });
    expect(result.batches).toBe(2);
    expect(result.coverage).toMatchObject({ selected: 9, compared: 0, skipped: 0, failed: 9, complete: false });
    expect(result.drops.pack_split_gap).toBe(1);
  });

  it('does not count disconnected singleton packs as compared', async () => {
    const first = mem('11111111-1111-1111-1111-111111111111', 'a'.repeat(7_000));
    const second = mem('22222222-2222-2222-2222-222222222222', 'b'.repeat(7_000));
    const result = await runReviewPass([first, second], {
      generateJson: async () => '{"proposals":[]}',
    }, { embed: async () => new Float32Array([1, 0]) });
    expect(result.batches).toBe(2);
    expect(result.coverage).toEqual({ selected: 2, compared: 0, skipped: 0, failed: 2, complete: false });
  });
});
