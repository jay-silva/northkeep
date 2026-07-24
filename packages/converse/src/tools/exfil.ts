import { applyTier1 } from '@northkeep/redact';

/**
 * Exfiltration screens over RESTORED PLAINTEXT tool arguments (M10c, ADR
 * 0029; threat stated in KNOWN-LIMITS.md §M10b). The threat model: a
 * prompt-injected model paraphrases the user's context — a secret, a
 * pseudonym's real value, vault memory content — into its next tool-call
 * URL, possibly hidden by percent-encoding, base64, case changes, or
 * punctuation splits. The M10b Tier-1 egress floor is a LITERAL matcher and
 * misses all of that by design; this module screens the DECODED/normalized
 * components instead, and its output feeds the permission gate so the user
 * is warned in plain language before anything leaves.
 *
 * Runs BEFORE the gate, over plaintext, entirely locally — nothing here
 * egresses (ADR 0027 decision 2: restore is for local consumers only).
 * Flags are CONTENT-FREE: no matched text, no offsets. A flag that echoed
 * the secret would put the secret into gate prompts and logs, recreating
 * the leak it exists to prevent.
 *
 * These are screens, not proofs. What still slips past is documented in
 * KNOWN-LIMITS.md and ADR 0029 (encryption/compression the model invents,
 * >3 encoding rounds, base64 embedded inside longer prose, semantic
 * paraphrase). The per-call gate showing the verbatim URL remains the
 * backstop.
 */

export type ExfilClass = 'secret' | 'identity' | 'memory';

export interface ExfilFlag {
  class: ExfilClass;
  /** Detector kind for secret-class hits (e.g. 'ssn', 'credit_card', 'api_key') — mirrors applyTier1's kind names. */
  kind?: string;
  where: 'host' | 'path' | 'query' | 'fragment' | 'body';
  /** True when the hit appeared only AFTER decoding (percent/base64) — i.e. it was hidden. */
  decoded: boolean;
}

export interface ExfilScreenInput {
  /** Restored plaintext argument JSON exactly as it would execute. */
  argsPlain: string;
  /** The tool's egress URL (already extracted by the loop), or null. */
  egressUrl: string | null;
  /** Session pseudonym REAL values (protected names) — may be empty. */
  protectedValues: string[];
  /** Plaintext content of vault memories disclosed to the model this task. */
  usedMemoryContents: string[];
}

type Where = ExfilFlag['where'];

interface Candidate {
  text: string;
  where: Where;
}

interface Variant {
  text: string;
  /** Produced by a decode step (percent/base64) — hits here were hidden. */
  decoded: boolean;
}

// ---------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------

/**
 * Break the egress URL and the argument JSON into the components an attacker
 * can smuggle data through. WHATWG URL parsing normalizes hostile spellings
 * the same way tools/net.ts does (one parser family, no disagreement); an
 * unparseable URL is screened WHOLE as a body candidate — fail closed, never
 * "could not parse, therefore clean".
 */
