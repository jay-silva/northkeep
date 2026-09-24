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

/**
 * Issuer-prefixed token shapes (ADR 0059). Each body is a MINIMUM length over
 * the issuer's full alphabet, looser than gitleaks/trufflehog on purpose: an
 * issuer lengthening a key or adding `-`/`_` must not turn a mask into a full
 * leak. The leading guard is "no letter or digit before", not \b, so a token
 * glued after `_` (MY_KEY_ghp_...) still matches. Exported so tests iterate
 * the same table the detector compiles.
 */
export const TOKEN_PREFIX_PATTERNS: ReadonlyArray<{ name: string; pattern: string }> = [
  { name: 'anthropic', pattern: '(?<![A-Za-z0-9])sk-ant-[a-z]{2,10}\\d{2}-[A-Za-z0-9_-]{40,}' },
  { name: 'openai-named', pattern: '(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}' },
  { name: 'stripe', pattern: '(?<![A-Za-z0-9])[rs]k_(?:live|test|prod)_[A-Za-z0-9]{16,}' },
  { name: 'openrouter', pattern: '(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{32,}' },
  { name: 'github', pattern: '(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}' },
  { name: 'github-fine-grained', pattern: '(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}' },
  {
    name: 'gitlab',
    pattern:
      '(?<![A-Za-z0-9])gl(?:pat|dt|ptt|rt|cbt|ft|ffct|imt|agent|oas|soat)-[A-Za-z0-9_-][A-Za-z0-9_.-]{18,}[A-Za-z0-9_-]',
  },
  { name: 'gitlab-runner-registration', pattern: '(?<![A-Za-z0-9])GR1348941[A-Za-z0-9_-]{20,}' },
  { name: 'slack', pattern: '(?<![A-Za-z0-9])xox[baprse]-[A-Za-z0-9-]{10,}' },
  { name: 'slack-app', pattern: '(?<![A-Za-z0-9])xapp-\\d-[A-Za-z0-9-]{10,}' },
  { name: 'npm', pattern: '(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36,}' },
  { name: 'pypi', pattern: '(?<![A-Za-z0-9])pypi-AgE[A-Za-z0-9_-]{50,}' },
  { name: 'huggingface', pattern: '(?<![A-Za-z0-9])(?:hf|api_org)_[A-Za-z0-9]{34,}' },
  { name: 'xai', pattern: '(?<![A-Za-z0-9])xai-[A-Za-z0-9_]{50,}' },
  { name: 'groq', pattern: '(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{40,}' },
  { name: 'replicate', pattern: '(?<![A-Za-z0-9])r8_[A-Za-z0-9_-]{35,}' },
  { name: 'perplexity', pattern: '(?<![A-Za-z0-9])pplx-[A-Za-z0-9]{40,}' },
  {
    name: 'aws-access-key',
    pattern: '(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Za-z0-9])',
  },
  { name: 'aws-bedrock', pattern: '(?<![A-Za-z0-9])ABSK[A-Za-z0-9+/]{100,}={0,2}' },
  { name: 'sendgrid', pattern: '(?<![A-Za-z0-9])SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{30,}' },
  { name: 'digitalocean', pattern: '(?<![A-Za-z0-9])do[opr]_v1_[a-f0-9]{64,}' },
  { name: 'shopify', pattern: '(?<![A-Za-z0-9])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32,}' },
  { name: 'linear', pattern: '(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{40,}' },
  { name: 'notion', pattern: '(?<![A-Za-z0-9])(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{43,})' },
  { name: 'databricks', pattern: '(?<![A-Za-z0-9])dapi[a-f0-9]{32,}' },
  { name: 'sentry', pattern: '(?<![A-Za-z0-9])sntry[us]_[A-Za-z0-9+/=_]{40,}' },
  { name: 'doppler', pattern: '(?<![A-Za-z0-9])dp\\.pt\\.[A-Za-z0-9]{40,}' },
  { name: 'planetscale', pattern: '(?<![A-Za-z0-9])pscale_(?:tkn|oauth|pw)_[A-Za-z0-9_.=-]{31,}[A-Za-z0-9_=-]' },
  { name: 'pulumi', pattern: '(?<![A-Za-z0-9])pul-[a-f0-9]{40,}' },
  { name: 'postman', pattern: '(?<![A-Za-z0-9])PMAK-[a-f0-9]{24}-[a-f0-9]{34,}' },
  { name: 'heroku', pattern: '(?<![A-Za-z0-9])HRKU-AA[A-Za-z0-9_-]{58,}' },
  { name: 'onepassword-service', pattern: '(?<![A-Za-z0-9])ops_eyJ[A-Za-z0-9+/]{100,}={0,3}' },
  { name: 'age', pattern: '(?<![A-Za-z0-9])AGE-SECRET-KEY-1[0-9A-Z]{58,}' },
  { name: 'atlassian', pattern: '(?<![A-Za-z0-9])ATATT3[A-Za-z0-9_=-]{100,}' },
  { name: 'flyio', pattern: '(?<![A-Za-z0-9])(?:fo1_[A-Za-z0-9_-]{43,}|fm[12][ar]?_[A-Za-z0-9+/]{100,}={0,3})' },
  // Right after `bot` as Telegram's own API URLs spell it
  // (api.telegram.org/bot<id>:<secret>/method), where `bot` anchors gitleaks'
  // wide id range and stays visible; bare, only the narrow `<8-10>:AA` shape,
  // because a wide bare range hits ids like `order:123456:Awaiting...`.
  {
    name: 'telegram-bot',
    pattern:
      '(?<=(?<![A-Za-z0-9])bot)\\d{5,16}:A[A-Za-z0-9_-]{33,}|(?<![A-Za-z0-9])\\d{8,10}:AA[A-Za-z0-9_-]{32,}',
  },
];

