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

// DoS bounds (G3 #4, #5). The detector chain (applyTier1's O(hits²) overlap
// scan × the variant/form fan-out) is ~quadratic in a single candidate's
// length, and a prompt-injected model can emit a giant argument. Caps: no
// single candidate longer than MAX_CANDIDATE_CHARS is screened past its
// prefix (a real URL or arg component is far smaller; a huge one is itself
// suspicious and shown verbatim at the gate), and no more than MAX_CANDIDATES
// candidates total. Both are generous vs. reality and keep the SYNCHRONOUS
// screen from blocking the event loop. MAX_JSON_DEPTH stops the recursive
// leaf walk from overflowing the stack on adversarial nesting (JSON.parse
// itself succeeds far deeper than the default call stack).
const MAX_CANDIDATE_CHARS = 4096;
const MAX_CANDIDATES = 1024;
const MAX_JSON_DEPTH = 200;

function extractCandidates(input: ExfilScreenInput): Candidate[] {
  const out: Candidate[] = [];
  const push = (text: string, where: Where): void => {
    if (text.length === 0 || out.length >= MAX_CANDIDATES) return;
    // Screen only the prefix of an oversized component (see MAX_CANDIDATE_CHARS).
    out.push({ text: text.length > MAX_CANDIDATE_CHARS ? text.slice(0, MAX_CANDIDATE_CHARS) : text, where });
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
    const walk = (node: unknown, depth: number): void => {
      if (depth > MAX_JSON_DEPTH || out.length >= MAX_CANDIDATES) return;
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
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (node !== null && typeof node === 'object') {
        // Keys are OUR schema identifiers, not model-chosen content carriers
        // of interest here — values are walked, keys pass (jsonLeaves parity).
        for (const value of Object.values(node as Record<string, unknown>)) walk(value, depth + 1);
      }
    };
    walk(parsed, 0);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Decoded variants
// ---------------------------------------------------------------------------

const BASE64_STD = /^[A-Za-z0-9+/\s]+={0,2}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Fraction of `buf` that decodes as printable text under `encoding`. Used to
 * pick the RIGHT interpretation of decoded base64 bytes: a UTF-16LE-encoded
 * ASCII secret is ~50% NUL under utf8 (G3 finding #2) but ~100% printable
 * under utf16le, so trying multiple encodings and keeping the best-printing
 * one recovers the hidden text instead of discarding it as "binary junk".
 */
function printableText(buf: Buffer, encoding: BufferEncoding): { text: string; ratio: number } {
  const text = buf.toString(encoding);
  if (text.length === 0) return { text, ratio: 0 };
  let printable = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d) {
      printable += 1;
    }
  }
  return { text, ratio: printable / text.length };
}

// A secret is a CONTIGUOUS printable run; ≥ this many printable ASCII chars in
// a row is worth screening even inside an otherwise-binary decode. 8 catches a
// bare SSN (11 chars) and a 16-digit card while staying long enough that random
// binary almost never produces one by chance (0.37^8 ≈ 3e-4/position), so
// run-extraction adds negligible false-positive surface (G3 round-2 measured 0
// across 1300 realistic components; the tier1/16-gram detectors stay specific).
const MIN_PRINTABLE_RUN = 8;
const PRINTABLE_RUN = /[\x20-\x7e]{8,}/g;

/**
 * Decode candidates from a component that LOOKS like base64 (charset-valid,
 * length ≥ 16, optional padding, embedded whitespace tolerated — MIME wraps at
 * 76 cols, G3 #7). Returns EVERY plausible plaintext reading:
 *  - if the whole buffer is ≥ 85% printable under utf8 / utf16le / latin1, the
 *    full decode (a UTF-16LE ASCII secret is ~50% NUL under utf8 but clean
 *    under utf16le — G3 #2, so all three are tried);
 *  - otherwise the maximal printable-ASCII RUNS of each decode. This closes
 *    G3 round-2 #3: padding a base64 secret with high bytes (0xFF is non-
 *    printable under all three encodings) sank the whole-buffer ratio below
 *    85% and hid the secret; the run survives the padding.
 * Binary junk (hashes, ciphertext, images) yields only short runs that no
 * detector matches, so the run fallback does not degrade trust.
 */
function base64Decodes(text: string): string[] {
  // Whitespace is allowed in the shape test but stripped before decoding, so
  // the length/charset checks see the real payload.
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 16) return [];
  let buf: Buffer;
  if (BASE64_STD.test(text)) buf = Buffer.from(compact, 'base64');
  else if (BASE64_URL.test(text)) buf = Buffer.from(compact, 'base64url');
  else return [];
  if (buf.length === 0) return [];
  const out: string[] = [];
  for (const encoding of ['utf8', 'utf16le', 'latin1'] as const) {
    const { text: decoded, ratio } = printableText(buf, encoding);
    if (ratio >= 0.85) {
      out.push(decoded);
    } else {
      // Screen each printable run separately (never joined — joining could
      // fuse unrelated fragments into a false 16-gram).
      for (const run of decoded.match(PRINTABLE_RUN) ?? []) {
        if (run.length >= MIN_PRINTABLE_RUN) out.push(run);
      }
    }
  }
  return out;
}

