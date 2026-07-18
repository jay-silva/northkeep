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

// Horizontal separators that show up between digit groups when text is
// pasted from documents: ASCII space/dot/dash plus common Unicode spaces
// (NBSP, thin space, narrow no-break space).
const SEP = '[ .\\-\\u00A0\\u2009\\u202F]';

const DETECTORS: Detector[] = [
  {
    kind: 'api_key',
    // PEM blocks; OpenAI sk-/sk-proj-; Stripe sk_live_/rk_live_/pk_test_;
    // AWS; GitHub; Slack; Google; and JWTs (three base64url segments).
    regex: new RegExp(
      [
        '-----BEGIN[ A-Z]*PRIVATE KEY-----[\\s\\S]*?-----END[ A-Z]*PRIVATE KEY-----',
        '\\b(?:sk|pk|rk)[_-](?:live|test|proj)?[_-]?[A-Za-z0-9]{16,}\\b',
        '\\bAKIA[0-9A-Z]{16}\\b',
        '\\bghp_[A-Za-z0-9]{36}\\b',
        '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
        '\\bAIza[0-9A-Za-z_-]{35}\\b',
        '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b', // JWT
      ].join('|'),
      'g',
    ),
    restorable: false,
  },
  {
    kind: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    restorable: false,
  },
  {
    kind: 'credit_card',
    // 13–19 digits with optional space/dot/dash/Unicode-space grouping. Luhn.
    regex: new RegExp(`\\b(?:\\d${SEP}?){13,19}\\b`, 'g'),
    valid: luhnValid,
    restorable: false,
  },
  {
    kind: 'ssn',
    // US SSN 3-2-4 with -, ., space, or / separators; excludes invalid areas.
    regex: /\b(?!000|666|9\d\d)\d{3}[-. /](?!00)\d{2}[-. /](?!0000)\d{4}\b/g,
    restorable: false,
  },
  {
    kind: 'ssn',
    // Bare 9-digit SSN, only right after an SSN keyword (else too noisy).
    regex: /(?<=\b(?:ssn|social security(?: number| no\.?| #)?)\b\D{0,12})(?!000|666|9\d\d)\d{9}\b/gi,
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
    // North-American (optional +1, area in parens or not, 3-3-4), and
    // international (+country then 2–5 groups of 2–4 digits, e.g. UK
    // +44 20 7946 0958). Runs after card/SSN/IBAN so those win any overlap.
    regex:
      /(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}\b|\+\d{1,3}(?:[ .-]?\d{2,4}){2,5}\b/g,
    restorable: false,
  },
  {
    kind: 'phone',
    // Bare 10-digit number, only right after a phone keyword.
    regex: /(?<=\b(?:phone|call|cell|tel|telephone|mobile|fax|dial|text)\b\D{0,10})\d{10}\b/gi,
    restorable: false,
  },
  {
    kind: 'record_id',
    // Labeled record/account identifiers (HIPAA identifier classes): policy,
    // member, MRN, incident, claim, run/response numbers. Label-anchored so
    // bare numbers stay; the value needs 6+ chars incl. a digit ("s0103443101",
    // "BRNE:2026:3035", "FDSU-EPCR-3829165"). Field report 2026-07-17: these
    // rode through a pasted ePCR untouched.
    regex:
      /(?<=\b(?:policy|member|mrn|medical record|record|report|incident|account|claim|authorization|run|response|epcr|pcr)\b(?:[ .]{0,2}(?:number|no\.?|num|id)\b){0,2}[:#\s]{1,4})(?!(?:date|time|number|no|id)\b)(?=[A-Za-z0-9:._-]*\d)[A-Za-z0-9][A-Za-z0-9:._-]{5,29}\b/gi,
    restorable: false,
  },
  {
    kind: 'record_id',
    // Letter-prefixed certification/license/run numbers (P870331, EMT0904221)
    // — crew cert ids ride unlabeled next to names in ePCR exports (PCR-2
    // field test). 1–4 letters + 6–9 digits, standalone.
    regex: /\b[A-Z]{1,4}\d{6,9}\b/g,
    restorable: false,
  },
  {
    kind: 'zip',
    // ZIP codes in ADDRESS context (after a "ZIP" label, a state abbreviation
    // or "Massachusetts", "County,", or a street suffix) — Safe Harbor treats
    // ZIPs as identifiers; context-anchoring keeps bare 5-digit numbers
    // (record counts, device readings) untouched. PCR-3 field test 2026-07-18.
    regex: new RegExp(
      '(?<=\\b(?:zip\\s*code|zip)\\s*[:#]?\\s{0,3})\\d{5}(?:-\\d{4})?\\b' +
        '|(?<=\\b(?:county|massachusetts)[.,]?\\s{1,3})\\d{5}(?:-\\d{4})?\\b' +
        '|(?<=\\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)[.,]?\\s{1,3})\\d{5}(?:-\\d{4})?\\b' +
        '|(?<=\\b(?:rd|ln|dr|st|ave|road|lane|drive|street|avenue|blvd|court|ct|way)[.,]?\\s{1,3})\\d{5}(?:-\\d{4})?\\b',
      'gi',
    ),
    restorable: false,
  },
  {
    kind: 'gps',
    // Decimal lat,long coordinate pairs (41.564308,-70.622237) — a precise
    // geographic identifier ePCR exports embed for scene/destination
    // (PCR-3 field test 2026-07-18). Requires 3+ decimal places on both
    // components so version strings and vitals never match.
    regex: /(?<![\d.])-?(?:[1-8]?\d|90)\.\d{3,8}\s*,\s*-?(?:1[0-7]\d|[1-9]?\d|180)\.\d{3,8}\b/g,
    restorable: false,
  },
  {
    kind: 'ip',
    regex:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    restorable: false,
  },
  {
    kind: 'ip',
    // IPv6, full and zero-compressed (::). Branches are ordered LONGEST-FIRST
    // (JS alternation is first-match, not longest) so a full address isn't
    // partially eaten by the trailing-`::` branch. Requires 8 groups or a
    // `::`, so single-colon sequences (e.g. clock times) don't false-match.
    // A single leading boundary (?<![A-Za-z0-9:]) on the whole alternation
    // stops mid-token matches like the `d::` inside `std::string`.
    regex: new RegExp(
      '(?<![A-Za-z0-9:])(?:' +
        [
          '(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}', // full 8 groups
          '(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}', // e.g. fe80::1, 2001:db8::1
          '(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}',
          '(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}',
          '(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}',
          '(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}',
          '[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}',
          ':(?::[0-9A-Fa-f]{1,4}){1,7}', // leading ::x
          '(?:[0-9A-Fa-f]{1,4}:){1,7}:', // trailing x::
          '::', // bare ::
        ].join('|') +
        ')',
      'g',
    ),
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