function extractCandidates(input: ExfilScreenInput): Candidate[] {
  const out: Candidate[] = [];
  const push = (text: string, where: Where): void => {
    if (text.length > 0) out.push({ text, where });
  };

  if (input.egressUrl !== null) {
    let url: URL | null = null;
    try {
      url = new URL(input.egressUrl);
    } catch {
      url = null;
    }
    if (url === null) {
      push(input.egressUrl, 'body');
    } else {
      push(url.hostname, 'host');
      // URL does NOT percent-decode pathname/search — raw components go in
      // here and the decode rounds below surface anything hidden in them.
      for (const segment of url.pathname.split('/')) push(segment, 'path');
      if (url.search.length > 1) {
        for (const pair of url.search.slice(1).split('&')) {
          const eq = pair.indexOf('=');
          const key = eq === -1 ? pair : pair.slice(0, eq);
          const value = eq === -1 ? '' : pair.slice(eq + 1);
          for (const component of [key, value]) {
            push(component, 'query');
            // Form encoding spells space as '+' in query components only; a
            // secret split by '+' is ordinary query syntax, not "hidden", so
            // the '+'→space form is a BASE candidate (decoded stays false).
            if (component.includes('+')) push(component.replace(/\+/g, ' '), 'query');
          }
        }
      }
      if (url.hash.length > 1) push(url.hash.slice(1), 'fragment');
    }
  }

  // Every string leaf of the argument JSON is a body candidate. Same walk
  // idiom as jsonLeaves.ts (transformJsonLeaves is an async TRANSFORMER that
  // re-serializes; here we need a sync COLLECTOR, so a small local walker).
  // Unparseable JSON → the whole raw string is one candidate: fail closed,
  // exactly like redactJsonLeaves treats malformed argument JSON.
  let parsed: unknown;
  let parseOk = true;
  try {
    parsed = JSON.parse(input.argsPlain) as unknown;
  } catch {
    parseOk = false;
  }
  if (!parseOk) {
    push(input.argsPlain, 'body');
  } else {
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        // The egress URL itself rides in the arguments as a leaf (that is
        // where the loop extracted it from). It is already screened above
        // COMPONENT-WISE, with the host carved out of identity/memory (see
        // the host rationale below); screening the identical string again as
        // a body blob would reintroduce the host false-positive through the
        // back door. Exact match only — anything even slightly different is
        // still screened (over-screening is the safe direction).
        if (node !== input.egressUrl) push(node, 'body');
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node !== null && typeof node === 'object') {
        // Keys are OUR schema identifiers, not model-chosen content carriers
        // of interest here — values are walked, keys pass (jsonLeaves parity).
        for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      }
    };
    walk(parsed);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Decoded variants
// ---------------------------------------------------------------------------

const BASE64_STD = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Decode a component that LOOKS like base64 (charset-valid, length ≥ 16,
 * optional padding). The 85%-printable gate keeps binary junk (hashes, real
 * ciphertext, images) from producing garbage candidates: a decode that is
 * mostly unprintable is not smuggled text, and screening it would only add
 * noise. Honest limit: base64 EMBEDDED inside longer prose is not found —
 * only whole components decode (KNOWN-LIMITS/ADR 0029).
 */
function tryBase64(text: string): string | null {
  if (text.length < 16) return null;
  let buf: Buffer;
  if (BASE64_STD.test(text)) buf = Buffer.from(text, 'base64');
  else if (BASE64_URL.test(text)) buf = Buffer.from(text, 'base64url');
  else return null;
  if (buf.length === 0) return null;
  let printable = 0;
  for (const byte of buf) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable += 1;
    }
  }
  if (printable / buf.length < 0.85) return null;
  return buf.toString('utf8');
}

/**
 * All decoded variants of one candidate: up to 3 percent-decode rounds
 * (stop when a round changes nothing or throws — malformed sequences like a
 * bare '%' must never crash the screen; the raw form was screened anyway),
 * plus base64/base64url on the raw text and on every percent variant
 * (percent-encoded base64 — '+' as %2B — is a plausible layering), plus one
 * further percent round on each base64 decode. Three rounds is a deliberate
 * boundary: each extra round costs little but a model willing to quadruple-
 * encode can just as well invent an encoding no decoder anticipates, so the
 * cutoff is documented (KNOWN-LIMITS) rather than chased.
 */
