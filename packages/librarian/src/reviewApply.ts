/**
 * Apply helpers for a memory review pass (ADR 0043). The model never calls these.
 * Report-only transformations. Vault mutations must use reviewSession (ADR 0046).
 */
import type { Vault } from '@northkeep/core';
import { findProposal, proposalFingerprint, type ReviewReport } from './reviewReport.js';
import type { ReviewKind, ReviewProposal } from './reviewSchema.js';

function assertPending(proposal: ReviewProposal): void {
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal ${proposal.id} is ${proposal.status}, not pending.`);
  }
}

function assertKind(kind: ReviewKind, allowed: ReviewKind[], action: string): void {
  switch (kind) {
    case 'duplicate':
    case 'contradiction':
    case 'undated':
    case 'stale':
    case 'question':
      if (!allowed.includes(kind)) {
        throw new Error(`Cannot ${action} a ${kind} proposal.`);
      }
      return;
    default: {
      const _never: never = kind;
      throw new Error(`Unhandled proposal kind: ${String(_never)}`);
    }
  }
}

function resolveMember(proposal: ReviewProposal, entryId: string): string {
  const needle = entryId.trim().toLowerCase();
  const matches = proposal.entry_ids.filter((id) => id === needle || id.startsWith(needle));
  if (matches.length === 0) throw new Error(`No cluster member matching "${entryId}".`);
  if (matches.length > 1) throw new Error(`Entry id "${entryId}" is ambiguous in this cluster.`);
  return matches[0]!;
}

/** @deprecated The old unjournaled mutation path is deliberately disabled. */
export function acceptProposal(_vault: Vault, _report: ReviewReport, _proposalId: string): ReviewProposal {
  throw new Error('Use applyReviewAction with report/vault identity and an operation ID.');
}

export function rejectProposal(report: ReviewReport, proposalId: string): ReviewProposal {
  const proposal = findProposal(report, proposalId);
  assertPending(proposal);
  proposal.status = 'rejected';
  const fp = proposalFingerprint(proposal);
  if (!report.rejected_fingerprints.includes(fp)) {
    report.rejected_fingerprints.push(fp);
  }
  return proposal;
}

/** Vault no-op: reject every pending proposal. Returns how many were dismissed. */
export function rejectRemaining(report: ReviewReport): number {
  const pending = report.proposals.filter((p) => p.status === 'pending').map((p) => p.id);
  for (const id of pending) rejectProposal(report, id);
  return pending.length;
}

export function keepDuplicateMember(
  report: ReviewReport,
  proposalId: string,
  entryId: string,
): ReviewProposal {
  const proposal = findProposal(report, proposalId);
  assertKind(proposal.kind, ['duplicate'], 'keep');
  assertPending(proposal);
  const member = resolveMember(proposal, entryId);
  const decisions = proposal.member_decisions ?? {};
  if ((decisions[member] ?? 'pending') !== 'pending') {
    throw new Error(`Member ${member.slice(0, 8)} is already ${decisions[member]}.`);
  }
  decisions[member] = 'kept';
  proposal.member_decisions = decisions;
  if (everyMemberDecided(proposal)) proposal.status = 'resolved';
  return proposal;
}

/** @deprecated The old unjournaled mutation path is deliberately disabled. */
export function forgetDuplicateMember(
  _vault: Vault,
  _report: ReviewReport,
  _proposalId: string,
  _entryId: string,
): ReviewProposal {
  throw new Error('Use applyReviewAction with report/vault identity and an operation ID.');
}

function everyMemberDecided(proposal: ReviewProposal): boolean {
  const decisions = proposal.member_decisions ?? {};
  return proposal.entry_ids.every((id) => {
    const d = decisions[id] ?? 'pending';
    return d === 'kept' || d === 'forgotten';
  });
}
