import { randomUUID } from 'node:crypto';
import type { MemoryEntry, Vault } from '@northkeep/core';
import { keepDuplicateMember, rejectProposal } from './reviewApply.js';
import {
  assertReportVault, findProposal, operationFingerprint, proposalFingerprint, saveReviewReport,
  type ReviewReceipt, type ReviewReport,
} from './reviewReport.js';

const CHANGED = 'Vault changed since this review. Run a fresh review.';
export interface ReviewActionRequest {
  report_id: string;
  proposal_fingerprint: string;
  operation_id: string;
  content?: string;
  entry_id?: string;
  survivor_id?: string;
  target_entry_id?: string;
}
export interface RestoreRequest {
  report_id: string;
  operation_id: string;
  receipt_id: string;
  expected_head_id: string;
  expected_content: string;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function same(a: MemoryEntry, b: MemoryEntry): boolean {
  return operationFingerprint(a) === operationFingerprint(b);
}
function currentById(vault: Vault): Map<string, MemoryEntry> {
  return new Map(vault.list({ includeForgotten: true, includeSuperseded: true }).map((entry) => [entry.id, entry]));
}
function assertSources(report: ReviewReport, vault: Vault, ids: string[]): void {
  const stored = new Map(report.source_entries.map((entry) => [entry.id, entry]));
  const live = currentById(vault);
  for (const id of ids) {
    const before = stored.get(id), current = live.get(id);
    if (!before || !current || !same(before, current) || current.forgotten_at || current.superseded_at) throw new Error(CHANGED);
  }
}
function validateBase(report: ReviewReport, vaultPath: string, vaultId: string, proposalId: string, req: ReviewActionRequest) {
  if (!uuid(req.operation_id)) throw new Error('operation_id must be a UUID.');
  if (req.report_id !== report.report_id) throw new Error('Obsolete review report. Refresh and try again.');
  assertReportVault(report, vaultPath, vaultId);
  const proposal = findProposal(report, proposalId);
  if (req.proposal_fingerprint !== proposalFingerprint(proposal)) throw new Error('Proposal changed. Refresh and try again.');
  return proposal;
}
function prior(report: ReviewReport, operationId: string, fingerprint: string): ReviewReceipt | undefined {
  const receipt = report.operations.find((operation) => operation.operation_id === operationId);
  if (receipt && receipt.request_fingerprint !== fingerprint) throw new Error('operation_id was already used for a different request.');
  return receipt;
}
function actionFingerprint(proposalId: string, action: string, req: ReviewActionRequest): string {
  return operationFingerprint({ ...req, proposal_id: proposalId, action });
}
function markCommitted(report: ReviewReport, receipt: ReviewReceipt, vaultPath: string): ReviewReceipt {
  receipt.status = 'committed';
  receipt.committed_at = new Date().toISOString();
  saveReviewReport(report, vaultPath);
  return receipt;
}

/** Caller holds the vault lock. Close a failed action's vault handle; do not reuse it. */
export function reconcileReviewOperations(vault: Vault, report: ReviewReport, vaultPath: string): void {
  assertReportVault(report, vaultPath, vault.getVaultId());
  const live = currentById(vault);
  let dirty = false;
  for (const receipt of report.operations.filter((operation) => operation.status === 'prepared')) {
    if (!receipt.before.length || !receipt.after.length) throw new Error('Invalid prepared review operation.');
    const afterPresent = receipt.after.every((entry) => {
      const current = live.get(entry.id);
      return current !== undefined && same(current, entry);
    });
    if (afterPresent) {
      receipt.status = 'committed';
      receipt.committed_at = new Date().toISOString();
      dirty = true;
      continue;
    }
    const beforeIntact = receipt.before.every((entry) => {
      const current = live.get(entry.id);
      return current !== undefined && same(current, entry);
    });
    const noNewRevisions = receipt.after.every((entry) => !live.has(entry.id) || receipt.before.some((before) => before.id === entry.id));
    if (beforeIntact && noNewRevisions) {
      const proposal = report.proposals.find((candidate) => candidate.id === receipt.proposal_id);
      if (proposal && receipt.proposal_before) {
        proposal.status = receipt.proposal_before.status;
        proposal.member_decisions = receipt.proposal_before.member_decisions ? { ...receipt.proposal_before.member_decisions } : undefined;
      }
      // Retain the request binding without stranding a browser that lost its retry ID.
      receipt.status = 'aborted';
      delete receipt.committed_at;
      dirty = true;
      continue;
    }
    throw new Error('An interrupted review change cannot be reconciled safely. Inspect review history before continuing.');
  }
  if (dirty) saveReviewReport(report, vaultPath);
}
function saveMutation(vault: Vault, report: ReviewReport, vaultPath: string, receipt: ReviewReceipt, existing?: ReviewReceipt): ReviewReceipt {
  if (!existing) report.operations.push(receipt);
  // Durable intent, encrypted vault, then success receipt. Never reverse this order.
  saveReviewReport(report, vaultPath);
  vault.save();
  return markCommitted(report, receipt, vaultPath);
}
export function applyReviewAction(
  vault: Vault, report: ReviewReport, vaultPath: string, vaultId: string,
  proposalId: string, action: 'accept' | 'forget', req: ReviewActionRequest,
): ReviewReceipt {
  const proposal = validateBase(report, vaultPath, vaultId, proposalId, req);
  const fingerprint = actionFingerprint(proposalId, action, req);
  const existing = prior(report, req.operation_id, fingerprint);
  reconcileReviewOperations(vault, report, vaultPath);
  if (existing?.status === 'committed') return existing;
  if (proposal.status !== 'pending') throw new Error('Proposal ' + proposal.id + ' is ' + proposal.status + ', not pending.');
  const beforeAll = currentById(vault), before: MemoryEntry[] = [], after: MemoryEntry[] = [];
  const proposalBefore = { status: proposal.status, member_decisions: proposal.member_decisions ? { ...proposal.member_decisions } : undefined };
  if (action === 'accept') {
    if (proposal.kind === 'duplicate') throw new Error('Duplicate proposals cannot be accepted as replacements.');
    const target = req.target_entry_id ?? proposal.target_entry_id;
    if (!target || !proposal.entry_ids.includes(target) || !proposal.quotes.some((quote) => quote.entry_id === target)) {
      throw new Error('A quoted target_entry_id is required.');
    }
    if (proposal.kind !== 'question' && req.target_entry_id !== undefined && req.target_entry_id !== proposal.target_entry_id) {
      throw new Error('Only a question may choose a target at apply time.');
    }
    assertSources(report, vault, proposal.entry_ids);
    const content = req.content ?? proposal.proposed_content;
    if (typeof content !== 'string' || !content.trim() || content.length > 20_000) throw new Error('Replacement content must be 1 to 20,000 characters.');
    if (content === beforeAll.get(target)?.content) throw new Error('Replacement content must change the selected memory.');
    before.push(beforeAll.get(target)!);
    const next = vault.editMemory(target, { content });
    after.push(currentById(vault).get(target)!, next);
    proposal.status = 'accepted';
  } else {
    if (proposal.kind !== 'duplicate') throw new Error('Only duplicate proposals can forget a member.');
    if (!req.entry_id || !proposal.entry_ids.includes(req.entry_id)) throw new Error('entry_id must name a duplicate member.');
    if (!req.survivor_id || req.survivor_id === req.entry_id || !proposal.entry_ids.includes(req.survivor_id)) {
      throw new Error('survivor_id must name a different duplicate member.');
    }
    assertSources(report, vault, [req.entry_id, req.survivor_id]);
    before.push(beforeAll.get(req.entry_id)!);
    vault.forget(req.entry_id);
    after.push(currentById(vault).get(req.entry_id)!);
    const decisions = proposal.member_decisions ?? {};
    decisions[req.entry_id] = 'forgotten';
    decisions[req.survivor_id] = 'kept';
    proposal.member_decisions = decisions;
    if (proposal.entry_ids.every((id) => (decisions[id] ?? 'pending') !== 'pending')) proposal.status = 'resolved';
  }
  const receipt: ReviewReceipt = existing ?? {
    receipt_id: randomUUID(), operation_id: req.operation_id, request_fingerprint: fingerprint,
    proposal_id: proposalId, action, status: 'prepared', prepared_at: new Date().toISOString(), before, after,
  };
  Object.assign(receipt, { status: 'prepared', before, after, prepared_at: new Date().toISOString(), proposal_before: proposalBefore });
  if (req.survivor_id) receipt.survivor_id = req.survivor_id;
  delete receipt.committed_at;
  return saveMutation(vault, report, vaultPath, receipt, existing);
}

/** Report-only decisions use one atomic report write and never save the vault. */
export function recordReviewDecision(
  vault: Vault, report: ReviewReport, vaultPath: string, vaultId: string,
  proposalId: string, action: 'reject' | 'keep' | 'unresolved', req: ReviewActionRequest,
): ReviewReceipt {
  const proposal = validateBase(report, vaultPath, vaultId, proposalId, req);
  const fingerprint = actionFingerprint(proposalId, action, req);
  const existing = prior(report, req.operation_id, fingerprint);
  reconcileReviewOperations(vault, report, vaultPath);
  if (existing?.status === 'committed') return existing;
  if (proposal.status !== 'pending') throw new Error('Proposal ' + proposal.id + ' is ' + proposal.status + ', not pending.');
  const proposalBefore = { status: proposal.status, member_decisions: proposal.member_decisions ? { ...proposal.member_decisions } : undefined };
  if (action === 'keep') {
    if (!req.entry_id || !proposal.entry_ids.includes(req.entry_id)) throw new Error('entry_id must name a full duplicate member ID.');
    assertSources(report, vault, [req.entry_id]);
    keepDuplicateMember(report, proposalId, req.entry_id);
  } else if (action === 'reject') rejectProposal(report, proposalId);
  else proposal.status = 'resolved'; // Deferred for this report, without permanent suppression.
  const now = new Date().toISOString();
  const receipt: ReviewReceipt = {
    receipt_id: randomUUID(), operation_id: req.operation_id, request_fingerprint: fingerprint, proposal_id: proposalId,
    action, status: 'committed', prepared_at: now, committed_at: now, before: [], after: [], proposal_before: proposalBefore,
  };
  report.operations.push(receipt);
  saveReviewReport(report, vaultPath);
  return receipt;
}
export function restoreReviewOperation(
  vault: Vault, report: ReviewReport, vaultPath: string, vaultId: string, req: RestoreRequest,
): ReviewReceipt {
  if (!uuid(req.operation_id)) throw new Error('operation_id must be a UUID.');
  if (req.report_id !== report.report_id) throw new Error('Obsolete review report.');
  assertReportVault(report, vaultPath, vaultId);
  const fingerprint = operationFingerprint(req), existing = prior(report, req.operation_id, fingerprint);
  reconcileReviewOperations(vault, report, vaultPath);
  if (existing?.status === 'committed') return existing;
  const source = report.operations.find((receipt) => receipt.receipt_id === req.receipt_id && receipt.status === 'committed');
  if (!source || (source.action !== 'accept' && source.action !== 'forget')) throw new Error('No restorable committed receipt found.');
  if (report.operations.some((receipt) => receipt.status === 'committed' && receipt.action === 'restore' && receipt.restores_receipt_id === source.receipt_id)) {
    throw new Error('That saved change has already been restored.');
  }
  const live = currentById(vault), before: MemoryEntry[] = [], after: MemoryEntry[] = [];
  const original = source.before[0]!;
  if (source.action === 'accept') {
    const head = source.after.find((entry) => entry.id !== original.id && !entry.superseded_at);
    if (!head || head.id !== req.expected_head_id || head.content !== req.expected_content) throw new Error('Restore confirmation is stale.');
    const current = live.get(head.id);
    if (!current || !same(current, head) || current.forgotten_at) throw new Error(CHANGED);
    before.push(current);
    const restored = vault.editMemory(head.id, { content: original.content, scope: original.scope, type: original.type });
    after.push(currentById(vault).get(head.id)!, restored);
  } else {
    const forgotten = source.after[0];
    if (!forgotten || forgotten.id !== req.expected_head_id || original.content !== req.expected_content) throw new Error('Restore confirmation is stale.');
    const current = live.get(forgotten.id);
    if (!current || !same(current, forgotten)) throw new Error(CHANGED);
    before.push(current);
    after.push(vault.remember({
      content: original.content, type: original.type, scope: original.scope, source: 'review-recovery',
      sourceModel: null, confidence: original.confidence,
      metadata: { ...original.metadata, recovered_from: original.id, review_receipt: source.receipt_id },
    }));
  }
  const receipt: ReviewReceipt = existing ?? {
    receipt_id: randomUUID(), operation_id: req.operation_id, request_fingerprint: fingerprint, proposal_id: source.proposal_id,
    action: 'restore', status: 'prepared', prepared_at: new Date().toISOString(), before, after, restores_receipt_id: source.receipt_id,
  };
  Object.assign(receipt, { status: 'prepared', before, after, prepared_at: new Date().toISOString() });
  delete receipt.committed_at;
  return saveMutation(vault, report, vaultPath, receipt, existing);
}