// Decode budget. A layered encoding (percent∘base64∘base64∘…) is unwrapped by
// a bounded fixpoint, NOT a fixed pipeline: G3 #1 showed a fixed structure let
// base64 run only once, so double-base64 slipped BELOW the confessed quadruple
// boundary. MAX_DECODE_ROUNDS bounds the layering depth; MAX_VARIANTS caps the
// total work so a decode-bomb (each layer fanning to several forms) cannot hang
// the screen. Percent-decode is a linear chain (a '%' can't be base64), but a
// single base64 buffer can now yield several printable-run readings, so the cap
// carries headroom above that fan-out — 64 keeps a buried-secret run reachable
// while still bounding work. Both are generous versus any real URL.
const MAX_DECODE_ROUNDS = 6;
const MAX_VARIANTS = 64;

/**
 * All decoded variants of one candidate, as a bounded fixpoint over BOTH
 * decoders. Each round takes every variant discovered so far and applies one
 * percent-decode and one base64-decode, feeding novel results back in — so
 * base64(base64(x)), percent(base64(x)), base64(percent(x)) and any other
 * layering up to the round/variant budget are all unwrapped (closes G3 #1).
 * Percent-decode of a malformed escape throws and is swallowed (a bare '%'
 * must never crash the screen); base64 that does not look like base64 simply
 * yields nothing. Termination is guaranteed by the `seen` set plus both caps.
 */
function decodedVariants(text: string): Variant[] {
  const out: Variant[] = [];
  const seen = new Set<string>([text]);
  let frontier: string[] = [text];

  const push = (t: string): string | null => {
    if (t.length === 0 || seen.has(t) || out.length >= MAX_VARIANTS) return null;
    seen.add(t);
    out.push({ text: t, decoded: true });
    return t;
  };

  for (let round = 0; round < MAX_DECODE_ROUNDS && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      if (out.length >= MAX_VARIANTS) break;
      let percentDecoded: string | null = null;
      try {
        const p = decodeURIComponent(current);
        if (p !== current) percentDecoded = p;
      } catch {
        // malformed escape: no percent variant from this node, never throw
      }
      if (percentDecoded !== null) {
        const added = push(percentDecoded);
        if (added !== null) next.push(added);
      }
      // base64 may yield several readings (multi-encoding + printable runs).
      for (const b64 of base64Decodes(current)) {
        const added = push(b64);
        if (added !== null) next.push(added);
        if (out.length >= MAX_VARIANTS) break;
      }
    }
    frontier = next;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

// Horizontal separators that can split a digit group — the same set tier1.ts
// uses (SEP) between digits, minus '/' (path-shaped dates like 2026/07/24
// would otherwise fuse into fake digit runs).
const DIGIT_SEP_RUN = /(?<=\d)[ .\-_:\u00A0\u2009\u202F]+(?=\d)/g;

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
// A memory whose ENTIRE normalized form is shorter than a 16-gram (a gate
// code, a PIN, a short passphrase — "Gate code 7421!" → 'gatecode7421', 12
// chars) produces no grams and would be wholly unscreenable (G3 #3). Such
// memories are matched as whole normalized substrings instead, down to this
// floor. Below the floor the token is too short to match specifically (a
// 4-digit PIN substring-hits half the URLs on the web), so it is left to the
// per-call gate — documented in KNOWN-LIMITS.
const MIN_SHORT_MEMORY = 8;

interface MemoryMatcher {
  grams: Set<string>;
  /** Whole normalized forms of memories too short to gram (length in
   * [MIN_SHORT_MEMORY, MEMORY_GRAM)). Matched by substring. */
  shorts: string[];
}

/**
 * The memory matcher: every 16-gram of every normalized memory as a Set, plus
 * the whole-form list for sub-16 memories. A shared normalized common
 * substring of length ≥ 16 exists iff candidate and memory share a 16-gram,
 * so gram membership replaces substring search: O(n + m), the constant 16
 * folded in (JS string keys act as the rolling-hash set — exact, no collision
 * handling). Never the O(n·m·k) triple loop.
 */
function buildMemoryMatcher(memories: string[]): MemoryMatcher | null {
  const grams = new Set<string>();
  const shorts: string[] = [];
  for (const memory of memories) {
    const norm = normalizeLoose(memory);
    if (norm.length >= MEMORY_GRAM) {
      for (let i = 0; i + MEMORY_GRAM <= norm.length; i += 1) {
        grams.add(norm.slice(i, i + MEMORY_GRAM));
      }
    } else if (norm.length >= MIN_SHORT_MEMORY) {
      shorts.push(norm);
    }
  }
  return grams.size > 0 || shorts.length > 0 ? { grams, shorts } : null;
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

function screenMemory(flags: FlagMap, variant: Variant, where: Where, matcher: MemoryMatcher | null): void {
  if (matcher === null) return;
  const norm = normalizeLoose(variant.text);
  for (let i = 0; i + MEMORY_GRAM <= norm.length; i += 1) {
    if (matcher.grams.has(norm.slice(i, i + MEMORY_GRAM))) {
      addFlag(flags, 'memory', undefined, where, variant.decoded);
      return; // one flag per candidate region; dedupe collapses across candidates
    }
  }
  // Short memories: the whole normalized form appearing anywhere in the
  // candidate (G3 #3). Cheap — `shorts` is tiny (only sub-16 memories).
  for (const short of matcher.shorts) {
    if (norm.includes(short)) {
      addFlag(flags, 'memory', undefined, where, variant.decoded);
      return;
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
  const memoryMatcher = buildMemoryMatcher(input.usedMemoryContents);
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
        screenMemory(flags, variant, candidate.where, memoryMatcher);
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
