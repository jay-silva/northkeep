/**
 * Local review-pass report store (ADR 0043). Not a vault memory. Not synced (P7).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import type { ReviewProposal } from './reviewSchema.js';

export const REVIEW_REPORT_SCHEMA = 'northkeep-review-report/1';

export interface ReviewReport {
  schema: typeof REVIEW_REPORT_SCHEMA;
  model: string;
  started_at: string;
  finished_at?: string;
  entry_count: number;
  drops: Record<string, number>;
  proposals: ReviewProposal[];
  rejected_fingerprints: string[];
  /** Present only on an API review run. Absent means local (P8). */
  sent_to?: { label: string; host: string };
}

export function reviewReportPath(): string {
  return path.join(northkeepHome(), 'review-report.json');
}

export function proposalFingerprint(
  p: Pick<ReviewProposal, 'kind' | 'entry_ids' | 'proposed_content'>,
): string {
  const payload = `${p.kind}\0${[...p.entry_ids].sort().join(',')}\0${p.proposed_content ?? ''}`;
  return createHash('sha256').update(payload).digest('hex');
}

function parseSentTo(raw: unknown): { label: string; host: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.label !== 'string' || typeof o.host !== 'string') return undefined;
  return { label: o.label, host: o.host };
}

export function loadReviewReport(): ReviewReport | null {
  const file = reviewReportPath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewReport>;
    if (parsed.schema !== REVIEW_REPORT_SCHEMA) return null;
    if (!Array.isArray(parsed.proposals) || !Array.isArray(parsed.rejected_fingerprints)) return null;
    const sentTo = parseSentTo(parsed.sent_to);
    const report = parsed as ReviewReport;
    if (sentTo) report.sent_to = sentTo;
    else delete report.sent_to;
    return report;
  } catch {
    return null;
  }
}

export function saveReviewReport(report: ReviewReport): void {
  const file = reviewReportPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort; the tmp create already requested 0600.
  }
}

/**
 * Build a report for a new run. Previously rejected fingerprints are carried
 * forward and matching new proposals are hidden (counted as rejected_fingerprint).
 */
export function assembleReviewReport(input: {
  model: string;
  started_at: string;
  finished_at?: string;
  entry_count: number;
  drops: Record<string, number>;
  proposals: ReviewProposal[];
  previous?: ReviewReport | null;
  sent_to?: { label: string; host: string };
}): ReviewReport {
  const fingerprints = [...(input.previous?.rejected_fingerprints ?? [])];
  const hidden = fingerprints.length > 0 ? new Set(fingerprints) : null;
  const visible: ReviewProposal[] = [];
  const drops = { ...input.drops };
  for (const p of input.proposals) {
    if (hidden !== null && hidden.has(proposalFingerprint(p))) {
      drops.rejected_fingerprint = (drops.rejected_fingerprint ?? 0) + 1;
      continue;
    }
    visible.push(p);
  }
  const report: ReviewReport = {
    schema: REVIEW_REPORT_SCHEMA,
    model: input.model,
    started_at: input.started_at,
    finished_at: input.finished_at,
    entry_count: input.entry_count,
    drops,
    proposals: visible,
    rejected_fingerprints: fingerprints,
  };
  if (input.sent_to) report.sent_to = input.sent_to;
  return report;
}

export function findProposal(report: ReviewReport, proposalId: string): ReviewProposal {
  const needle = proposalId.trim().toLowerCase();
  if (needle.length < 4) {
    throw new Error('Provide at least 4 characters of the proposal id.');
  }
  const matches = report.proposals.filter((p) => p.id === needle || p.id.startsWith(needle));
  if (matches.length === 0) throw new Error(`No review proposal matching "${proposalId}".`);
  if (matches.length > 1) {
    throw new Error(`Proposal id "${proposalId}" is ambiguous.`);
  }
  return matches[0]!;
}
