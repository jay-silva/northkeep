/**
 * Apply helpers for a memory review pass (ADR 0043). The model never calls these.
 * Accept uses Vault.editMemory (ADR 0015 supersede). Forget uses Vault.forget.
 * Keep and reject are vault no-ops. Re-validate at apply time (P4).
 */
import type { MemoryEntry, Vault } from '@northkeep/core';
import { findProposal, proposalFingerprint, type ReviewReport } from './reviewReport.js';
import type { ReviewKind, ReviewProposal } from './reviewSchema.js';

const VAULT_CHANGED = 'Vault changed since this report. Run the pass again.';

function liveById(vault: Vault): Map<string, MemoryEntry> {
  const map = new Map<string, MemoryEntry>();
  for (const e of vault.list()) map.set(e.id, e);
  return map;
}

function revalidate(proposal: ReviewProposal, live: Map<string, MemoryEntry>): void {
  for (const id of proposal.entry_ids) {
    if (!live.has(id)) throw new Error(VAULT_CHANGED);
  }
  for (const q of proposal.quotes) {
    const entry = live.get(q.entry_id);
    if (entry === undefined || !entry.content.includes(q.quote)) {
      throw new Error(VAULT_CHANGED);
    }
  }
  if (proposal.target_entry_id !== null && !live.has(proposal.target_entry_id)) {
    throw new Error(VAULT_CHANGED);
  }
}

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

export function acceptProposal(vault: Vault, report: ReviewReport, proposalId: string): ReviewProposal {
  const proposal = findProposal(report, proposalId);
  assertPending(proposal);
  assertKind(proposal.kind, ['contradiction', 'undated', 'stale'], 'accept');
  if (proposal.target_entry_id === null || proposal.proposed_content === null) {
    throw new Error('This proposal has no confirmed replacement text.');
  }
  revalidate(proposal, liveById(vault));
  vault.editMemory(proposal.target_entry_id, { content: proposal.proposed_content });
  proposal.status = 'accepted';
  return proposal;
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

export function forgetDuplicateMember(
  vault: Vault,
  report: ReviewReport,
  proposalId: string,
  entryId: string,
): ReviewProposal {
  const proposal = findProposal(report, proposalId);
  assertKind(proposal.kind, ['duplicate'], 'forget');
  assertPending(proposal);
  const member = resolveMember(proposal, entryId);
  const decisions = proposal.member_decisions ?? {};
  if ((decisions[member] ?? 'pending') !== 'pending') {
    throw new Error(`Member ${member.slice(0, 8)} is already ${decisions[member]}.`);
  }
  const live = liveById(vault);
  const entry = live.get(member);
  if (entry === undefined) throw new Error(VAULT_CHANGED);
  const quote = proposal.quotes.find((q) => q.entry_id === member);
  if (quote !== undefined && !entry.content.includes(quote.quote)) {
    throw new Error(VAULT_CHANGED);
  }
  vault.forget(member);
  decisions[member] = 'forgotten';
  proposal.member_decisions = decisions;
  if (everyMemberDecided(proposal)) proposal.status = 'resolved';
  return proposal;
}

function everyMemberDecided(proposal: ReviewProposal): boolean {
  const decisions = proposal.member_decisions ?? {};
  return proposal.entry_ids.every((id) => {
    const d = decisions[id] ?? 'pending';
    return d === 'kept' || d === 'forgotten';
  });
}