function decodedVariants(text: string): Variant[] {
  const out: Variant[] = [];
  const seen = new Set<string>([text]);
  const push = (t: string): void => {
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push({ text: t, decoded: true });
    }
  };

  let current = text;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break; // malformed escape: keep earlier variants, never throw
    }
    if (next === current) break;
    push(next);
    current = next;
  }

  const base64Sources = [text, ...out.map((v) => v.text)];
  for (const source of base64Sources) {
    const decoded = tryBase64(source);
    if (decoded === null) continue;
    push(decoded);
    try {
      const percentAgain = decodeURIComponent(decoded);
      if (percentAgain !== decoded) push(percentAgain);
    } catch {
      // decoded base64 with a stray '%': the base64 layer itself is screened
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

// Horizontal separators that can split a digit group — the same set tier1.ts
// uses (SEP) between digits, minus '/' (path-shaped dates like 2026/07/24
// would otherwise fuse into fake digit runs).
const DIGIT_SEP_RUN = /(?<=\d)[ .\-\u00A0\u2009\u202F]+(?=\d)/g;

/**
 * Digit-normalized forms for the secret detectors. applyTier1 already
 * tolerates ONE separator character between digit groups (tier1.ts SEP), so
 * we add only what it lacks:
 *  - collapse multi-character runs to a single dash ('123 - 45 - 6789' →
 *    '123-45-6789'). A dash, not a full strip, because a bare 9-digit SSN
 *    only matches tier1's keyword-anchored detector — stripping would erase
 *    the 3-2-4 grouping its primary detector keys on;
 *  - a full strip as well, because card numbers match bare (Luhn carries the
 *    signal) even when regrouped at non-standard boundaries.
 */
function digitNormalizedForms(text: string): string[] {
  const forms: string[] = [];
  const collapsed = text.replace(DIGIT_SEP_RUN, '-');
  if (collapsed !== text) forms.push(collapsed);
  const stripped = text.replace(DIGIT_SEP_RUN, '');
  if (stripped !== text && stripped !== collapsed) forms.push(stripped);
  return forms;
}

/** lowercase + strip everything non-alphanumeric (Unicode-aware, so 'José' keeps its letters). */
function normalizeLoose(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const MEMORY_GRAM = 16;

/**
 * Every 16-gram of every normalized memory, as a Set. A shared normalized
 * common substring of length ≥ 16 exists iff candidate and memory share a
 * 16-gram, so membership tests replace substring search: O(n + m) with the
 * constant 16 folded in (JS string keys act as the rolling-hash set — exact,
 * no collision handling). ~10 memories × ~1 KB → ~10k entries; a 4 KB
 * candidate → ~4k lookups. Never the O(n·m·k) triple loop.
 */
function buildMemoryGrams(memories: string[]): Set<string> | null {
  const grams = new Set<string>();
  for (const memory of memories) {
    const norm = normalizeLoose(memory);
    for (let i = 0; i + MEMORY_GRAM <= norm.length; i += 1) {
      grams.add(norm.slice(i, i + MEMORY_GRAM));
    }
  }
  return grams.size > 0 ? grams : null;
}

type FlagMap = Map<string, ExfilFlag>;

/**
 * Dedupe on (class, kind, where) — the SAME warning sentence twice helps
 * nobody. When both a plain and a hidden hit collapse into one flag, the
 * plain one wins the `decoded` bit: "hidden by encoding" must only be
 * claimed when hiding is the ONLY way the value appears.
 */
function addFlag(flags: FlagMap, cls: ExfilClass, kind: string | undefined, where: Where, decoded: boolean): void {
  const key = `${cls}|${kind ?? ''}|${where}`;
  const existing = flags.get(key);
  if (existing === undefined) {
    flags.set(key, { class: cls, ...(kind !== undefined ? { kind } : {}), where, decoded });
  } else if (existing.decoded && !decoded) {
    existing.decoded = false;
  }
}

function screenSecret(flags: FlagMap, variant: Variant, where: Where): void {
  for (const form of [variant.text, ...digitNormalizedForms(variant.text)]) {
    for (const replacement of applyTier1(form).replacements) {
      // The host of an IP-literal URL IS an IP address — that is the
      // destination, already vetted by classifyFetchTarget, not a payload
      // being exfiltrated. Every other secret kind in a hostname (an SSN
      // spelled as a subdomain) is exactly the smuggling this screen exists
      // for and stays flagged.
      if (where === 'host' && replacement.kind === 'ip') continue;
      addFlag(flags, 'secret', replacement.kind, where, variant.decoded);
    }
  }
}

function screenIdentity(flags: FlagMap, variant: Variant, where: Where, protectedNorms: string[]): void {
  const norm = normalizeLoose(variant.text);
  if (norm.length === 0) return;
  for (const value of protectedNorms) {
    if (norm.includes(value)) {
      addFlag(flags, 'identity', undefined, where, variant.decoded);
      return;
    }
  }
}

function screenMemory(flags: FlagMap, variant: Variant, where: Where, grams: Set<string> | null): void {
  if (grams === null) return;
  const norm = normalizeLoose(variant.text);
  for (let i = 0; i + MEMORY_GRAM <= norm.length; i += 1) {
    if (grams.has(norm.slice(i, i + MEMORY_GRAM))) {
      addFlag(flags, 'memory', undefined, where, variant.decoded);
      return; // one flag per candidate region; dedupe collapses across candidates
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Screen one tool call's restored plaintext arguments. Pure and synchronous:
 * no model, no I/O, no state — it can never fail open by a dependency being
 * down (invariant #6 spirit). Returns content-free flags for the gate.
 */
export function screenArguments(input: ExfilScreenInput): ExfilFlag[] {
  const flags: FlagMap = new Map();
  const memoryGrams = buildMemoryGrams(input.usedMemoryContents);
  // Protected values shorter than 4 normalized characters skip: initials and
  // two-letter fragments substring-match half the alphabet and would make
  // every call scream (a screen nobody believes protects nobody).
  const protectedNorms = input.protectedValues
    .map(normalizeLoose)
    .filter((n) => n.length >= 4);

  for (const candidate of extractCandidates(input)) {
    const variants: Variant[] = [
      { text: candidate.text, decoded: false },
      ...decodedVariants(candidate.text),
    ];
    for (const variant of variants) {
      screenSecret(flags, variant, candidate.where);
      // The HOST is screened for secret-class only. Rationale: the hostname
      // is what the user ASKED to fetch far more often than what a hijacked
      // model invented — "fetch carolmansfield.com" would otherwise flag the
      // owner's own protected name on every legitimate call, and a memory
      // 16-gram can land in a long hostname the same way. The host is shown
      // VERBATIM at the permission gate, so a hostname the user does not
      // recognize is already the most visible thing on screen; the screens
      // add signal where the eye glazes over (encoded paths, query blobs,
      // fragments, body JSON).
      if (candidate.where !== 'host') {
        screenIdentity(flags, variant, candidate.where, protectedNorms);
        screenMemory(flags, variant, candidate.where, memoryGrams);
      }
    }
  }

  return [...flags.values()];
}

const WHERE_PHRASE: Record<Where, string> = {
  host: "the URL's host",
  path: "the URL's path",
  query: "the URL's query string",
  fragment: "the URL's fragment",
  body: 'the request',
};

// Human nouns per applyTier1 kind — deliberately hedged ("-shaped"): a
// detector match is a shape, not a verified secret, and the sentence must
// stay honest either way.
const KIND_NOUN: Record<string, string> = {
  ssn: 'an SSN-shaped value',
  credit_card: 'a card-number-shaped value',
  api_key: 'an API key or token',
  email: 'an email address',
  phone: 'a phone number',
  iban: 'an IBAN-shaped account number',
  ip: 'an IP address',
  record_id: 'a record or account identifier',
  gps: 'GPS coordinates',
  zip: 'a ZIP code',
  address: 'a street address',
};

/**
 * One user-facing sentence per flag. CONTENT-FREE by construction: built
 * entirely from fixed phrase tables keyed on the flag's enum fields — the
 * matched value cannot appear because it is never in the flag.
 */
export function describeFlag(flag: ExfilFlag): string {
  const where = WHERE_PHRASE[flag.where];
  const hidden = flag.decoded ? ' (hidden by encoding)' : '';
  if (flag.class === 'secret') {
    const noun = (flag.kind !== undefined ? KIND_NOUN[flag.kind] : undefined) ?? 'a sensitive value';
    return `${where} carries ${noun}${hidden}`;
  }
  if (flag.class === 'identity') {
    return `${where} appears to include a protected name from this conversation${hidden}`;
  }
  return `${where} appears to include content from your vault memories${hidden}`;
}
