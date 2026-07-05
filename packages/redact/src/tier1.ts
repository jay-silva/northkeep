import type { Replacement, SecretKind } from './types.js';

/**
 * Tier-1: deterministic detection of high-confidence secrets. Always on,
 * ~milliseconds, no model. These patterns are the leak-test gate — a miss
 * here is a critical bug. Order matters: more specific/greedy patterns run
 * first so a card number isn't partially eaten by the phone matcher.
 */

interface Detector {
  kind: SecretKind;
  regex: RegExp;
  /** Extra validation to cut false positives (e.g. Luhn for cards). */
  valid?: (match: string) => boolean;
  /** Whether restore() can put the original back (secrets: no). */
  restorable: boolean;
}

const DETECTORS: Detector[] = [
  {
    kind: 'api_key',
    // PEM private-key blocks, and common provider key shapes.
    regex:
      /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{35}\b/g,
    restorable: false,
  },
  {
    kind: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    restorable: false,
  },
  {
    kind: 'credit_card',
    // 13–19 digits, optional space/dash grouping. Luhn-validated.
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    valid: luhnValid,
    restorable: false,
  },
  {
    kind: 'ssn',
    // US SSN: 3-2-4, dashed or spaced. Excludes obviously-invalid areas.
    regex: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
    restorable: false,
  },
  {
    kind: 'iban',
    regex: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g,
    valid: (m) => m.replace(/\s/g, '').length >= 15,
    restorable: false,
  },
  {
    kind: 'phone',
    // Two shapes: North-American (optional +1, area in parens or not, 3-3-4),
    // and international (+country then 2–5 groups of 2–4 digits, e.g. UK
    // +44 20 7946 0958). Runs after card/SSN/IBAN so those win any overlap.
    regex:
      /(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b|\+\d{1,3}(?:[ .-]?\d{2,4}){2,5}\b/g,
    restorable: false,
  },
  {
    kind: 'ip',
    regex:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
    restorable: false,
  },
];

export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface Hit {
  start: number;
  end: number;
  kind: SecretKind;
  original: string;
  restorable: boolean;
}

/**
 * Finds all Tier-1 secrets and rewrites them to numbered placeholders.
 * Consistent within a call: the same secret text gets the same placeholder.
 * Overlapping matches resolve by first-detector-wins, then leftmost.
 */
export function applyTier1(
  text: string,
  counters: Map<SecretKind, number> = new Map(),
  seen: Map<string, string> = new Map(),
): { text: string; replacements: Replacement[] } {
  const hits: Hit[] = [];
  for (const det of DETECTORS) {
    det.regex.lastIndex = 0;
    for (const m of text.matchAll(det.regex)) {
      const original = m[0];
      if (det.valid && !det.valid(original)) continue;
      const start = m.index;
      const end = start + original.length;
      if (hits.some((h) => start < h.end && end > h.start)) continue; // overlap → keep earlier detector
      hits.push({ start, end, kind: det.kind, original, restorable: det.restorable });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  const replacements: Replacement[] = [];
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    let placeholder = seen.get(hit.original);
    if (placeholder === undefined) {
      const n = (counters.get(hit.kind) ?? 0) + 1;
      counters.set(hit.kind, n);
      placeholder = `[${hit.kind.toUpperCase()}_${n}]`;
      seen.set(hit.original, placeholder);
      replacements.push({
        placeholder,
        original: hit.original,
        tier: 1,
        kind: hit.kind,
        restorable: hit.restorable,
      });
    }
    out += text.slice(cursor, hit.start) + placeholder;
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return { text: out, replacements };
}
