import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KDF_INTERACTIVE,
  Vault,
  generateDeviceSecret,
  type MemoryEntry,
} from '@northkeep/core';
import {
  acceptProposal,
  assembleReviewReport,
  forgetDuplicateMember,
  hasOllamaModel,
  keepDuplicateMember,
  loadReviewReport,
  parseReviewResponse,
  proposalFingerprint,
  rejectProposal,
  rejectRemaining,
  resolveReviewModel,
  reviewReportPath,
  runReviewPass,
  saveReviewReport,
  selectReviewEntries,
  validateProposals,
  type ReviewProposal,
} from '../src/index.js';

const PASSPHRASE = 'a strong test passphrase';

function mem(partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'content'>): MemoryEntry {
  return {
    type: 'semantic',
    scope: 'personal',
    source: 'test',
    source_model: null,
    confidence: 1,
    created_at: '2026-01-01T00:00:00.000Z',
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

/**
 * Shape mirrored from a live Ollama generateJson call on 2026-08-27 with
 * qwen2.5:14b (~18s, planted coffee-black pair, no real vault content).
 * The model returns {proposals:[{kind,entry_ids,quotes,explanation,
 * target_entry_id,proposed_content}]}. It sometimes truncates ids; those
 * are dropped as dead_id. This fixture uses full snapshot ids.
 */
const LIVE_14B_DUPLICATE_SHAPE = {
  proposals: [
    {
      kind: 'duplicate',
      entry_ids: [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb',
      ],
      quotes: [
        {
          entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          quote: 'Jay is a paramedic in Bourne.',
        },
        {
          entry_id: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb',
          quote: 'Jay works as a paramedic in Bourne.',
        },
      ],
      explanation:
        'Both entries describe the same behavior, with the second specifying a detail that does not contradict.',
      target_entry_id: null,
      proposed_content: null,
    },
  ],
};

function rawProposal(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'stale',
    entry_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    quotes: [{ entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quote: 'Jay is a paramedic' }],
    explanation: 'needs a date',
    target_entry_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    proposed_content: 'Jay is a paramedic (since 2010).',
    auto_apply: true,
    ...over,
  };
}

const ENTRY_A = mem({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  content: 'Jay is a paramedic in Bourne.',
});
const ENTRY_B = mem({
  id: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb',
  content: 'Jay works as a paramedic in Bourne.',
});
const ENTRY_C = mem({
  id: 'cccccccc-cccc-4ccc-accc-cccccccccccc',
  content: 'Jay lives in Dartmouth.',
});

describe('parseReviewResponse + validateProposals', () => {
  it('drops malformed JSON', () => {
    expect(parseReviewResponse('not json at all')).toBeNull();
    expect(parseReviewResponse('{"proposals":')).toBeNull();
  });

  it('parses BOM-prefixed valid JSON and drops BOM/whitespace-prefixed junk', () => {
    const ok = parseReviewResponse(`\uFEFF${JSON.stringify({ proposals: [] })}`);
    expect(ok).toEqual({ proposals: [] });
    expect(parseReviewResponse('\uFEFF   definitely junk')).toBeNull();
    expect(parseReviewResponse('\n\tnot-json')).toBeNull();
  });

  it('ignores auto_apply and other unknown fields', () => {
    const result = validateProposals({ proposals: [rawProposal({})], auto_apply: true }, [ENTRY_A]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).not.toHaveProperty('auto_apply');
    expect(result.proposals[0]!.kind).toBe('stale');
    expect(result.proposals[0]!.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('drops a fabricated quote, empty quote, and dead id', () => {
    const fabricated = validateProposals(
      { proposals: [rawProposal({ quotes: [{ entry_id: ENTRY_A.id, quote: 'not in the vault' }] })] },
      [ENTRY_A],
    );
    expect(fabricated.proposals).toHaveLength(0);
    expect(fabricated.drops.fabricated_quote).toBeGreaterThanOrEqual(1);

    const empty = validateProposals(
      { proposals: [rawProposal({ quotes: [{ entry_id: ENTRY_A.id, quote: '' }] })] },
      [ENTRY_A],
    );
    expect(empty.proposals).toHaveLength(0);
    expect(empty.drops.empty_quote).toBeGreaterThanOrEqual(1);

    const dead = validateProposals(
      {
        proposals: [
          rawProposal({
            entry_ids: ['dead0000-0000-0000-0000-000000000000'],
            quotes: [{ entry_id: 'dead0000-0000-0000-0000-000000000000', quote: 'Jay is a paramedic' }],
            target_entry_id: 'dead0000-0000-0000-0000-000000000000',
          }),
        ],
      },
      [ENTRY_A],
    );
    expect(dead.proposals).toHaveLength(0);
    expect(dead.drops.dead_id).toBeGreaterThanOrEqual(1);
  });

  it('drops a one-sided contradiction', () => {
    const result = validateProposals(
      {
        proposals: [
          {
            kind: 'contradiction',
            entry_ids: [ENTRY_A.id, ENTRY_C.id],
            quotes: [{ entry_id: ENTRY_A.id, quote: 'Jay is a paramedic' }],
            explanation: 'conflict',
            target_entry_id: ENTRY_A.id,
            proposed_content: 'corrected',
          },
        ],
      },
      [ENTRY_A, ENTRY_C],
    );
    expect(result.proposals).toHaveLength(0);
    expect(result.drops.one_sided_contradiction).toBeGreaterThanOrEqual(1);
  });

  it('keeps a duplicate cluster with two valid quotes; one bad quote drops the cluster', () => {
    const good = validateProposals(
      {
        proposals: [
          {
            kind: 'duplicate',
            entry_ids: [ENTRY_A.id, ENTRY_B.id],
            quotes: [
              { entry_id: ENTRY_A.id, quote: 'Jay is a paramedic' },
              { entry_id: ENTRY_B.id, quote: 'Jay works as a paramedic' },
            ],
            explanation: 'same fact',
          },
        ],
      },
      [ENTRY_A, ENTRY_B],
    );
    const fromLive = validateProposals(LIVE_14B_DUPLICATE_SHAPE, [ENTRY_A, ENTRY_B]);
    expect(fromLive.proposals).toHaveLength(1);
    expect(fromLive.proposals[0]!.kind).toBe('duplicate');
    expect(good.proposals).toHaveLength(1);
    expect(good.proposals[0]!.kind).toBe('duplicate');
    expect(good.proposals[0]!.member_decisions).toEqual({
      [ENTRY_A.id]: 'pending',
      [ENTRY_B.id]: 'pending',
    });

    const bad = validateProposals(
      {
        proposals: [
          {
            kind: 'duplicate',
            entry_ids: [ENTRY_A.id, ENTRY_B.id],
            quotes: [
              { entry_id: ENTRY_A.id, quote: 'Jay is a paramedic' },
              { entry_id: ENTRY_B.id, quote: 'this quote is invented' },
            ],
            explanation: 'same fact',
          },
        ],
      },
      [ENTRY_A, ENTRY_B],
    );
    expect(bad.proposals).toHaveLength(0);
  });

  it('handles every review kind in the exhaustive switch', () => {
    const kinds = ['duplicate', 'contradiction', 'undated', 'stale'] as const;
    const raw = kinds.map((kind) => {
      if (kind === 'duplicate') {
        return {
          kind,
          entry_ids: [ENTRY_A.id, ENTRY_B.id],
          quotes: [
            { entry_id: ENTRY_A.id, quote: 'paramedic' },
            { entry_id: ENTRY_B.id, quote: 'paramedic' },
          ],
          explanation: 'dup',
        };
      }
      if (kind === 'contradiction') {
        return {
          kind,
          entry_ids: [ENTRY_A.id, ENTRY_C.id],
          quotes: [
            { entry_id: ENTRY_A.id, quote: 'paramedic' },
            { entry_id: ENTRY_C.id, quote: 'Dartmouth' },
          ],
          explanation: 'conflict',
          target_entry_id: ENTRY_A.id,
          proposed_content: 'Jay is a paramedic who lives in Dartmouth.',
        };
      }
      return rawProposal({ kind, explanation: kind });
    });
    const result = validateProposals({ proposals: raw }, [ENTRY_A, ENTRY_B, ENTRY_C], {
      includeUndated: true,
    });
    expect(result.proposals.map((p) => p.kind).sort()).toEqual([...kinds].sort());
  });

  it('drops undated model output by default', () => {
    const dropped = validateProposals({ proposals: [rawProposal({ kind: 'undated' })] }, [ENTRY_A]);
    expect(dropped.proposals).toHaveLength(0);
    expect(dropped.drops.undated_disabled).toBe(1);

    const kept = validateProposals({ proposals: [rawProposal({ kind: 'undated' })] }, [ENTRY_A], {
      includeUndated: true,
    });
    expect(kept.proposals).toHaveLength(1);
    expect(kept.proposals[0]!.kind).toBe('undated');
  });
});

describe('selectReviewEntries', () => {
  it('drops project: scopes and keeps shared and personal', () => {
    const entries = [
      mem({ id: '11111111-1111-1111-1111-111111111111', content: 'personal fact', scope: 'personal' }),
      mem({ id: '22222222-2222-2222-2222-222222222222', content: 'shared fact', scope: 'work' }),
      mem({ id: '33333333-3333-3333-3333-333333333333', content: 'project doc', scope: 'project:foo' }),
    ];
    const kept = selectReviewEntries(entries);
    expect(kept.map((e) => e.scope)).toEqual(['personal', 'work']);
  });
});

describe('runReviewPass clustering and zero vault writes', () => {
  it('emits an exact-hash duplicate with zero generateJson calls', async () => {
    const a = mem({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'Jay is a paramedic.' });
    const b = mem({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'Jay is a paramedic.' });
    let calls = 0;
    const result = await runReviewPass([a, b], {
      generateJson: async () => {
        calls += 1;
        return '{"proposals":[]}';
      },
    });
    expect(calls).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.kind).toBe('duplicate');
    expect(result.proposals[0]!.quotes.map((q) => q.quote)).toEqual([a.content, b.content]);
  });

  it('does not call generateJson on a unique 40-entry vault', async () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      mem({
        id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
        content: `Unique fact number ${i} about something distinct.`,
      }),
    );
    let calls = 0;
    const result = await runReviewPass(entries, {
      generateJson: async () => {
        calls += 1;
        return '{"proposals":[]}';
      },
    });
    expect(calls).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.proposals).toHaveLength(0);
  });

  it('sends only a paraphrase pair to the model when fake embeddings are close', async () => {
    const extra = mem({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      content: 'Jay lives in Dartmouth.',
    });
    let calls = 0;
    let prompt = '';
    const close = new Float32Array([1, 0, 0]);
    const far = new Float32Array([0, 1, 0]);
    const result = await runReviewPass([ENTRY_A, ENTRY_B, extra], {
      generateJson: async (text) => {
        calls += 1;
        prompt = text;
        return '{"proposals":[]}';
      },
    }, {
      embed: async (content) => {
        if (content === ENTRY_A.content || content === ENTRY_B.content) return close;
        return far;
      },
    });
    expect(calls).toBe(1);
    expect(result.batches).toBe(1);
    expect(prompt).toContain(ENTRY_A.id);
    expect(prompt).toContain(ENTRY_B.id);
    expect(prompt).not.toContain(extra.id);
  });

  it('drops undated model output from a pack (undated_disabled)', async () => {
    const result = await runReviewPass([ENTRY_A, ENTRY_B], {
      generateJson: async () =>
        JSON.stringify({
          proposals: [rawProposal({ kind: 'undated', entry_ids: [ENTRY_A.id], quotes: [{ entry_id: ENTRY_A.id, quote: 'Jay is a paramedic' }] })],
        }),
    }, {
      embed: async () => new Float32Array([1, 0, 0]),
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.drops.undated_disabled).toBe(1);
  });

  it('does not write the vault during a run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-zw-'));
    const vault = Vault.create({
      path: path.join(dir, 'vault.nkv'),
      passphrase: PASSPHRASE,
      deviceSecret: generateDeviceSecret(),
      kdf: KDF_INTERACTIVE,
    });
    try {
      vault.remember({ content: 'Jay is a paramedic in Bourne.', type: 'semantic' });
      vault.save();
      const before = vault.export();
      const beforeHead = before.northkeep_export.chain_head;
      const beforeMemories = JSON.stringify(before.memories);
      const live = vault.list();
      await runReviewPass(live, {
        generateJson: async () =>
          JSON.stringify({
            proposals: [
              {
                kind: 'stale',
                entry_ids: [live[0]!.id],
                quotes: [{ entry_id: live[0]!.id, quote: 'Jay is a paramedic' }],
                explanation: 'maybe stale',
                target_entry_id: live[0]!.id,
                proposed_content: 'Jay is a paramedic in Bourne (as of 2026).',
              },
            ],
          }),
      });
      const after = vault.export();
      expect(after.northkeep_export.chain_head).toBe(beforeHead);
      expect(JSON.stringify(after.memories)).toBe(beforeMemories);
    } finally {
      vault.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review report store', () => {
  const prevHome = process.env.NORTHKEEP_HOME;
  let dir: string;

  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = prevHome;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-home-'));
    process.env.NORTHKEEP_HOME = dir;
    return dir;
  }

  it('writes 0600, records the schema version, and carries rejected fingerprints', () => {
    home();
    const proposal: ReviewProposal = {
      id: 'aabbccdd',
      kind: 'stale',
      entry_ids: [ENTRY_A.id],
      quotes: [{ entry_id: ENTRY_A.id, quote: 'Jay is a paramedic' }],
      explanation: 'old',
      target_entry_id: ENTRY_A.id,
      proposed_content: 'Jay is a paramedic (2026).',
      status: 'pending',
    };
    const first = assembleReviewReport({
      model: 'qwen2.5:14b',
      started_at: '2026-08-27T00:00:00.000Z',
      entry_count: 1,
      drops: {},
      proposals: [proposal],
      vault_id: '11111111-1111-4111-8111-111111111111',
      vault_path: reviewReportPath(),
      selected_scopes: ['personal'],
      source_entries: [ENTRY_A],
    });
    first.proposals[0]!.status = 'rejected';
    first.rejected_fingerprints.push(proposalFingerprint(proposal));
    saveReviewReport(first);
    expect(fs.statSync(reviewReportPath()).mode & 0o777).toBe(0o600);
    const loaded = loadReviewReport();
    expect(loaded?.schema).toBe('northkeep-review-report/2');

    const again = assembleReviewReport({
      model: 'qwen2.5:14b',
      started_at: '2026-08-27T01:00:00.000Z',
      entry_count: 1,
      drops: {},
      proposals: [{ ...proposal, id: 'eeff0011', status: 'pending' }],
      previous: loaded,
      vault_id: '11111111-1111-4111-8111-111111111111',
      vault_path: reviewReportPath(),
      selected_scopes: ['personal'],
      source_entries: [ENTRY_A],
    });
    expect(again.proposals).toHaveLength(0);
    expect(again.drops.rejected_fingerprint).toBe(1);
    expect(again.rejected_fingerprints).toContain(proposalFingerprint(proposal));
    expect(loaded?.sent_to).toBeUndefined();
  });

  it('changes fingerprint when quote text changes; different id sets do not collide', () => {
    const base: Pick<ReviewProposal, 'kind' | 'entry_ids' | 'proposed_content' | 'quotes'> = {
      kind: 'duplicate',
      entry_ids: [ENTRY_A.id, ENTRY_B.id],
      proposed_content: null,
      quotes: [
        { entry_id: ENTRY_A.id, quote: ENTRY_A.content },
        { entry_id: ENTRY_B.id, quote: ENTRY_B.content },
      ],
    };
    const editedQuote = {
      ...base,
      quotes: [
        { entry_id: ENTRY_A.id, quote: 'Jay is a paramedic' },
        { entry_id: ENTRY_B.id, quote: ENTRY_B.content },
      ],
    };
    const otherIds = {
      ...base,
      entry_ids: [ENTRY_A.id, ENTRY_C.id],
      quotes: [
        { entry_id: ENTRY_A.id, quote: ENTRY_A.content },
        { entry_id: ENTRY_C.id, quote: ENTRY_C.content },
      ],
    };
    expect(proposalFingerprint(base)).not.toBe(proposalFingerprint(editedQuote));
    expect(proposalFingerprint(base)).not.toBe(proposalFingerprint(otherIds));
    expect(proposalFingerprint(editedQuote)).not.toBe(proposalFingerprint(otherIds));
  });

  it('loads an old report that has no sent_to (local)', () => {
    home();
    const raw = {
      schema: 'northkeep-review-report/1',
      model: 'qwen2.5:14b',
      started_at: '2026-08-27T00:00:00.000Z',
      entry_count: 0,
      drops: {},
      proposals: [],
      rejected_fingerprints: [],
    };
    fs.writeFileSync(reviewReportPath(), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const loaded = loadReviewReport();
    expect(loaded).not.toBeNull();
    expect(loaded?.sent_to).toBeUndefined();
    expect(loaded?.model).toBe('qwen2.5:14b');
  });

  it('saves and reloads sent_to on an API report', () => {
    home();
    const report = assembleReviewReport({
      model: 'gpt-4o-mini',
      started_at: '2026-08-27T00:00:00.000Z',
      entry_count: 2,
      drops: {},
      proposals: [],
      sent_to: { label: 'OpenAI', host: 'api.openai.com' },
      vault_id: '11111111-1111-4111-8111-111111111111',
      vault_path: reviewReportPath(),
      selected_scopes: ['personal'],
      source_entries: [ENTRY_A, ENTRY_B],
    });
    expect(report.sent_to).toEqual({ label: 'OpenAI', host: 'api.openai.com' });
    saveReviewReport(report);
    const loaded = loadReviewReport();
    expect(loaded?.sent_to).toEqual({ label: 'OpenAI', host: 'api.openai.com' });
    expect(loaded?.model).toBe('gpt-4o-mini');
  });

  it('leaves an existing report untouched when resolveReviewModel refuses', async () => {
    home();
    saveReviewReport({
      schema: 'northkeep-review-report/1',
      model: 'qwen2.5:14b',
      started_at: '2026-08-27T00:00:00.000Z',
      entry_count: 0,
      drops: {},
      proposals: [],
      rejected_fingerprints: ['a'.repeat(64)],
    });
    const before = fs.readFileSync(reviewReportPath(), 'utf8');
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const prevUrl = process.env.NORTHKEEP_OLLAMA_URL;
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    try {
      await expect(resolveReviewModel()).rejects.toThrow(/qwen2.5:14b/);
      expect(fs.readFileSync(reviewReportPath(), 'utf8')).toBe(before);
    } finally {
      if (prevUrl === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
      else process.env.NORTHKEEP_OLLAMA_URL = prevUrl;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('apply helpers', () => {
  function openVault(): { vault: Vault; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-apply-'));
    const vault = Vault.create({
      path: path.join(dir, 'vault.nkv'),
      passphrase: PASSPHRASE,
      deviceSecret: generateDeviceSecret(),
      kdf: KDF_INTERACTIVE,
    });
    return { vault, dir };
  }

  it('accept supersedes and keeps the old row; reject leaves the vault untouched', () => {
    const { vault, dir } = openVault();
    try {
      const live = vault.remember({ content: 'Jay is a paramedic in Bourne.', type: 'semantic' });
      const report = assembleReviewReport({
        model: 'fixture',
        started_at: '2026-08-27T00:00:00.000Z',
        entry_count: 1,
        drops: {},
        proposals: [
          {
            id: 'ace00001',
            kind: 'stale',
            entry_ids: [live.id],
            quotes: [{ entry_id: live.id, quote: 'Jay is a paramedic' }],
            explanation: 'add year',
            target_entry_id: live.id,
            proposed_content: 'Jay is a paramedic in Bourne (as of 2026).',
            status: 'pending',
          },
          {
            id: 'bee00002',
            kind: 'undated',
            entry_ids: [live.id],
            quotes: [{ entry_id: live.id, quote: 'Bourne' }],
            explanation: 'date',
            target_entry_id: live.id,
            proposed_content: 'dated',
            status: 'pending',
          },
        ],
        vault_id: vault.getVaultId(),
        vault_path: path.join(dir, 'vault.nkv'),
        selected_scopes: ['personal'],
        source_entries: [live],
      });
      const beforeExport = JSON.stringify(vault.export().memories);
      rejectProposal(report, 'bee00002');
      expect(JSON.stringify(vault.export().memories)).toBe(beforeExport);
      expect(report.proposals.find((p) => p.id === 'bee00002')!.status).toBe('rejected');

      expect(() => acceptProposal(vault, report, 'ace00001')).toThrow(/Use applyReviewAction/);
      expect(vault.list()[0]!.content).toBe('Jay is a paramedic in Bourne.');
    } finally {
      vault.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keep is a vault no-op; forget tombstones only that member and does not call the model', () => {
    const { vault, dir } = openVault();
    try {
      const a = vault.remember({ content: 'Jay is a paramedic in Bourne.', type: 'semantic' });
      const b = vault.remember({ content: 'Jay works as a paramedic in Bourne.', type: 'semantic' });
      const report = assembleReviewReport({
        model: 'fixture',
        started_at: '2026-08-27T00:00:00.000Z',
        entry_count: 2,
        drops: {},
        proposals: [
          {
            id: 'd0a00001',
            kind: 'duplicate',
            entry_ids: [a.id, b.id],
            quotes: [
              { entry_id: a.id, quote: 'Jay is a paramedic' },
              { entry_id: b.id, quote: 'Jay works as a paramedic' },
            ],
            explanation: 'same job',
            target_entry_id: null,
            proposed_content: null,
            member_decisions: { [a.id]: 'pending', [b.id]: 'pending' },
            status: 'pending',
          },
        ],
        vault_id: vault.getVaultId(),
        vault_path: path.join(dir, 'vault.nkv'),
        selected_scopes: ['personal'],
        source_entries: [a, b],
      });
      const before = JSON.stringify(vault.export().memories);
      keepDuplicateMember(report, 'd0a00001', a.id);
      expect(JSON.stringify(vault.export().memories)).toBe(before);
      expect(report.proposals[0]!.member_decisions![a.id]).toBe('kept');

      expect(() => forgetDuplicateMember(vault, report, 'd0a00001', b.id)).toThrow(/Use applyReviewAction/);
      const unchanged = vault.list().find((e) => e.id === b.id)!;
      expect(unchanged.forgotten_at).toBeNull();
      expect(unchanged.content).toBe('Jay works as a paramedic in Bourne.');
      const other = vault.list().find((e) => e.id === a.id)!;
      expect(other.content).toBe('Jay is a paramedic in Bourne.');
      expect(other.forgotten_at).toBeNull();
      expect(report.proposals[0]!.member_decisions![b.id]).toBe('pending');
      expect(report.proposals[0]!.status).toBe('pending');
    } finally {
      vault.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses accept on a duplicate and keep on a non-duplicate', () => {
    const { vault, dir } = openVault();
    try {
      const a = vault.remember({ content: 'Jay is a paramedic in Bourne.', type: 'semantic' });
      const b = vault.remember({ content: 'Jay works as a paramedic in Bourne.', type: 'semantic' });
      const report = assembleReviewReport({
        model: 'fixture',
        started_at: '2026-08-27T00:00:00.000Z',
        entry_count: 2,
        drops: {},
        proposals: [
          {
            id: 'd0a00002',
            kind: 'duplicate',
            entry_ids: [a.id, b.id],
            quotes: [
              { entry_id: a.id, quote: 'paramedic' },
              { entry_id: b.id, quote: 'paramedic' },
            ],
            explanation: 'same',
            target_entry_id: null,
            proposed_content: null,
            member_decisions: { [a.id]: 'pending', [b.id]: 'pending' },
            status: 'pending',
          },
          {
            id: '5aa00003',
            kind: 'stale',
            entry_ids: [a.id],
            quotes: [{ entry_id: a.id, quote: 'paramedic' }],
            explanation: 'old',
            target_entry_id: a.id,
            proposed_content: 'updated',
            status: 'pending',
          },
        ],
        vault_id: vault.getVaultId(),
        vault_path: path.join(dir, 'vault.nkv'),
        selected_scopes: ['personal'],
        source_entries: [a, b],
      });
      expect(() => acceptProposal(vault, report, 'd0a00002')).toThrow(/Use applyReviewAction/);
      expect(() => keepDuplicateMember(report, '5aa00003', a.id)).toThrow(/Cannot keep a stale/);
    } finally {
      vault.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejectProposal on a duplicate keeps every member; rejectRemaining leaves memories byte-identical', () => {
    const { vault, dir } = openVault();
    try {
      const a = vault.remember({ content: 'Jay is a paramedic in Bourne.', type: 'semantic' });
      const b = vault.remember({ content: 'Jay is a paramedic in Bourne!', type: 'semantic' });
      const c = vault.remember({ content: 'Jay lives in Dartmouth.', type: 'semantic' });
      const report = assembleReviewReport({
        model: 'fixture',
        started_at: '2026-09-09T00:00:00.000Z',
        entry_count: 3,
        drops: {},
        proposals: [
          {
            id: 'd0a00009',
            kind: 'duplicate',
            entry_ids: [a.id, b.id],
            quotes: [
              { entry_id: a.id, quote: a.content },
              { entry_id: b.id, quote: b.content },
            ],
            explanation: 'exact',
            target_entry_id: null,
            proposed_content: null,
            member_decisions: { [a.id]: 'pending', [b.id]: 'pending' },
            status: 'pending',
          },
          {
            id: '5aa00009',
            kind: 'stale',
            entry_ids: [c.id],
            quotes: [{ entry_id: c.id, quote: 'Dartmouth' }],
            explanation: 'old',
            target_entry_id: c.id,
            proposed_content: 'Jay lives in Dartmouth (2026).',
            status: 'pending',
          },
        ],
        vault_id: vault.getVaultId(),
        vault_path: path.join(dir, 'vault.nkv'),
        selected_scopes: ['personal'],
        source_entries: [a, b, c],
      });
      const before = JSON.stringify(vault.export().memories);
      rejectProposal(report, 'd0a00009');
      expect(JSON.stringify(vault.export().memories)).toBe(before);
      expect(vault.list().map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
      expect(report.proposals.find((p) => p.id === 'd0a00009')!.status).toBe('rejected');

      const n = rejectRemaining(report);
      expect(n).toBe(1);
      const after = vault.export();
      expect(JSON.stringify(after.memories)).toBe(before);
      expect(report.proposals.every((p) => p.status === 'rejected')).toBe(true);
    } finally {
      vault.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hasOllamaModel + resolveReviewModel', () => {
  const prevUrl = process.env.NORTHKEEP_OLLAMA_URL;
  const prevOverride = process.env.NORTHKEEP_REVIEW_MODEL;

  afterEach(() => {
    if (prevUrl === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
    else process.env.NORTHKEEP_OLLAMA_URL = prevUrl;
    if (prevOverride === undefined) delete process.env.NORTHKEEP_REVIEW_MODEL;
    else process.env.NORTHKEEP_REVIEW_MODEL = prevOverride;
  });

  async function tagsServer(names: string[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: names.map((name) => ({ name })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('accepts the implicit :latest form of a bare tag, exact tags stay exact', async () => {
    // Ollama 0.31 reports an untagged pull as "nomic-embed-text:latest"; the
    // review pass used to read that as "model missing" and skip every memory.
    const server = await tagsServer(['nomic-embed-text:latest', 'qwen2.5:14b']);
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    try {
      expect(await hasOllamaModel('nomic-embed-text')).toBe(true);
      expect(await hasOllamaModel('nomic-embed-text:latest')).toBe(true);
      expect(await hasOllamaModel('nomic-embed-text:v2')).toBe(false);
      expect(await hasOllamaModel('qwen2.5')).toBe(false);
      expect(await hasOllamaModel('qwen2.5:7b')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('picks 14b when present, 7b when only 7b, throws when neither', async () => {
    const both = await tagsServer(['qwen2.5:14b', 'qwen2.5:7b']);
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${both.port}`;
    delete process.env.NORTHKEEP_REVIEW_MODEL;
    try {
      expect(await hasOllamaModel('qwen2.5:14b')).toBe(true);
      expect(await resolveReviewModel()).toBe('qwen2.5:14b');
    } finally {
      await both.close();
    }

    const only7 = await tagsServer(['qwen2.5:7b']);
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${only7.port}`;
    try {
      expect(await resolveReviewModel()).toBe('qwen2.5:7b');
    } finally {
      await only7.close();
    }

    const neither = await tagsServer(['llama3.2:3b']);
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${neither.port}`;
    try {
      await expect(resolveReviewModel()).rejects.toThrow(/qwen2.5:14b/);
      await expect(resolveReviewModel()).rejects.toThrow(/qwen2.5:7b/);
      await expect(resolveReviewModel()).rejects.toThrow(/brew services start ollama/);
    } finally {
      await neither.close();
    }
  });

  it('when NORTHKEEP_REVIEW_MODEL is set and missing, throws without hopping to 7b', async () => {
    const only7 = await tagsServer(['qwen2.5:7b']);
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${only7.port}`;
    process.env.NORTHKEEP_REVIEW_MODEL = 'custom-review:tag';
    try {
      await expect(resolveReviewModel()).rejects.toThrow(/custom-review:tag/);
    } finally {
      await only7.close();
    }
  });
});
