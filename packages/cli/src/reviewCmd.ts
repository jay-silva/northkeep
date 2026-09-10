import { randomUUID } from 'node:crypto';
import type { MemoryEntry, Vault } from '@northkeep/core';
import {
  EMBED_MODEL, applyReviewAction, assembleReviewReport, assertReportVault,
  createOllamaClient, hasOllamaModel, loadReviewReport, operationFingerprint,
  proposalFingerprint, reconcileReviewOperations, recordReviewDecision,
  rejectRemaining, resolveReviewModel, runReviewPass, saveReviewReport,
  selectReviewEntries, type ReviewProposal, type ReviewReport,
} from '@northkeep/librarian';

export type WithVault = <T>(fn: (vault: Vault) => Promise<T> | T) => Promise<T>;
export interface ReviewBinding { reportId: string; fingerprint: string; operationId?: string }

export async function reviewRun(withVault: WithVault, vaultPath: string): Promise<void> {
  let snapshot: MemoryEntry[] = [];
  let vaultId = '';
  let startingReportId: string | null = null;
  await withVault((vault) => {
    const previous = loadReviewReport(vaultPath);
    if (previous?.schema === 'northkeep-review-report/2') {
      assertReportVault(previous, vaultPath, vault.getVaultId());
      reconcileReviewOperations(vault, previous, vaultPath);
      startingReportId = previous.report_id;
    }
    snapshot = vault.list();
    vaultId = vault.getVaultId();
  });

  const entries = selectReviewEntries(snapshot);
  const startedAt = new Date().toISOString();
  const model = await resolveReviewModel();
  const ollama = createOllamaClient();
  let embed: ((text: string) => Promise<ArrayLike<number>>) | undefined;
  if (await hasOllamaModel(EMBED_MODEL)) {
    const cache = new Map<string, number[]>();
    embed = async (text) => {
      const hit = cache.get(text);
      if (hit) return hit;
      const vector = await ollama.embed(text);
      cache.set(text, vector);
      return vector;
    };
  }
  const result = await runReviewPass(entries, ollama, {
    model, embed, onStatus: (message) => console.log(message),
  });

  let report!: ReviewReport;
  await withVault((vault) => {
    if (vault.getVaultId() !== vaultId) throw new Error('The unlocked vault changed during review.');
    const current = selectReviewEntries(vault.list());
    if (operationFingerprint(current) !== operationFingerprint(entries)) {
      throw new Error('The vault changed during review. Run review again.');
    }
    const previous = loadReviewReport(vaultPath);
    if (previous?.schema === 'northkeep-review-report/2') {
      assertReportVault(previous, vaultPath, vaultId);
      reconcileReviewOperations(vault, previous, vaultPath);
    }
    const currentId = previous?.schema === 'northkeep-review-report/2' ? previous.report_id : null;
    if (currentId !== startingReportId) throw new Error('A newer review report exists. Refusing to overwrite it.');
    report = assembleReviewReport({
      model: result.model, started_at: startedAt, finished_at: new Date().toISOString(),
      entry_count: entries.length, drops: result.drops, proposals: result.proposals,
      previous, vault_id: vaultId, vault_path: vaultPath,
      selected_scopes: [...new Set(entries.map((entry) => entry.scope))],
      source_entries: entries, coverage: result.coverage,
    });
    saveReviewReport(report, vaultPath);
  });

  console.log(`Review pass ${report.report_id} finished. Model: ${report.model}.`);
  printCoverage(report);
  const pending = report.proposals.filter((proposal) => proposal.status === 'pending').length;
  console.log(`${report.proposals.length} proposals (${pending} pending; ${result.batches} batches).`);
  const excluded = Object.values(report.drops).reduce((sum, count) => sum + count, 0);
  if (excluded) console.log(`Excluded ${excluded} invalid or unsupported findings.`);
  console.log('Inspect with: northkeep review show');
  console.log('Nothing was written to the vault.');
}

export async function reviewShow(withVault: WithVault, vaultPath: string): Promise<void> {
  let report: ReviewReport | null = null;
  let live = new Map<string, MemoryEntry>();
  await withVault((vault) => {
    const loaded = loadReviewReport(vaultPath);
    if (loaded === null) return;
    if (loaded.schema !== 'northkeep-review-report/2') throw new Error('This report is read-only. Run a fresh review.');
    assertReportVault(loaded, vaultPath, vault.getVaultId());
    reconcileReviewOperations(vault, loaded, vaultPath);
    report = loaded;
    live = new Map(vault.list({ includeForgotten: true, includeSuperseded: true })
      .map((entry) => [entry.id, entry]));
  });
  if (report === null) {
    console.log('No review pass report yet. Run: northkeep review run');
    return;
  }
  printReport(report, live);
}

export async function reviewAccept(id: string, binding: ReviewBinding, withVault: WithVault, vaultPath: string): Promise<void> {
  await withVault((vault) => {
    const { report, proposal } = requireBound(vault, vaultPath, id, binding);
    const receipt = applyReviewAction(vault, report, vaultPath, vault.getVaultId(), id, 'accept', {
      report_id: binding.reportId, proposal_fingerprint: binding.fingerprint,
      operation_id: binding.operationId ?? randomUUID(),
      content: proposal.proposed_content ?? undefined,
    });
    console.log(`Accepted ${id}. Receipt ${receipt.receipt_id}. Previous content remains in history.`);
  });
}

export async function reviewReject(id: string, binding: ReviewBinding, withVault: WithVault, vaultPath: string): Promise<void> {
  await decide('reject', id, undefined, binding, withVault, vaultPath);
}

