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

/**
 * Every label a NorthKeep placeholder can carry: the Tier-1 secret kinds, the
 * name kinds (and the Place prefix Tier 2 prints), dates, and the generic
 * REDACTED. A redact test checks this list covers every kind it emits.
 */
export const PLACEHOLDER_LABELS: readonly string[] = [
  'EMAIL', 'PHONE', 'SSN', 'CREDIT_CARD', 'IP', 'API_KEY', 'IBAN', 'RECORD_ID', 'GPS', 'ZIP', 'ADDRESS',
  'PERSON', 'ORG', 'LOCATION', 'PLACE', 'DATE', 'REDACTED',
];

const INDEXED_LABELS = PLACEHOLDER_LABELS.filter((l) => l !== 'REDACTED').join('|');
/**
 * Only the shapes the redactor or a session emits, and their mis-copies,
 * case-insensitive:
 * - a label from the list followed by an underscore index, in any brackets
 *   or none, with or without a tag (`[DATE_1948_1]`, `EMAIL_1`, `<EMAIL_1>`,
 *   `[k7q2 EMAIL_1]`, `[k7q2:email_1]`);
 * - `[DATE]`, `[DATE-1948]` and `[REDACTED]` in brackets;
 * - `Person-3`, `Org-2`, `Place-4`, `Location-1`.
 * A label with no index is prose: "(email)", "(ZIP 02532)", "ip-10-0-0-12".
 */
const PLACEHOLDER_SHAPE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:[a-z0-9]{4}[:\\uFF1A\\s])?(?:${INDEXED_LABELS})(?:_\\d+)+(?![\\p{L}\\p{N}])` +
    `|[\\[<{(\\uFF3B\\u3010]\\s*(?:DATE(?:-\\d{4})?|REDACTED)\\s*[\\]>})\\uFF3D\\u3011]` +
    `|(?<![\\p{L}\\p{N}_])(?:Person|Org|Place|Location)-\\d+(?![\\p{L}\\p{N}])`,
  'giu',
);

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
    for (const m of piece.text.matchAll(PLACEHOLDER_SHAPE)) {
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
    const validated = new Set<string>();
    if (Array.isArray(rec.quotes)) {
      rec.quotes = rec.quotes.map((q) => {
        if (q === null || typeof q !== 'object') return q;
        const quote = q as { entry_id?: unknown; quote?: unknown };
        if (typeof quote.entry_id !== 'string' || typeof quote.quote !== 'string') return q;
        const entry = byId.get(quote.entry_id);
        if (!entry) return q;
        const span = matchQuote(quote.quote, entry.content, handle);
        if (span === null || span.trim().length === 0) return q;
        validated.add(entry.id);
        return { ...quote, quote: span };
      });
    }
    if (typeof rec.proposed_content === 'string' && rec.proposed_content.length > 0) {
      // Cited means BOTH listed in entry_ids AND quoted with a validated quote
      // (code review F1, recheck): a quote from a memory the proposal does not
      // list would be hidden from the report while its value is spliced in.
      const listed = new Set<string>(
        Array.isArray(rec.entry_ids) ? rec.entry_ids.filter((id): id is string => typeof id === 'string') : [],
      );
      const ids = new Set<string>([...validated].filter((id) => listed.has(id)));
      const target = typeof rec.target_entry_id === 'string' && ids.has(rec.target_entry_id) ? byId.get(rec.target_entry_id) : undefined;
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
