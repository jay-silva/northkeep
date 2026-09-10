/**
 * Memory review pass report schema (ADR 0043). Pure validation: no I/O, no Vault.
 * The model returns raw proposals; we assign ids and drop anything that fails
 * the substring / live-id checks. Unknown fields including auto_apply are discarded.
 */
import { createHash } from 'node:crypto';
import type { MemoryEntry } from '@northkeep/core';

export const REVIEW_KINDS = ['duplicate', 'contradiction', 'undated', 'stale', 'question'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'resolved';
export type MemberDecision = 'pending' | 'kept' | 'forgotten';

export interface ReviewQuote {
  entry_id: string;
  quote: string;
}

export interface ReviewProposal {
  id: string;
  kind: ReviewKind;
  entry_ids: string[];
  quotes: ReviewQuote[];
  explanation: string;
  target_entry_id: string | null;
  proposed_content: string | null;
  /** User-facing unresolved question. Never applied as replacement content. */
  question?: string | null;
  member_decisions?: Record<string, MemberDecision>;
  status: ProposalStatus;
}

export interface ValidateResult {
  proposals: ReviewProposal[];
  drops: Record<string, number>;
}

function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

function bump(drops: Record<string, number>, reason: string): void {
  drops[reason] = (drops[reason] ?? 0) + 1;
}

/** Strip a leading UTF-8 BOM, then JSON.parse. Null on failure (including junk). */
export function parseReviewResponse(text: string): unknown | null {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Pull the proposals array out of a parsed model response. A top-level array
 * is accepted; otherwise look at `.proposals`. auto_apply and every other
 * unknown field is ignored (P2).
 */
export function extractRawProposals(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed === null || typeof parsed !== 'object') return null;
  const proposals = (parsed as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposals)) return null;
  return proposals;
}

/** 8 lowercase hex, stable for a seed, unique within `used`. */
export function assignProposalId(used: Set<string>, seed: string): string {
  let n = 0;
  for (;;) {
    const id = createHash('sha256').update(`${seed}:${n}`).digest('hex').slice(0, 8);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    n += 1;
  }
}

function validQuote(
  quote: ReviewQuote,
  byId: Map<string, MemoryEntry>,
  drops: Record<string, number>,
): boolean {
  if (quote.quote.length === 0) {
    bump(drops, 'empty_quote');
    return false;
  }
  const entry = byId.get(quote.entry_id);
  if (entry === undefined) {
    bump(drops, 'dead_id');
    return false;
  }
  // Exact substring. No trim, case-fold, or normalize (P4).
  if (!entry.content.includes(quote.quote)) {
    bump(drops, 'fabricated_quote');
    return false;
  }
  return true;
}

function readQuotes(raw: unknown): ReviewQuote[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewQuote[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as { entry_id?: unknown; quote?: unknown };
    if (typeof rec.entry_id !== 'string' || typeof rec.quote !== 'string') continue;
    out.push({ entry_id: rec.entry_id, quote: rec.quote });
  }
  return out;
}

function readStringIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export interface ValidateProposalsOptions {
  /** When false (default), undated proposals are dropped. Kind stays in the union. */
  includeUndated?: boolean;
}

/**
 * Validate raw model proposals against a live snapshot. Invalid proposals are
 * dropped and counted by reason. Assigned ids are 8 lowercase hex.
 */
export function validateProposals(
  raw: unknown,
  entries: MemoryEntry[],
  opts?: ValidateProposalsOptions,
): ValidateResult {
  const drops: Record<string, number> = {};
  const list = extractRawProposals(raw);
  if (list === null) {
    bump(drops, 'malformed');
    return { proposals: [], drops };
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const usedIds = new Set<string>();
  const proposals: ReviewProposal[] = [];
  const includeUndated = opts?.includeUndated === true;

  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      bump(drops, 'malformed');
      continue;
    }
    const rec = item as {
      kind?: unknown;
      entry_ids?: unknown;
      quotes?: unknown;
      explanation?: unknown;
      target_entry_id?: unknown;
      proposed_content?: unknown;
      question?: unknown;
    };
    if (typeof rec.kind !== 'string' || !isReviewKind(rec.kind)) {
      bump(drops, 'unknown_kind');
      continue;
    }
    const kind: ReviewKind = rec.kind;
    if (kind === 'undated' && !includeUndated) {
      bump(drops, 'undated_disabled');
      continue;
    }
    const entryIds = readStringIds(rec.entry_ids);
    const quotes = readQuotes(rec.quotes);
    const explanation = typeof rec.explanation === 'string' ? rec.explanation : '';
    const target =
      typeof rec.target_entry_id === 'string' && rec.target_entry_id.length > 0
        ? rec.target_entry_id
        : null;
    const proposed =
      typeof rec.proposed_content === 'string' && rec.proposed_content.length > 0
        ? rec.proposed_content
        : null;
    const question =
      typeof rec.question === 'string' && rec.question.trim().length > 0
        ? rec.question
        : null;

    const cited = new Set<string>([...entryIds, ...quotes.map((q) => q.entry_id)]);
    if (target !== null) cited.add(target);
    let dead = false;
    for (const id of cited) {
      if (!byId.has(id)) {
        bump(drops, 'dead_id');
        dead = true;
        break;
      }
    }
    if (dead) continue;

    const accepted = acceptByKind(kind, {
      entryIds,
      quotes,
      explanation,
      target,
      proposed,
      question,
      byId,
      drops,
      usedIds,
    });
    if (accepted !== null) proposals.push(accepted);
  }

  return { proposals, drops };
}

