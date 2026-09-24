import type { OllamaClient } from '@northkeep/librarian';
import { generalizeDates } from './dates.js';
import { redact } from './index.js';
import { applyTier1 } from './tier1.js';
import { boundaryFriendly } from './tier2.js';
import type { PseudonymMap, Replacement, Tier } from './types.js';

/**
 * A redaction session for the cloud memory review (ADR 0060 1.3). Every value
 * masked in one run gets one token in a namespace stored text cannot contain:
 * `[<tag>:EMAIL_1]`, `[<tag>:DATE_1948_2]`, `[<tag>:PERSON_3]`. The tag is
 * redrawn until `[<tag>:` appears in none of the run's stored text.
 *
 * Built on the unchanged layers: redact() finds what to mask, then the
 * session rewrites every masked original in the ORIGINAL text to its token.
 * Literal placeholder-looking text already in a memory is never an original,
 * so it passes through as plain text and can never collide with a token.
 * A masked original that survives the rewrite refuses the run (fail closed).
 */

export interface SessionToken {
  token: string;
  original: string;
  kind: string;
  /** Names match case-insensitively (replayed pseudonyms carry a lowercased original). */
  nameKind: boolean;
}

export interface SessionMaskResult {
  wire: string;
  /** Tokens this call issued or reused: the pack's token set is the union of these. */
  issued: Set<string>;
  tierApplied: Tier;
  degraded: boolean;
}

const NAME_KINDS = new Set(['person', 'org', 'location']);
const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_TAG_DRAWS = 32;

export function randomRunTag(): string {
  // Web Crypto, not node:crypto: this package is also bundled for mobile.
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  let tag = TAG_ALPHABET[bytes[0]! % 26]!;
  for (let i = 1; i < 4; i++) tag += TAG_ALPHABET[bytes[i]! % TAG_ALPHABET.length]!;
  return tag;
}

export class RedactionSession {
  readonly tag: string;
  /** Fresh per run; never shared with chat or MCP. */
  readonly pseudonyms: PseudonymMap = {};
  readonly tokens = new Map<string, SessionToken>();
  private readonly byOriginal = new Map<string, SessionToken>();
  private readonly counters = new Map<string, number>();

  constructor(tag: string) {
    this.tag = tag;
  }

  /** The token for one masked original; the same original always gets the same token. */
  tokenFor(r: Pick<Replacement, 'placeholder' | 'original' | 'kind'>): SessionToken {
    const nameKind = NAME_KINDS.has(r.kind);
    const key = `${r.kind}\u0000${nameKind ? r.original.toLowerCase() : r.original}`;
    const hit = this.byOriginal.get(key);
    if (hit) return hit;
    let label: string;
    if (r.kind === 'date') {
      const year = /^\[DATE-(\d{4})\]$/.exec(r.placeholder)?.[1];
      const counterKey = year ? `DATE_${year}` : 'DATE';
      const n = (this.counters.get(counterKey) ?? 0) + 1;
      this.counters.set(counterKey, n);
      label = `${counterKey}_${n}`;
    } else {
      const base = r.kind.toUpperCase();
      const n = (this.counters.get(base) ?? 0) + 1;
      this.counters.set(base, n);
      label = `${base}_${n}`;
    }
    const token: SessionToken = { token: `[${this.tag}:${label}]`, original: r.original, kind: r.kind, nameKind };
    this.byOriginal.set(key, token);
    this.tokens.set(token.token, token);
    return token;
  }
}

/**
 * Draw a run tag absent from every stored text (compared case-insensitively,
 * because variant forms of the tag are forgeries too). Refuses after 32 draws.
 */
export function createRedactionSession(
  storedTexts: string[],
  drawTag: () => string = randomRunTag,
): RedactionSession {
  const haystack = storedTexts.map((t) => t.toLowerCase());
  for (let i = 0; i < MAX_TAG_DRAWS; i++) {
    const tag = drawTag();
    if (!/^[a-z][a-z0-9]{3}$/.test(tag)) continue;
    const needle = `[${tag}:`;
    if (!haystack.some((t) => t.includes(needle))) return new RedactionSession(tag);
  }
  throw new Error('Could not choose a placeholder prefix that is absent from these memories.');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Span {
  start: number;
  end: number;
  token: SessionToken;
}

function spansFor(text: string, token: SessionToken): Span[] {
  const spans: Span[] = [];
  const original = token.original;
  if (original.length === 0) return spans;
  if (token.nameKind) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(original)}(?![\\p{L}\\p{N}_])`, 'giu');
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, token });
    if (spans.length > 0 || boundaryFriendly(original)) return spans;
    // Non-space-delimited script: substring, over-masking being the safe side.
    const lower = text.toLowerCase();
    const needle = original.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      spans.push({ start: at, end: at + needle.length, token });
    }
    return spans;
  }
  for (let at = text.indexOf(original); at >= 0; at = text.indexOf(original, at + original.length)) {
    spans.push({ start: at, end: at + original.length, token });
  }
  return spans;
}

function containsOriginal(text: string, token: SessionToken): boolean {
  return spansFor(text, token).length > 0;
}

/** Rewrite every occurrence of each masked original in `text` to its token. */
function rewrite(session: RedactionSession, text: string, replacements: Replacement[]): { wire: string; used: Set<string> } {
  const tokens = replacements.map((r) => session.tokenFor(r));
  const spans = tokens.flatMap((t) => spansFor(text, t));
  // Longest first, then leftmost: a full name wins over a stray first name.
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken: Span[] = [];
  for (const span of spans) {
    if (taken.some((t) => span.start < t.end && span.end > t.start)) continue;
    taken.push(span);
  }
  taken.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of taken) {
    out += text.slice(cursor, span.start) + span.token.token;
    cursor = span.end;
  }
  out += text.slice(cursor);
  // Fail closed: no masked original may survive outside a token.
  const withoutTokens = out.split(/\[[a-z0-9]{4}:[A-Z0-9_]+\]/).join('\u0000');
  for (const t of tokens) {
    if (containsOriginal(withoutTokens, t)) {
      throw new Error('A masked value could not be replaced everywhere it appears; nothing was sent.');
    }
  }
  return { wire: out, used: new Set(taken.map((span) => span.token.token)) };
}

/** Mask one memory's content at `tier` inside the session. */
export async function maskContentInSession(
  session: RedactionSession,
  text: string,
  tier: Tier,
  ollama?: OllamaClient | null,
): Promise<SessionMaskResult> {
  const r = await redact(text, { tier, pseudonyms: session.pseudonyms }, ollama);
  const { wire, used } = rewrite(session, text, r.replacements);
  // The issued set is what the masking produced, never a scan of a prompt.
  return { wire, issued: used, tierApplied: r.tierApplied, degraded: r.tier2Degraded };
}

/**
 * Mask a collection name: Tier 1 at every tier, plus every date to the year
 * at Tier 3 (ADR 0060 1.1, F6 and F7). Names are not run (open item O2).
 */
export function maskScopeInSession(session: RedactionSession, scope: string, tier: Tier): SessionMaskResult {
  const t1 = applyTier1(scope);
  const replacements = [...t1.replacements];
  if (tier === 3) replacements.push(...generalizeDates(t1.text, 'all').replacements);
  const { wire, used } = rewrite(session, scope, replacements);
  return { wire, issued: used, tierApplied: tier, degraded: false };
}
