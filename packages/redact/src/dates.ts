import type { Replacement } from './types.js';

/**
 * Date generalization (ADR 0022). Deterministic, no model: any full calendar
 * date is rewritten to a year-only placeholder — `03/15/1948` → `[DATE-1948]`,
 * a date with no discernible year → `[DATE]`. One-way (restorable: false): the
 * model never needs the real day/month, and the year carries the clinical
 * relevance (age cohort).
 *
 * Two modes:
 *  - 'all'         — every full date (Tier 3).
 *  - 'dob-labeled' — only dates within reach of a DOB-ish label (Tier 2).
 *
 * Deliberately NOT matched: times of day (14:32), relative references
 * ("3 days ago"), bare years ("in 1948"), and bare month names — they are not
 * Safe-Harbor identifiers by themselves and carry QI value. Bare years inside
 * placeholders we emit are safe by construction.
 */

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** Each pattern captures the year (4-digit or 2-digit) in a named group when
 * present. Order matters: ISO and month-name forms first so the numeric
 * matcher can't partially eat them. */
const DATE_PATTERNS: RegExp[] = [
  // ISO: 1948-03-15 / 1948/03/15, with an optional attached T-time
  // (machine-exported PCR timestamps: 1948-03-15T14:32:00Z). The time joined
  // by T is consumed with the date; free-standing times still survive.
  /\b(?<year>(?:19|20)\d{2})[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  // Month-name D, YYYY: March 15, 1948 · Mar 15 1948 · March 15th, 1948
  new RegExp(
    `\\b${MONTH}\\.?\\s+(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:,?\\s+(?<year>(?:19|20)\\d{2}))?\\b`,
    'gi',
  ),
  // D Month YYYY: 15 March 1948 · 15 Mar, 1948 · 15th of March, 1948
  new RegExp(
    `\\b(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\.?(?:,?\\s+(?<year>(?:19|20)\\d{2}))?\\b`,
    'gi',
  ),
  // Numeric M/D/YYYY or M-D-YY etc. (US order; the year is the trailing
  // group, which is all we keep).
  /\b(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.](?<year>\d{4}|\d{2})\b/g,
  // Day-first D/M/Y where the day is unambiguous (13–31): 15/03/1948,
  // 25.12.1999. Days ≤ 12 in day-first order parse as the US pattern above —
  // either way the date is masked and the trailing year kept.
  /\b(?:1[3-9]|2\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?<year>\d{4}|\d{2})\b/g,
  // Numeric M/D with no year (e.g. 03/15) — full date, year unknown.
  /\b(?:0?[1-9]|1[0-2])[/](?:0?[1-9]|[12]\d|3[01])\b(?![/.\d])/g,
];

/** A DOB-ish label, used by mode 'dob-labeled': the date must start within
 * `DOB_REACH` characters after the end of a label match. */
const DOB_LABEL = /\b(?:dob|d\.o\.b\.?|date of birth|birth\s*date|birthdate|born(?:\s+on)?)\b[:\s]*/gi;
const DOB_REACH = 20;

function normalizeYear(raw: string | undefined): string | null {
  if (!raw) return null;
  if (raw.length === 4) return raw;
  // Two-digit year: pivot at 30 (00–29 → 20xx, 30–99 → 19xx). Heuristic, but
  // only affects the placeholder's year hint, never what is masked.
  const n = Number(raw);
  return n < 30 ? `20${raw.padStart(2, '0')}` : `19${raw}`;
}

interface DateHit {
  start: number;
  end: number;
  original: string;
  year: string | null;
}

function findDates(text: string): DateHit[] {
  const hits: DateHit[] = [];
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue; // first pattern wins overlap
      hits.push({ start, end, original: m[0], year: normalizeYear(m.groups?.year) });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Rewrite dates to `[DATE-YYYY]` / `[DATE]`. Same original → same placeholder
 * within a call. Mode 'dob-labeled' keeps only dates anchored to a DOB label.
 */
export function generalizeDates(
  text: string,
  mode: 'all' | 'dob-labeled',
): { text: string; replacements: Replacement[] } {
  let hits = findDates(text);
  if (mode === 'dob-labeled') {
    const anchors: Array<{ end: number }> = [];
    DOB_LABEL.lastIndex = 0;
    for (const m of text.matchAll(DOB_LABEL)) anchors.push({ end: m.index + m[0].length });
    hits = hits.filter((h) => anchors.some((a) => h.start >= a.end && h.start - a.end <= DOB_REACH));
  }

  const replacements: Replacement[] = [];
  const seen = new Map<string, string>();
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    let placeholder = seen.get(hit.original);
    if (placeholder === undefined) {
      placeholder = hit.year ? `[DATE-${hit.year}]` : '[DATE]';
      seen.set(hit.original, placeholder);
      replacements.push({
        placeholder,
        original: hit.original,
        tier: 1, // deterministic layer; tier number is informational here
        kind: 'date',
        restorable: false,
      });
    }
    out += text.slice(cursor, hit.start) + placeholder;
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return { text: out, replacements };
}
