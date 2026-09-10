import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import {
  applyReviewAction, assembleReviewReport, loadReviewReport, proposalFingerprint,
  reconcileReviewOperations, recordReviewDecision, restoreReviewOperation, reviewReportPath,
} from '../src/index.js';

const previousHome = process.env.NORTHKEEP_HOME;
const passphrase = 'synthetic-crash-boundary-only';

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = previousHome;
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-curation-crash-'));
  process.env.NORTHKEEP_HOME = directory;
  const vaultPath = path.join(directory, 'synthetic.nkv');
  const deviceSecret = generateDeviceSecret();
  const open = () => Vault.open({ path: vaultPath, passphrase, deviceSecret });
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  const entry = vault.remember({ type: 'semantic', content: 'Original synthetic wording.' });
  vault.save();
  const proposal = {
    id: 'abcdef12', kind: 'stale' as const, status: 'pending' as const,
    entry_ids: [entry.id], quotes: [{ entry_id: entry.id, quote: entry.content }],
    target_entry_id: entry.id, proposed_content: 'Updated synthetic wording.', explanation: 'Synthetic correction.',
  };
  const report = assembleReviewReport({
    vault_id: vault.getVaultId(), vault_path: vaultPath, source_entries: [entry], selected_scopes: ['personal'],
    entry_count: 1, model: 'fixture', started_at: new Date().toISOString(), drops: {}, proposals: [proposal],
    coverage: { selected: 1, compared: 1, skipped: 0, failed: 0, complete: true },
  });
  const action = {
    report_id: report.report_id, proposal_fingerprint: proposalFingerprint(proposal),
    operation_id: randomUUID(), content: proposal.proposed_content,
  };
  return { vault, vaultPath, open, entry, proposal, report, action };
}

function failSecondReportRename(vaultPath: string) {
  const rename = fs.renameSync;
  let reportWrites = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (String(target) === reviewReportPath(vaultPath) && ++reportWrites === 2) {
      throw Object.assign(new Error('Injected report commit disk failure'), { code: 'EIO' });
    }
    return rename(source, target);
  });
}

function currentReport(vaultPath: string) {
  const report = loadReviewReport(vaultPath);
  if (!report || report.schema !== 'northkeep-review-report/2') throw new Error('Expected a version 2 report.');
  return report;
}

describe('actual vault/report persistence boundary', () => {
  it('retains an unsaved aborted attempt without stranding a new review', () => {
    const f = fixture();
    f.vault.save = () => { throw new Error('Injected failure before vault save'); };
    expect(() => applyReviewAction(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), f.proposal.id, 'accept', f.action))
      .toThrow(/before vault save/);
    f.vault.close();
    const vault = f.open();
    try {
      const report = currentReport(f.vaultPath);
      reconcileReviewOperations(vault, report, f.vaultPath);
      expect(report.operations[0]!.status).toBe('aborted');
      expect(report.proposals[0]!.status).toBe('pending');
      const next = assembleReviewReport({
        vault_id: vault.getVaultId(), vault_path: f.vaultPath, previous: report,
        source_entries: vault.list(), selected_scopes: ['personal'], entry_count: 1,
        model: 'fixture', started_at: new Date().toISOString(), proposals: [], drops: {},
      });
      expect(next.operations[0]!.status).toBe('aborted');
      expect(vault.list()).toEqual([f.entry]);
    } finally { vault.close(); }
  });

  it('records an unresolved decision idempotently without vault writes or permanent suppression', () => {
    const f = fixture();
    const before = fs.readFileSync(f.vaultPath);
    try {
      const receipt = recordReviewDecision(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), f.proposal.id, 'unresolved', f.action);
      expect(receipt.action).toBe('unresolved');
      expect(recordReviewDecision(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), f.proposal.id, 'unresolved', f.action).receipt_id)
        .toBe(receipt.receipt_id);
      expect(() => recordReviewDecision(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), f.proposal.id, 'reject', f.action))
        .toThrow(/different request/);
      expect(f.report.rejected_fingerprints).toEqual([]);
      expect(fs.readFileSync(f.vaultPath)).toEqual(before);
    } finally { f.vault.close(); }
  });

  it('recovers the saved edit after the final report rename fails without repeating the write', () => {
    const f = fixture();
    failSecondReportRename(f.vaultPath);
    expect(() => applyReviewAction(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), f.proposal.id, 'accept', f.action))
      .toThrow(/disk failure/);
    f.vault.close();
    vi.restoreAllMocks();
    const vault = f.open();
    try {
      const report = currentReport(f.vaultPath);
      expect(report.operations[0]!.status).toBe('prepared');
      const persisted = vault.list({ includeSuperseded: true });
      expect(persisted).toHaveLength(2);
      reconcileReviewOperations(vault, report, f.vaultPath);
      expect(applyReviewAction(vault, report, f.vaultPath, vault.getVaultId(), f.proposal.id, 'accept', f.action).status)
        .toBe('committed');
      expect(vault.list({ includeSuperseded: true })).toEqual(persisted);
      expect(() => applyReviewAction(vault, report, f.vaultPath, vault.getVaultId(), f.proposal.id, 'accept', {
        ...f.action, content: 'Altered retry must not apply.',
      })).toThrow(/different request/);
      expect(vault.list({ includeSuperseded: true })).toEqual(persisted);
    } finally { vault.close(); }
  });

  it('recovers a saved restoration after its receipt commit fails without restoring twice', () => {
    const f = fixture();
    const saved = applyReviewAction(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), f.proposal.id, 'accept', f.action);
    const head = saved.after.find((entry) => entry.id !== f.entry.id)!;
    const restore = {
      report_id: f.report.report_id, operation_id: randomUUID(), receipt_id: saved.receipt_id,
      expected_head_id: head.id, expected_content: head.content,
    };
    failSecondReportRename(f.vaultPath);
    expect(() => restoreReviewOperation(f.vault, f.report, f.vaultPath, f.vault.getVaultId(), restore))
      .toThrow(/disk failure/);
    f.vault.close();
    vi.restoreAllMocks();
    const vault = f.open();
    try {
      const report = currentReport(f.vaultPath);
      const persisted = vault.list({ includeSuperseded: true });
      expect(persisted).toHaveLength(3);
      expect(vault.list()[0]!.content).toBe(f.entry.content);
      reconcileReviewOperations(vault, report, f.vaultPath);
      expect(restoreReviewOperation(vault, report, f.vaultPath, vault.getVaultId(), restore).status).toBe('committed');
      expect(vault.list({ includeSuperseded: true })).toEqual(persisted);
    } finally { vault.close(); }
  });
});
