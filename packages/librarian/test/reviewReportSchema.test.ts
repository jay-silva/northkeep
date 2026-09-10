import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { recordReviewDecision } from '../src/reviewSession.js';
import {
  assembleReviewReport,
  loadReviewReport,
  reviewReportPath,
  saveReviewReport,
  proposalFingerprint,
  type ReviewReport,
  type ReviewSnapshot,
} from '../src/reviewReport.js';

const vaultPath = '/private/tmp/nk-report-tests/synthetic.nkv';

function entry(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    id: randomUUID(),
    type: 'semantic',
    content: 'Synthetic memory content.',
    scope: 'personal',
    source: 'test',
    source_model: null,
    confidence: 1,
    created_at: '2026-09-07T12:00:00.000Z',
    valid_from: null,
    superseded_at: null,
    superseded_by: null,
    forgotten_at: null,
    prev_hash: '0'.repeat(64),
    entry_hash: '1'.repeat(64),
    metadata: { nested: ['plain', 1, true, null] },
    ...overrides,
  };
}

function report(): ReviewReport {
  const source = entry();
  return assembleReviewReport({
    model: 'fixture',
    started_at: '2026-09-07T12:00:00.000Z',
    entry_count: 1,
    drops: {},
    proposals: [{
      id: 'aabbccdd',
      kind: 'stale',
      entry_ids: [source.id],
      quotes: [{ entry_id: source.id, quote: 'Synthetic memory' }],
      explanation: 'Synthetic explanation.',
      target_entry_id: source.id,
      proposed_content: 'Updated synthetic memory content.',
      status: 'pending',
    }],
    vault_id: randomUUID(),
    vault_path: vaultPath,
    selected_scopes: ['personal'],
    source_entries: [source],
  });
}

function writeUnchecked(value: unknown): void {
  fs.mkdirSync(path.dirname(reviewReportPath(vaultPath)), { recursive: true });
  fs.writeFileSync(reviewReportPath(vaultPath), JSON.stringify(value), { mode: 0o600 });
}