const DETECTORS: Detector[] = [
  {
    kind: 'api_key',
    // PEM blocks; the issuer-prefixed table above, placed BEFORE the generic
    // sk/pk/rk branch because alternation is first-match at a position and the
    // generic branch would otherwise claim a partial span; legacy OpenAI sk-
    // and pk_/rk_ keys; Google; JWTs.
    regex: new RegExp(
      [
        '-----BEGIN[ A-Z]*PRIVATE KEY-----[\\s\\S]*?-----END[ A-Z]*PRIVATE KEY-----',
        ...TOKEN_PREFIX_PATTERNS.map((p) => p.pattern),
        '\\b(?:sk|pk|rk)[_-](?:live|test|proj)?[_-]?[A-Za-z0-9]{16,}\\b',
        '\\bAIza[0-9A-Za-z_-]{35}\\b',
        '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b', // JWT
      ].join('|'),
      'g',
    ),
    valid: (m) => !isRepeatedFillPlaceholder(m),
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
    kind: 'address',
    // Street addresses: house number + 1-3 words + a street suffix
    // ("218 MAIN STREET", "51 Meetinghouse Ln", "13 Milliken PL"). The
    // patient's incident address is a core Safe Harbor identifier and appears
    // in every ePCR (PCR-6 field test 2026-07-18). Suffix-anchored so bare
    // numbers and prose survive.
    regex: /\b\d{1,5}\s+(?:[A-Za-zÀ-ÖØ-öø-ÿ'.-]+\s+){1,3}(?:st|street|rd|road|ln|lane|dr|drive|ave|avenue|blvd|boulevard|ct|court|way|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway)\.?\b(?!\s*(?:elevation|dose|per|of))/gi,
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

/**
 * ADR 0059 option C: a key-shaped match whose body is one character repeated
 * (`ghp_xxxx...`) carries no entropy, so it is a placeholder, not a key. The
 * run must be 20+ long and leave at most 20 other characters (room for the
 * longest prefix), so at most a 20-char fragment of a real key could ride
 * along, no more than splitting a key already leaks.
 */
export function isRepeatedFillPlaceholder(match: string): boolean {
  let best = 0;
  let run = 0;
  for (let i = 0; i < match.length; i += 1) {
    run = i > 0 && match[i] === match[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best >= 20 && match.length - best <= 20;
}

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