function acceptByKind(
  kind: ReviewKind,
  ctx: {
    entryIds: string[];
    quotes: ReviewQuote[];
    explanation: string;
    target: string | null;
    proposed: string | null;
    question: string | null;
    byId: Map<string, MemoryEntry>;
    drops: Record<string, number>;
    usedIds: Set<string>;
  },
): ReviewProposal | null {
  const { entryIds, quotes, explanation, target, proposed, question, byId, drops, usedIds } = ctx;
  const goodQuotes = quotes.filter((q) => validQuote(q, byId, drops));

  switch (kind) {
    case 'duplicate': {
      const liveIds = [...new Set(entryIds.filter((id) => byId.has(id)))];
      if (liveIds.length < 2) {
        bump(drops, 'insufficient_duplicate_members');
        return null;
      }
      const quoted = new Set(goodQuotes.map((q) => q.entry_id));
      if (!liveIds.every((id) => quoted.has(id))) {
        // One bad or missing quote drops the whole cluster.
        if (!drops.fabricated_quote && !drops.empty_quote && !drops.dead_id) {
          bump(drops, 'insufficient_duplicate_quotes');
        }
        return null;
      }
      const member_decisions: Record<string, MemberDecision> = {};
      for (const id of liveIds) member_decisions[id] = 'pending';
      return finishProposal(usedIds, {
        kind,
        entry_ids: liveIds,
        quotes: goodQuotes.filter((q) => liveIds.includes(q.entry_id)),
        explanation,
        target_entry_id: null,
        proposed_content: null,
        member_decisions,
        status: 'pending',
      });
    }
    case 'contradiction': {
      const linked = goodQuotes.filter((q, i, arr) => arr.findIndex((x) => x.entry_id === q.entry_id) === i);
      if (linked.length < 2) {
        bump(drops, 'one_sided_contradiction');
        return null;
      }
      if (target === null) {
        bump(drops, 'missing_target');
        return null;
      }
      if (!entryIds.includes(target)) {
        bump(drops, 'target_not_listed');
        return null;
      }
      if (!linked.some((quote) => quote.entry_id === target)) {
        bump(drops, 'missing_target_quote');
        return null;
      }
      if (proposed === null) {
        bump(drops, 'missing_proposed_content');
        return null;
      }
      const ids = [...new Set([...entryIds, ...linked.map((q) => q.entry_id)])];
      return finishProposal(usedIds, {
        kind,
        entry_ids: ids,
        quotes: linked.slice(0, 2),
        explanation,
        target_entry_id: target,
        proposed_content: proposed,
        status: 'pending',
      });
    }
    case 'undated':
    case 'stale': {
      if (goodQuotes.length < 1) {
        bump(drops, 'missing_quote');
        return null;
      }
      if (target === null) {
        bump(drops, 'missing_target');
        return null;
      }
      if (!entryIds.includes(target)) {
        bump(drops, 'target_not_listed');
        return null;
      }
      const targetQuote = goodQuotes.find((quote) => quote.entry_id === target);
      if (targetQuote === undefined) {
        bump(drops, 'missing_target_quote');
        return null;
      }
      if (proposed === null) {
        bump(drops, 'missing_proposed_content');
        return null;
      }
      const ids = [...new Set(entryIds)];
      return finishProposal(usedIds, {
        kind,
        entry_ids: ids,
        quotes: [targetQuote],
        explanation,
        target_entry_id: target,
        proposed_content: proposed,
        status: 'pending',
      });
    }
    case 'question': {
      if (question === null) {
        bump(drops, 'missing_question');
        return null;
      }
      const ids = [...new Set(entryIds)];
      if (ids.length < 2) {
        bump(drops, 'insufficient_question_members');
        return null;
      }
      if (goodQuotes.length < 2) {
        bump(drops, 'missing_quote');
        return null;
      }
      const quotedIds = new Set(goodQuotes.map((quote) => quote.entry_id));
      if (!ids.every((id) => quotedIds.has(id))) {
        bump(drops, 'insufficient_question_quotes');
        return null;
      }
      return finishProposal(usedIds, {
        kind,
        entry_ids: ids,
        quotes: goodQuotes.filter((quote) => ids.includes(quote.entry_id)),
        explanation,
        target_entry_id: null,
        proposed_content: null,
        question,
        status: 'pending',
      });
    }
    default: {
      const _never: never = kind;
      bump(drops, `unhandled_kind:${String(_never)}`);
      return null;
    }
  }
}

export function finishProposal(
  usedIds: Set<string>,
  draft: Omit<ReviewProposal, 'id'>,
): ReviewProposal {
  const seed = `${draft.kind}|${[...draft.entry_ids].sort().join(',')}|${draft.proposed_content ?? ''}|${draft.question ?? ''}|${draft.explanation}`;
  return { id: assignProposalId(usedIds, seed), ...draft };
}