describe('strict review report persistence', () => {
  let testHome: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.NORTHKEEP_HOME;
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-report-schema-'));
    process.env.NORTHKEEP_HOME = testHome;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = previousHome;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it('returns null only for absence and round-trips a valid report as mode 0600', () => {
    expect(loadReviewReport(vaultPath)).toBeNull();
    const value = report();
    saveReviewReport(value, vaultPath);
    expect(loadReviewReport(vaultPath)).toEqual(value);
    expect(fs.statSync(reviewReportPath(vaultPath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['bad timestamp', (value: any) => { value.started_at = 'yesterday'; }],
    ['bad metadata shape', (value: any) => { value.source_entries[0].metadata = ['not', 'an', 'object']; }],
    ['unknown proposal status', (value: any) => { value.proposals[0].status = 'approved'; }],
    ['unrelated proposal source', (value: any) => { value.proposals[0].entry_ids = [randomUUID()]; }],
    ['fabricated quote', (value: any) => { value.proposals[0].quotes[0].quote = 'not in source'; }],
    ['duplicate source id', (value: any) => { value.source_entries.push(value.source_entries[0]); value.coverage.selected = 2; }],
    ['incomplete complete coverage', (value: any) => { value.coverage.compared = 0; }],
    ['unselected source scope', (value: any) => { value.selected_scopes = ['other']; }],
    ['non-live source', (value: any) => { value.source_entries[0].forgotten_at = '2026-09-07T12:01:00.000Z'; }],
  ])('refuses %s instead of returning null', (_name, mutate) => {
    const value = structuredClone(report());
    mutate(value);
    writeUnchecked(value);
    expect(() => loadReviewReport(vaultPath)).toThrow(/strict validation/);
  });

  it('refuses empty mutation receipts and reused receipt or operation ids', () => {
    const value = report();
    const operation = {
      receipt_id: randomUUID(),
      operation_id: randomUUID(),
      request_fingerprint: '2'.repeat(64),
      proposal_id: 'aabbccdd',
      action: 'accept' as const,
      status: 'prepared' as const,
      prepared_at: '2026-09-07T12:01:00.000Z',
      before: [],
      after: [],
      proposal_before: { status: 'pending' as const },
    };
    writeUnchecked({ ...value, operations: [operation] });
    expect(() => loadReviewReport(vaultPath)).toThrow(/strict validation/);

    const nonwrite = { ...operation, action: 'keep', status: 'committed', committed_at: '2026-09-07T12:02:00.000Z' };
    delete (nonwrite as { proposal_before?: unknown }).proposal_before;
    writeUnchecked({ ...value, operations: [nonwrite, { ...nonwrite }] });
    expect(() => loadReviewReport(vaultPath)).toThrow(/strict validation/);
  });

  it('permits committed nonwrites and historical operations for old proposal ids', () => {
    const value = report();
    value.operations.push({
      receipt_id: randomUUID(),
      operation_id: randomUUID(),
      request_fingerprint: '2'.repeat(64),
      proposal_id: 'deadbeef',
      action: 'reject',
      status: 'committed',
      prepared_at: '2026-09-07T12:01:00.000Z',
      committed_at: '2026-09-07T12:02:00.000Z',
      before: [],
      after: [],
    });
    saveReviewReport(value, vaultPath);
    expect(loadReviewReport(vaultPath)).toEqual(value);
  });

  it('refuses history carry-over from a different vault identity or path', () => {
    const previous = report();
    const base = {
      model: 'fixture',
      started_at: '2026-09-07T13:00:00.000Z',
      entry_count: 0,
      drops: {},
      proposals: [],
      previous,
      selected_scopes: [],
      source_entries: [],
    };
    expect(() => assembleReviewReport({ ...base, vault_id: randomUUID(), vault_path: vaultPath })).toThrow(/different vault/);
    expect(() => assembleReviewReport({ ...base, vault_id: previous.vault_id, vault_path: `${vaultPath}.other` })).toThrow(/different vault/);
  });

  it('validates before saving and requires committed receipts to have a timestamp', () => {
    const value = report();
    value.operations.push({
      receipt_id: randomUUID(),
      operation_id: randomUUID(),
      request_fingerprint: '2'.repeat(64),
      proposal_id: 'aabbccdd',
      action: 'keep',
      status: 'committed',
      prepared_at: '2026-09-07T12:01:00.000Z',
      before: [],
      after: [],
    });
    expect(() => saveReviewReport(value, vaultPath)).toThrow(/refusing to save/);
    expect(fs.existsSync(reviewReportPath(vaultPath))).toBe(false);
  });

  it('round-trips reject, keep, and unresolved receipts made by the real helper', () => {
    const livePath = path.join(process.env.NORTHKEEP_HOME!, 'decision-vault.nkv');
    const vault = Vault.create({
      path: livePath,
      passphrase: 'synthetic report schema passphrase',
      deviceSecret: generateDeviceSecret(),
      kdf: KDF_INTERACTIVE,
    });
    try {
      const first = vault.remember({ content: 'First synthetic duplicate.', type: 'semantic' });
      const second = vault.remember({ content: 'Second synthetic duplicate.', type: 'semantic' });
      vault.save();
      const value = assembleReviewReport({
        model: 'fixture',
        started_at: '2026-09-07T12:00:00.000Z',
        entry_count: 2,
        drops: {},
        proposals: [
          {
            id: 'aaaabbbb', kind: 'stale', entry_ids: [first.id],
            quotes: [{ entry_id: first.id, quote: 'First synthetic' }],
            explanation: 'Reject this.', target_entry_id: first.id,
            proposed_content: 'Changed.', status: 'pending',
          },
          {
            id: 'ccccdddd', kind: 'duplicate', entry_ids: [first.id, second.id],
            quotes: [
              { entry_id: first.id, quote: 'First synthetic duplicate.' },
              { entry_id: second.id, quote: 'Second synthetic duplicate.' },
            ],
            explanation: 'Keep one.', target_entry_id: null, proposed_content: null,
            member_decisions: { [first.id]: 'pending', [second.id]: 'pending' }, status: 'pending',
          },
          {
            id: 'eeeeffff', kind: 'question', entry_ids: [first.id, second.id],
            quotes: [
              { entry_id: first.id, quote: 'First synthetic' },
              { entry_id: second.id, quote: 'Second synthetic' },
            ],
            explanation: 'Defer this.', target_entry_id: null, proposed_content: null,
            question: 'Which synthetic memory is current?', status: 'pending',
          },
        ],
        vault_id: vault.getVaultId(), vault_path: livePath,
        selected_scopes: ['personal'], source_entries: [first, second],
      });
      for (const [id, action, entryId] of [
        ['aaaabbbb', 'reject', undefined],
        ['ccccdddd', 'keep', first.id],
        ['eeeeffff', 'unresolved', undefined],
      ] as const) {
        const current = value.proposals.find((item) => item.id === id)!;
        recordReviewDecision(vault, value, livePath, vault.getVaultId(), id, action, {
          report_id: value.report_id,
          proposal_fingerprint: proposalFingerprint(current),
          operation_id: randomUUID(),
          entry_id: entryId,
        });
      }
      expect(loadReviewReport(livePath)).toEqual(value);
      expect(value.operations.map((item) => item.action)).toEqual(['reject', 'keep', 'unresolved']);
    } finally {
      vault.close();
    }
  });
});
