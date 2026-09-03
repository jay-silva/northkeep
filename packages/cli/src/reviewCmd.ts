/**
 * `northkeep review` — memory review pass (ADR 0043). Unnamed in product copy.
 * The run writes a local report only. Accept / forget happen after a user tap.
 */
import type { MemoryEntry, Vault } from '@northkeep/core';
import {
  acceptProposal,
  assembleReviewReport,
  createOllamaClient,
  forgetDuplicateMember,
  keepDuplicateMember,
  loadReviewReport,
  rejectProposal,
  resolveReviewModel,
  runReviewPass,
  saveReviewReport,
  selectReviewEntries,
  type ReviewProposal,
  type ReviewReport,
} from '@northkeep/librarian';

export type WithVault = <T>(fn: (vault: Vault) => Promise<T> | T) => Promise<T>;

export async function reviewRun(withVault: WithVault): Promise<void> {
  let snapshot: MemoryEntry[] = [];
  await withVault((vault) => {
    snapshot = vault.list();
  });
  const entries = selectReviewEntries(snapshot);
  const started_at = new Date().toISOString();
  const model = await resolveReviewModel();
  const ollama = createOllamaClient();
  const result = await runReviewPass(entries, ollama, { model });
  const previous = loadReviewReport();
  const report = assembleReviewReport({
    model: result.model,
    started_at,
    finished_at: new Date().toISOString(),
    entry_count: entries.length,
    drops: result.drops,
    proposals: result.proposals,
    previous,
  });
  saveReviewReport(report);
  const pending = report.proposals.filter((p) => p.status === 'pending').length;
  console.log(`Review pass finished. Model: ${report.model}.`);
  console.log(`Reviewed ${report.entry_count} memories in ${result.batches} batch${result.batches === 1 ? '' : 'es'}.`);
  console.log(`${report.proposals.length} proposal${report.proposals.length === 1 ? '' : 's'} (${pending} pending).`);
  const dropTotal = Object.values(report.drops).reduce((a, b) => a + b, 0);
  if (dropTotal > 0) {
    console.log(`Dropped ${dropTotal} invalid model item${dropTotal === 1 ? '' : 's'} (quotes must match the vault exactly).`);
  }
  console.log('Inspect with: northkeep review show');
  console.log('Nothing was written to the vault.');
}

export async function reviewShow(withVault: WithVault): Promise<void> {
  const report = loadReviewReport();
  if (report === null) {
    console.log('No review pass report yet. Run: northkeep review run');
    return;
  }
  let live: Map<string, MemoryEntry> = new Map();
  await withVault((vault) => {
    live = new Map(vault.list({ includeForgotten: true, includeSuperseded: true }).map((e) => [e.id, e]));
  });
  console.log(`Memory review pass  model ${report.model}  ${report.started_at}`);
  console.log(`Reviewed ${report.entry_count} memories. ${report.proposals.length} proposal${report.proposals.length === 1 ? '' : 's'}.`);
  console.log('');
  if (report.proposals.length === 0) {
    console.log('No proposals.');
    return;
  }
  for (const p of report.proposals) {
    printProposal(p, live);
    console.log('');
  }
}

export async function reviewAccept(proposalId: string, withVault: WithVault): Promise<void> {
  const report = requireReport();
  await withVault((vault) => {
    const proposal = acceptProposal(vault, report, proposalId);
    vault.save();
    saveReviewReport(report);
    console.log(`Accepted ${proposal.id} (${proposal.kind}). The previous version is kept as history.`);
  });
}

export async function reviewReject(proposalId: string, withVault: WithVault): Promise<void> {
  const report = requireReport();
  const proposal = rejectProposal(report, proposalId);
  saveReviewReport(report);
  console.log(`Rejected ${proposal.id}. Vault untouched.`);
}

export async function reviewKeep(proposalId: string, entryId: string, _withVault: WithVault): Promise<void> {
  const report = requireReport();
  const proposal = keepDuplicateMember(report, proposalId, entryId);
  saveReviewReport(report);
  console.log(`Kept ${entryId.slice(0, 8)} in cluster ${proposal.id}. Vault untouched.`);
}

export async function reviewForget(proposalId: string, entryId: string, withVault: WithVault): Promise<void> {
  const report = requireReport();
  await withVault((vault) => {
    const proposal = forgetDuplicateMember(vault, report, proposalId, entryId);
    vault.save();
    saveReviewReport(report);
    console.log(`Forgot ${entryId.slice(0, 8)} from cluster ${proposal.id}.`);
  });
}

function requireReport(): ReviewReport {
  const report = loadReviewReport();
  if (report === null) {
    throw new Error('No review pass report yet. Run: northkeep review run');
  }
  return report;
}

function printProposal(p: ReviewProposal, live: Map<string, MemoryEntry>): void {
  const title = `[${p.id}] ${p.kind}  ${p.status}`;
  console.log(title);
  if (p.explanation) console.log(`  ${p.explanation}`);
  switch (p.kind) {
    case 'duplicate': {
      for (const id of p.entry_ids) {
        const decision = p.member_decisions?.[id] ?? 'pending';
        const entry = live.get(id);
        const quote = p.quotes.find((q) => q.entry_id === id)?.quote;
        console.log(`  member ${id.slice(0, 8)}  ${decision}`);
        if (entry) console.log(`    vault: ${entry.content}`);
        else console.log('    vault: (not in this vault)');
        if (quote) console.log(`    quote: ${quote}`);
      }
      return;
    }
    case 'contradiction': {
      const a = p.entry_ids[0];
      const b = p.entry_ids[1];
      if (a) printSide('A', a, p, live);
      if (b) printSide('B', b, p, live);
      if (p.proposed_content) console.log(`  proposed: ${p.proposed_content}`);
      return;
    }
    case 'undated':
    case 'stale': {
      const id = p.target_entry_id ?? p.entry_ids[0];
      if (id) printSide('entry', id, p, live);
      if (p.proposed_content) console.log(`  proposed: ${p.proposed_content}`);
      return;
    }
    default: {
      const _never: never = p.kind;
      throw new Error(`Unhandled proposal kind: ${String(_never)}`);
    }
  }
}

function printSide(
  label: string,
  id: string,
  p: ReviewProposal,
  live: Map<string, MemoryEntry>,
): void {
  const entry = live.get(id);
  const quote = p.quotes.find((q) => q.entry_id === id)?.quote;
  console.log(`  ${label} ${id.slice(0, 8)}`);
  if (entry) console.log(`    vault: ${entry.content}`);
  else console.log('    vault: (not in this vault)');
  if (quote) console.log(`    quote: ${quote}`);
}
