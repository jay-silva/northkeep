/**
 * Restoring a cloud review's reply (ADR 0060 1.4). The model saw run-tagged
 * tokens (`[k7q2:EMAIL_1]`), never originals. Everything here runs locally.
 *
 * - Only tokens the pack's own masking issued count (F2). Any other token,
 *   including a variant form of the tag, is a forgery.
 * - A quote is kept only as the stored span it matches, so P4 stays
 *   "verbatim in the vault" by construction.
 * - proposed_content (the only field that can become a write) is restored,
 *   Tier-1 values included, and only from originals present in a memory the
 *   proposal cites (uncited_original).
 * Pure data in, data out: librarian does not import the redact package.
 */
import type { MemoryEntry } from '@northkeep/core';
import { extractRawProposals } from './reviewSchema.js';

export interface ReviewTokenInfo {
  original: string;
  /** Person, org and location originals match case-insensitively. */
  nameKind: boolean;
}

/** What a prepared pack exposes to restoration. Built only by the API adapter. */
export interface ReviewPackHandle {
  readonly tag: string;
  /** Tokens this pack's own masking issued (never a scan of the prompt). */
  readonly tokens: ReadonlySet<string>;
  readonly tokenInfo: ReadonlyMap<string, ReviewTokenInfo>;
}

/** Untagged placeholder shapes NorthKeep's layers emit (chat, MCP, old writes). */
const UNTAGGED_PLACEHOLDER = /\[[A-Z][A-Z_]*_\d+\]|\[DATE(?:-\d{4})?\]|(?<![\p{L}\p{N}_])(?:Person|Org|Place|Location)-\d+(?![\p{L}\p{N}_])/gu;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every mention of this run's tag, in any case, with or without brackets. */
function tagMentions(tag: string): RegExp {
  return new RegExp(`\\[?${escapeRegex(tag)}:[A-Za-z0-9_]*\\]?`, 'giu');
}

function caseless(original: string): string {
  let out = '';
  for (const ch of original) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    out += lo !== up && lo.length === 1 && up.length === 1 ? `[${escapeRegex(lo)}${escapeRegex(up)}]` : escapeRegex(ch);
  }
  return out;
}

function originalPattern(info: ReviewTokenInfo): string {
  return info.nameKind ? caseless(info.original) : escapeRegex(info.original);
}

type Piece = { kind: 'text'; text: string } | { kind: 'token'; token: string } | { kind: 'forged'; text: string };

function split(text: string, handle: ReviewPackHandle): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const m of text.matchAll(tagMentions(handle.tag))) {
    if (m.index > cursor) pieces.push({ kind: 'text', text: text.slice(cursor, m.index) });
    pieces.push(handle.tokens.has(m[0]) ? { kind: 'token', token: m[0] } : { kind: 'forged', text: m[0] });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) pieces.push({ kind: 'text', text: text.slice(cursor) });
  return pieces;
}

/** The stored span a quote matches, or null. A forged token never matches. */
export function matchQuote(quote: string, stored: string, handle: ReviewPackHandle): string | null {
  const pieces = split(quote, handle);
  if (pieces.some((p) => p.kind === 'forged')) return null;
  if (!pieces.some((p) => p.kind === 'token')) return stored.includes(quote) ? quote : null;
  const pattern = pieces
    .map((p) => (p.kind === 'token' ? `(?:${originalPattern(handle.tokenInfo.get(p.token)!)})` : escapeRegex((p as { text: string }).text)))
    .join('');
  const m = new RegExp(pattern, 'u').exec(stored);
  return m ? m[0] : null;
}