export async function reviewKeep(id: string, entryId: string, binding: ReviewBinding, withVault: WithVault, vaultPath: string): Promise<void> {
  await decide('keep', id, entryId, binding, withVault, vaultPath);
}

export async function reviewForget(id: string, entryId: string, survivorId: string, binding: ReviewBinding, withVault: WithVault, vaultPath: string): Promise<void> {
  await withVault((vault) => {
    const { report } = requireBound(vault, vaultPath, id, binding);
    const receipt = applyReviewAction(vault, report, vaultPath, vault.getVaultId(), id, 'forget', {
      report_id: binding.reportId, proposal_fingerprint: binding.fingerprint,
      operation_id: binding.operationId ?? randomUUID(), entry_id: entryId, survivor_id: survivorId,
    });
    console.log(`Forgot ${entryId}; survivor ${survivorId}. Receipt ${receipt.receipt_id}.`);
  });
}

export async function reviewRejectRemaining(reportId: string, withVault: WithVault, vaultPath: string): Promise<void> {
  await withVault((vault) => {
    const report = requireReport(vault, vaultPath);
    if (report.report_id !== reportId) throw new Error('Report id does not match the current review.');
    const count = rejectRemaining(report);
    saveReviewReport(report, vaultPath);
    console.log(`Dismissed ${count} pending proposals. Vault untouched.`);
  });
}

async function decide(action: 'reject' | 'keep', id: string, entryId: string | undefined, binding: ReviewBinding, withVault: WithVault, vaultPath: string): Promise<void> {
  await withVault((vault) => {
    const { report } = requireBound(vault, vaultPath, id, binding);
    const receipt = recordReviewDecision(vault, report, vaultPath, vault.getVaultId(), id, action, {
      report_id: binding.reportId, proposal_fingerprint: binding.fingerprint,
      operation_id: binding.operationId ?? randomUUID(), entry_id: entryId,
    });
    console.log(`${action === 'keep' ? `Kept ${entryId}` : `Rejected ${id}`}. Receipt ${receipt.receipt_id}. Vault untouched.`);
  });
}

function requireReport(vault: Vault, vaultPath: string): ReviewReport {
  const report = loadReviewReport(vaultPath);
  if (report === null) throw new Error('No review pass report yet. Run: northkeep review run');
  if (report.schema !== 'northkeep-review-report/2') throw new Error('This report is read-only. Run a fresh review.');
  assertReportVault(report, vaultPath, vault.getVaultId());
  reconcileReviewOperations(vault, report, vaultPath);
  return report;
}

function requireBound(vault: Vault, vaultPath: string, id: string, binding: ReviewBinding): { report: ReviewReport; proposal: ReviewProposal } {
  const report = requireReport(vault, vaultPath);
  if (report.report_id !== binding.reportId) throw new Error('Report id does not match the current review.');
  const proposal = report.proposals.find((candidate) => candidate.id === id);
  if (!proposal) throw new Error('Use the full 8-character proposal id.');
  if (proposalFingerprint(proposal) !== binding.fingerprint) throw new Error('Proposal fingerprint does not match.');
  return { report, proposal };
}

function printCoverage(report: ReviewReport): void {
  console.log(`Coverage: selected ${report.coverage.selected}, compared ${report.coverage.compared}, skipped ${report.coverage.skipped}, failed ${report.coverage.failed}.`);
  if (!report.coverage.complete) console.log('Coverage is incomplete; this report is not exhaustive.');
}

function printReport(report: ReviewReport, live: Map<string, MemoryEntry>): void {
  console.log(`Memory review ${report.report_id}  model ${report.model}  ${report.started_at}`);
  printCoverage(report);
  const pending = report.proposals.filter((proposal) => proposal.status === 'pending');
  console.log(`${pending.length} pending.`);
  for (const proposal of pending) printProposal(proposal, live, report);
}

function printProposal(proposal: ReviewProposal, live: Map<string, MemoryEntry>, report: ReviewReport): void {
  const fingerprint = proposalFingerprint(proposal);
  console.log(`\n[${proposal.id}] ${proposal.kind}`);
  console.log(`  fingerprint ${fingerprint}`);
  if (proposal.explanation) console.log(`  ${proposal.explanation}`);
  for (const id of proposal.entry_ids) {
    const decision = proposal.member_decisions?.[id];
    console.log(`  entry ${id}${decision ? `  ${decision}` : ''}`);
    console.log(`    vault: ${live.get(id)?.content ?? '(not live in this vault)'}`);
    const quote = proposal.quotes.find((candidate) => candidate.entry_id === id)?.quote;
    if (quote) console.log(`    quote: ${quote}`);
  }
  if (proposal.question) console.log(`  question: ${proposal.question}`);
  if (proposal.proposed_content) console.log(`  proposed: ${proposal.proposed_content}`);
  const bind = `--report ${report.report_id} --fingerprint ${fingerprint}`;
  if (proposal.kind === 'duplicate') {
    const [member, survivor] = proposal.entry_ids;
    if (member && survivor) {
      console.log(`  keep: northkeep review keep ${proposal.id} ${survivor} ${bind}`);
      console.log(`  forget: northkeep review forget ${proposal.id} ${member} ${survivor} ${bind}`);
    }
  } else if (proposal.kind !== 'question') {
    console.log(`  accept: northkeep review accept ${proposal.id} ${bind}`);
  }
  console.log(`  reject: northkeep review reject ${proposal.id} ${bind}`);
  console.log('  Add --operation <uuid> only to retry the exact same request.');
}
