/** Local, private review workflow state. See ADR 0046. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProjectScope, northkeepHome, type MemoryEntry } from '@northkeep/core';
import type { ReviewProposal } from './reviewSchema.js';

export const REVIEW_REPORT_SCHEMA = 'northkeep-review-report/2';
export const LEGACY_REVIEW_REPORT_SCHEMA = 'northkeep-review-report/1';
export type ReviewSnapshot = MemoryEntry;

export interface ReviewCoverage {
  selected: number;
  compared: number;
  skipped: number;
  failed: number;
  complete: boolean;
}

export interface ReviewReceipt {
  receipt_id: string;
  operation_id: string;
  request_fingerprint: string;
  proposal_id: string;
  action: 'accept' | 'forget' | 'restore' | 'reject' | 'keep' | 'unresolved';
  status: 'prepared' | 'committed' | 'aborted';
  prepared_at: string;
  committed_at?: string;
  before: ReviewSnapshot[];
  after: ReviewSnapshot[];
  survivor_id?: string;
  restores_receipt_id?: string;
  proposal_before?: {
    status: ReviewProposal['status'];
    member_decisions?: ReviewProposal['member_decisions'];
  };
}

export interface ReviewReport {
  schema: typeof REVIEW_REPORT_SCHEMA;
  report_id: string;
  vault_id: string;
  vault_path_hash: string;
  model: string;
  started_at: string;
  finished_at?: string;
  entry_count: number;
  selected_scopes: string[];
  source_entries: ReviewSnapshot[];
  coverage: ReviewCoverage;
  drops: Record<string, number>;
  proposals: ReviewProposal[];
  rejected_fingerprints: string[];
  operations: ReviewReceipt[];
  sent_to?: { label: string; host: string; endpoint_id?: string; model?: string };
}

export interface LegacyReviewReport {
  schema: typeof LEGACY_REVIEW_REPORT_SCHEMA;
  model: string;
  started_at: string;
  finished_at?: string;
  entry_count: number;
  drops: Record<string, number>;
  proposals: ReviewProposal[];
  rejected_fingerprints: string[];
  sent_to?: { label: string; host: string };
}

interface AssembleInput {
  model: string;
  started_at: string;
  finished_at?: string;
  entry_count: number;
  drops: Record<string, number>;
  proposals: ReviewProposal[];
  previous?: ReviewReport | LegacyReviewReport | null;
  sent_to?: ReviewReport['sent_to'];
  vault_id: string;
  vault_path: string;
  selected_scopes?: string[];
  source_entries?: ReviewSnapshot[];
  coverage?: ReviewCoverage;
}

const HASH = /^[0-9a-f]{64}$/;
const PROPOSAL_ID = /^[0-9a-f]{8}$/;
const memoryTypes = new Set(['episodic', 'semantic', 'procedural', 'working', 'identity']);
const proposalKinds = new Set(['duplicate', 'contradiction', 'undated', 'stale', 'question']);
const proposalStatuses = new Set(['pending', 'accepted', 'rejected', 'resolved']);
const memberDecisions = new Set(['pending', 'kept', 'forgotten']);
const actions = new Set(['accept', 'forget', 'restore', 'reject', 'keep', 'unresolved']);

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string =>
  string(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const iso = (value: unknown): value is string => {
  if (!string(value)) return false;
  const millis = Date.parse(value);
  return !Number.isNaN(millis) && new Date(millis).toISOString() === value;
};
const unique = (values: string[]): boolean => new Set(values).size === values.length;

function plainJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || string(value) || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((child) => plainJson(child, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((child) => plainJson(child, seen));
  seen.delete(value);
  return valid;
}

function record(value: unknown, validate: (child: unknown) => boolean): boolean {
  return object(value) && Object.entries(value).every(([key, child]) => key.length > 0 && validate(child));
}

export function reviewReportPath(vaultPath?: string): string {
  const name = vaultPath
    ? `review-report-${hash(path.resolve(vaultPath))}.json`
    : 'review-report.json';
  return path.join(northkeepHome(), name);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) {
    const fields = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function proposalFingerprint(
  proposal: Pick<ReviewProposal, 'kind' | 'entry_ids' | 'proposed_content' | 'quotes' | 'target_entry_id' | 'question'>,
): string {
  return hash(canonical({
    kind: proposal.kind,
    entry_ids: [...proposal.entry_ids].sort(),
    proposed_content: proposal.proposed_content,
    question: proposal.question ?? null,
    quotes: [...proposal.quotes].sort((a, b) => a.entry_id.localeCompare(b.entry_id)),
    target_entry_id: proposal.target_entry_id,
  }));
}

export function operationFingerprint(value: unknown): string {
  return hash(canonical(value));
}

function snapshot(value: unknown): value is ReviewSnapshot {
  if (!object(value)) return false;
  return uuid(value.id) && string(value.content) && string(value.scope) &&
    memoryTypes.has(String(value.type)) && string(value.source) && iso(value.created_at) &&
    HASH.test(String(value.prev_hash)) && HASH.test(String(value.entry_hash)) &&
    typeof value.confidence === 'number' && Number.isFinite(value.confidence) &&
    value.confidence >= 0 && value.confidence <= 1 &&
    (value.source_model === null || string(value.source_model)) &&
    (value.valid_from === null || iso(value.valid_from)) &&
    (value.superseded_at === null || iso(value.superseded_at)) &&
    (value.superseded_by === null || uuid(value.superseded_by)) &&
    (value.forgotten_at === null || iso(value.forgotten_at)) &&
    (value.metadata === null || (object(value.metadata) && plainJson(value.metadata)));
}

function proposal(value: unknown, sources?: Map<string, ReviewSnapshot>): value is ReviewProposal {
  if (!object(value) || !string(value.id) || !PROPOSAL_ID.test(value.id) ||
      !string(value.kind) || !proposalKinds.has(value.kind) ||
      !Array.isArray(value.entry_ids) || value.entry_ids.length === 0 ||
      !value.entry_ids.every(uuid) || !unique(value.entry_ids) ||
      !Array.isArray(value.quotes) || value.quotes.length === 0 ||
      !string(value.explanation) ||
      !(value.target_entry_id === null || uuid(value.target_entry_id)) ||
      !(value.proposed_content === null || string(value.proposed_content)) ||
      !(value.question === undefined || value.question === null || string(value.question)) ||
      !string(value.status) || !proposalStatuses.has(value.status)) return false;

  const ids = new Set(value.entry_ids);
  if (sources && value.entry_ids.some((id) => !sources.has(id))) return false;
  if (!value.quotes.every((item) => {
    if (!object(item) || !uuid(item.entry_id) || !string(item.quote) || item.quote.length === 0) return false;
    const source = sources?.get(item.entry_id);
    return ids.has(item.entry_id) && (!sources || (!!source && source.content.includes(item.quote)));
  })) return false;
  const quotedIds = new Set(value.quotes.map((item) => item.entry_id));
  if (sources) {
    const entries = value.entry_ids.map((id) => sources.get(id)!);
    if (entries.some((entry) => entry.scope !== entries[0]!.scope || entry.type !== entries[0]!.type)) return false;
    if ((value.kind === 'duplicate' || value.kind === 'question') && quotedIds.size < 2) return false;
  }
  if (value.target_entry_id !== null &&
      (!ids.has(value.target_entry_id) || !value.quotes.some((item) => item.entry_id === value.target_entry_id))) return false;
  if (value.member_decisions !== undefined) {
    const decisions = value.member_decisions;
    if (!object(decisions) ||
        !Object.values(decisions).every((item) => memberDecisions.has(String(item)))) return false;
    if (Object.keys(decisions).some((id) => !ids.has(id))) return false;
  }
  return true;
}

function proposalBefore(value: unknown): boolean {
  if (!object(value) || !string(value.status) || !proposalStatuses.has(value.status)) return false;
  if (value.member_decisions === undefined) return true;
  const decisions = value.member_decisions;
  return object(decisions) &&
    Object.values(decisions).every((item) => memberDecisions.has(String(item))) &&
    Object.keys(decisions).every(uuid);
}

function receipt(value: unknown): value is ReviewReceipt {
  if (!object(value) || !uuid(value.receipt_id) || !uuid(value.operation_id) ||
      !string(value.request_fingerprint) || !HASH.test(value.request_fingerprint) ||
      !string(value.proposal_id) || !PROPOSAL_ID.test(value.proposal_id) ||
      !string(value.action) || !actions.has(value.action) ||
      !['prepared', 'committed', 'aborted'].includes(String(value.status)) || !iso(value.prepared_at) ||
      !(value.committed_at === undefined || iso(value.committed_at)) ||
      !Array.isArray(value.before) || !value.before.every(snapshot) ||
      !unique(value.before.map((entry) => entry.id)) ||
      !Array.isArray(value.after) || !value.after.every(snapshot) ||
      !unique(value.after.map((entry) => entry.id)) ||
      !(value.survivor_id === undefined || uuid(value.survivor_id)) ||
      !(value.restores_receipt_id === undefined || uuid(value.restores_receipt_id)) ||
      !(value.proposal_before === undefined || proposalBefore(value.proposal_before))) return false;

  if ((value.status === 'committed') !== (value.committed_at !== undefined)) return false;
  if (value.committed_at !== undefined && Date.parse(value.committed_at) < Date.parse(value.prepared_at)) return false;
  const mutation = ['accept', 'forget', 'restore'].includes(value.action);
  if (mutation && (value.before.length === 0 || value.after.length === 0)) return false;
  if (!mutation && (value.before.length !== 0 || value.after.length !== 0)) return false;
  if (value.action === 'accept' && (value.before.length !== 1 || value.after.length !== 2)) return false;
  if (value.action === 'forget' && (value.before.length !== 1 || value.after.length !== 1)) return false;
  if (value.action === 'restore' && value.before.length !== 1) return false;
  if ((value.action === 'accept' || value.action === 'forget') && value.proposal_before === undefined) return false;
  // Only a forget receipt may name a survivor, and it need not: "Remove all"
  // forgets every member of a group, so the last removal has no survivor.
  if (value.survivor_id !== undefined && value.action !== 'forget') return false;
  if ((value.action === 'restore') !== (value.restores_receipt_id !== undefined)) return false;
  return value.survivor_id === undefined || value.survivor_id !== value.before[0]?.id;
}

function sameSnapshot(left: ReviewSnapshot, right: ReviewSnapshot): boolean {
  return operationFingerprint(left) === operationFingerprint(right);
}

function validAcceptLineage(item: ReviewReceipt): boolean {
  const before = item.before[0]!, oldAfter = item.after.find((entry) => entry.id === before.id);
  const newHead = item.after.find((entry) => entry.id !== before.id);
  return !!oldAfter && !!newHead && oldAfter.superseded_by === newHead.id &&
    oldAfter.superseded_at !== null && newHead.superseded_at === null &&
    newHead.superseded_by === null && newHead.forgotten_at === null &&
    newHead.scope === before.scope && newHead.type === before.type;
}

function validForgetLineage(item: ReviewReceipt): boolean {
  const before = item.before[0]!, after = item.after[0]!;
  return after.id === before.id && after.content === '' && after.forgotten_at !== null;
}

function validRestoreLineage(item: ReviewReceipt, source: ReviewReceipt): boolean {
  const sourceHead = source.after.find((entry) =>
    source.action === 'accept' ? entry.id !== source.before[0]!.id && entry.superseded_at === null : entry.id === source.before[0]!.id,
  );
  if (!sourceHead || !sameSnapshot(item.before[0]!, sourceHead)) return false;
  if (source.action === 'accept') {
    if (!validAcceptLineage(item)) return false;
    const restored = item.after.find((entry) => entry.id !== item.before[0]!.id)!;
    const original = source.before[0]!;
    return restored.content === original.content && restored.scope === original.scope && restored.type === original.type;
  }
  const restored = item.after[0]!;
  const original = source.before[0]!;
  return restored.id !== original.id && restored.content === original.content &&
    restored.scope === original.scope && restored.type === original.type &&
    restored.superseded_at === null && restored.forgotten_at === null;
}

function coverage(value: unknown): value is ReviewCoverage {
  return object(value) && count(value.selected) && count(value.compared) &&
    count(value.skipped) && count(value.failed) && typeof value.complete === 'boolean' &&
    value.compared + value.skipped + value.failed <= value.selected &&
    (!value.complete || (value.compared === value.selected && value.skipped === 0 && value.failed === 0));
}

function sentTo(value: unknown, legacy: boolean): boolean {
  return object(value) && string(value.label) && string(value.host) && (legacy ||
    ((value.endpoint_id === undefined || string(value.endpoint_id)) &&
      (value.model === undefined || string(value.model))));
}

function strictV2(value: unknown): value is ReviewReport {
  if (!object(value) || value.schema !== REVIEW_REPORT_SCHEMA ||
      !Array.isArray(value.source_entries) || !value.source_entries.every(snapshot) ||
      !unique(value.source_entries.map((entry) => entry.id))) return false;
  if (!Array.isArray(value.selected_scopes) || !value.selected_scopes.every(string) ||
      !unique(value.selected_scopes) || value.selected_scopes.some(isProjectScope)) return false;
  const selectedScopes = value.selected_scopes as string[];
  const sources = new Map(value.source_entries.map((entry) => [entry.id, entry]));
  if (!Array.isArray(value.proposals) || !value.proposals.every((item) => proposal(item, sources)) ||
      !unique(value.proposals.map((item) => item.id))) return false;
  if (!Array.isArray(value.operations) || !value.operations.every(receipt) ||
      !unique(value.operations.map((item) => item.receipt_id)) ||
      !unique(value.operations.map((item) => item.operation_id))) return false;
  const operations = value.operations as ReviewReceipt[];
  if (operations.some((item) => item.action === 'accept' && !validAcceptLineage(item))) return false;
  if (operations.some((item) => item.action === 'forget' && !validForgetLineage(item))) return false;
  if (operations.some((item, index) => {
    if (!item.restores_receipt_id) return false;
    const source = operations.slice(0, index).find((candidate) => candidate.receipt_id === item.restores_receipt_id);
    if (!source || source.status !== 'committed' || !['accept', 'forget'].includes(source.action)) return true;
    return !validRestoreLineage(item, source);
  })) return false;

  return uuid(value.report_id) && uuid(value.vault_id) && string(value.vault_path_hash) &&
    HASH.test(value.vault_path_hash) && string(value.model) && iso(value.started_at) &&
    (value.finished_at === undefined || iso(value.finished_at)) && count(value.entry_count) &&
    value.source_entries.every((entry) => entry.forgotten_at === null && entry.superseded_at === null &&
      selectedScopes.includes(entry.scope)) &&
    value.entry_count === value.source_entries.length && coverage(value.coverage) &&
    value.coverage.selected === value.source_entries.length && record(value.drops, count) &&
    Array.isArray(value.rejected_fingerprints) &&
    value.rejected_fingerprints.every((item) => string(item) && HASH.test(item)) &&
    unique(value.rejected_fingerprints) &&
    (value.sent_to === undefined || sentTo(value.sent_to, false));
}

function legacy(value: unknown): value is LegacyReviewReport {
  return object(value) && value.schema === LEGACY_REVIEW_REPORT_SCHEMA && string(value.model) &&
    iso(value.started_at) && (value.finished_at === undefined || iso(value.finished_at)) &&
    count(value.entry_count) && record(value.drops, count) && Array.isArray(value.proposals) &&
    value.proposals.every((item) => proposal(item)) && unique(value.proposals.map((item) => item.id)) &&
    Array.isArray(value.rejected_fingerprints) &&
    value.rejected_fingerprints.every((item) => string(item) && HASH.test(item)) &&
    unique(value.rejected_fingerprints) && (value.sent_to === undefined || sentTo(value.sent_to, true));
}

export function loadReviewReport(vaultPath?: string): ReviewReport | LegacyReviewReport | null {
  const filename = reviewReportPath(vaultPath);
  if (!fs.existsSync(filename)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw new Error('Review report is corrupt; refusing to replace workflow state.');
  }
  if (strictV2(parsed)) return parsed;
  if (vaultPath === undefined && legacy(parsed)) return parsed;
  throw new Error('Review report failed strict validation; refusing to replace workflow state.');
}

export function saveReviewReport(report: ReviewReport | LegacyReviewReport, vaultPath?: string): void {
  const valid = report.schema === REVIEW_REPORT_SCHEMA ? strictV2(report) : legacy(report);
  if (!valid || (report.schema === LEGACY_REVIEW_REPORT_SCHEMA && vaultPath !== undefined)) {
    throw new Error('Review report failed strict validation; refusing to save workflow state.');
  }
  const filename = reviewReportPath(vaultPath);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    const directoryDescriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(String(code))) throw error;
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

export function assembleReviewReport(input: AssembleInput): ReviewReport {
  const vaultPathHash = hash(path.resolve(input.vault_path));
  if (input.previous?.schema === REVIEW_REPORT_SCHEMA) {
    if (input.previous.vault_id !== input.vault_id || input.previous.vault_path_hash !== vaultPathHash) {
      throw new Error('Previous review report belongs to a different vault.');
    }
    if (input.previous.operations.some((item) => item.status === 'prepared')) {
      throw new Error('Reconcile the prepared review operation before starting another review.');
    }
  }
  const rejected = [...(input.previous?.rejected_fingerprints ?? [])];
  const hidden = new Set(rejected);
  const drops = { ...input.drops };
  const proposals = input.proposals.filter((item) => {
    if (!hidden.has(proposalFingerprint(item))) return true;
    drops.rejected_fingerprint = (drops.rejected_fingerprint ?? 0) + 1;
    return false;
  });
  const sourceEntries = input.source_entries ?? [];
  const report: ReviewReport = {
    schema: REVIEW_REPORT_SCHEMA,
    report_id: randomUUID(),
    vault_id: input.vault_id,
    vault_path_hash: vaultPathHash,
    model: input.model,
    started_at: input.started_at,
    finished_at: input.finished_at,
    entry_count: input.entry_count,
    selected_scopes: [...(input.selected_scopes ?? [])].sort(),
    source_entries: sourceEntries,
    coverage: input.coverage ?? { selected: sourceEntries.length, compared: sourceEntries.length, skipped: 0, failed: 0, complete: true },
    drops,
    proposals,
    rejected_fingerprints: rejected,
    operations: input.previous?.schema === REVIEW_REPORT_SCHEMA ? [...input.previous.operations] : [],
    sent_to: input.sent_to,
  };
  if (!strictV2(report)) throw new Error('Review report failed strict validation; refusing to assemble workflow state.');
  return report;
}

export function assertReportVault(report: ReviewReport, vaultPath: string, vaultId: string): void {
  if (report.vault_id !== vaultId || report.vault_path_hash !== hash(path.resolve(vaultPath))) {
    throw new Error('Review report belongs to a different vault.');
  }
}

export function findProposal(report: ReviewReport | LegacyReviewReport, id: string): ReviewProposal {
  if (report.schema !== REVIEW_REPORT_SCHEMA) {
    throw new Error('This report is read-only. Run a fresh review before making changes.');
  }
  const matches = report.proposals.filter((item) => item.id === id);
  if (matches.length !== 1) throw new Error(`No review proposal matching "${id}".`);
  return matches[0]!;
}