/** The form of an original as a cited memory stores it, or null when no cited memory holds it. */
function surfaceIn(info: ReviewTokenInfo, cited: MemoryEntry[]): string | null {
  for (const entry of cited) {
    if (info.nameKind) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${caseless(info.original)}(?![\\p{L}\\p{N}_])`, 'u');
      const m = re.exec(entry.content) ?? new RegExp(caseless(info.original), 'u').exec(entry.content);
      if (m) return m[0];
    } else if (entry.content.includes(info.original)) {
      return info.original;
    }
  }
  return null;
}

export type ProposedRestore = { ok: true; text: string } | { ok: false; reason: 'foreign_placeholder' | 'uncited_original' | 'unmapped_placeholder' };

/**
 * Restore suggested replacement text. `cited` puts the target entry first, so a
 * name takes the target's stored spelling.
 */
export function restoreProposed(text: string, cited: MemoryEntry[], handle: ReviewPackHandle): ProposedRestore {
  const pieces = split(text, handle);
  if (pieces.some((p) => p.kind === 'forged')) return { ok: false, reason: 'foreign_placeholder' };
  for (const piece of pieces) {
    if (piece.kind !== 'text') continue;
    for (const m of piece.text.matchAll(UNTAGGED_PLACEHOLDER)) {
      if (!cited.some((entry) => entry.content.includes(m[0]))) return { ok: false, reason: 'unmapped_placeholder' };
    }
  }
  let out = '';
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      out += piece.text;
      continue;
    }
    const token = (piece as { token: string }).token;
    const surface = surfaceIn(handle.tokenInfo.get(token)!, cited);
    if (surface === null) return { ok: false, reason: 'uncited_original' };
    out += surface;
  }
  return { ok: true, text: out };
}

/** Display-only fields: this pack's tokens are restored, anything else stays visible. */
export function restoreDisplay(text: string, pack: MemoryEntry[], handle: ReviewPackHandle): string {
  return split(text, handle)
    .map((p) => {
      if (p.kind !== 'token') return p.text;
      const info = handle.tokenInfo.get(p.token)!;
      return surfaceIn(info, pack) ?? info.original;
    })
    .join('');
}

function bump(drops: Record<string, number>, reason: string): void {
  drops[reason] = (drops[reason] ?? 0) + 1;
}

/**
 * Rewrite a parsed reply so the ordinary validator sees stored text: quotes
 * become stored spans (or stay as sent and fail as fabricated), proposed
 * content is restored or the proposal is dropped with a named reason.
 */
export function restoreReviewReply(
  parsed: unknown,
  pack: MemoryEntry[],
  handle: ReviewPackHandle,
): { parsed: unknown; drops: Record<string, number> } {
  const drops: Record<string, number> = {};
  const raw = extractRawProposals(parsed);
  if (raw === null) return { parsed, drops };
  const byId = new Map(pack.map((e) => [e.id, e]));
  const kept: unknown[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      kept.push(item);
      continue;
    }
    const rec = { ...(item as Record<string, unknown>) };
    if (Array.isArray(rec.quotes)) {
      rec.quotes = rec.quotes.map((q) => {
        if (q === null || typeof q !== 'object') return q;
        const quote = q as { entry_id?: unknown; quote?: unknown };
        if (typeof quote.entry_id !== 'string' || typeof quote.quote !== 'string') return q;
        const entry = byId.get(quote.entry_id);
        if (!entry) return q;
        const span = matchQuote(quote.quote, entry.content, handle);
        return span === null ? q : { ...quote, quote: span };
      });
    }
    if (typeof rec.proposed_content === 'string' && rec.proposed_content.length > 0) {
      const ids = new Set<string>();
      if (Array.isArray(rec.entry_ids)) for (const id of rec.entry_ids) if (typeof id === 'string') ids.add(id);
      if (Array.isArray(rec.quotes)) {
        for (const q of rec.quotes) {
          const id = (q as { entry_id?: unknown } | null)?.entry_id;
          if (typeof id === 'string') ids.add(id);
        }
      }
      const target = typeof rec.target_entry_id === 'string' ? byId.get(rec.target_entry_id) : undefined;
      const cited = [
        ...(target ? [target] : []),
        ...[...ids].map((id) => byId.get(id)).filter((e): e is MemoryEntry => e !== undefined && e !== target),
      ];
      const restored = restoreProposed(rec.proposed_content, cited, handle);
      if (!restored.ok) {
        bump(drops, restored.reason);
        continue;
      }
      rec.proposed_content = restored.text;
    }
    if (typeof rec.explanation === 'string') rec.explanation = restoreDisplay(rec.explanation, pack, handle);
    if (typeof rec.question === 'string') rec.question = restoreDisplay(rec.question, pack, handle);
    kept.push(rec);
  }
  return { parsed: { proposals: kept }, drops };
}
