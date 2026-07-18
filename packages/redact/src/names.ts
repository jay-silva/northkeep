import { ENGLISH_TXT, FIRSTNAMES_TXT, SURNAMES_TXT } from './data.gen.js';
import type { PseudonymMap, Replacement } from './types.js';

/**
 * Deterministic name scrubbing (ADR 0022, Tier 3). No model in this path —
 * the layers here are the guarantee, and NER only ever ADDS masks on top:
 *
 *  1. Label anchors: capitalized (or ALL-CAPS) tokens after "Patient:",
 *     "Name:", "Pt:", "Mr./Mrs./Ms./Dr." → Person-N, dictionary hit or not.
 *  2. Title-case runs: 2+ consecutive Titlecase words where at least one
 *     token is name-evidence → the whole run is one Person-N ("Donna
 *     Hitchcock"), while header runs with no evidence ("Chief Complaint",
 *     "Blood Pressure") are left alone.
 *  3. ALL-CAPS evidence runs: PCR narratives are routinely written in caps
 *     ("PT DONNA HITCHCOCK"), where Title-case rules are blind. Consecutive
 *     ALL-CAPS tokens that are each name-evidence form one masked span;
 *     clinical acronyms (ALS, EMS, CPR…) are hard-excluded — several are
 *     literally census surnames.
 *  4. Single tokens: a Titlecase or ALL-CAPS name-evidence token → Person-N,
 *     with one tiny sentence-initial veto (top-2000 English word followed by
 *     a lowercase word — keeps "Will you…", "May I…"). A lowercase token is
 *     masked only when it is name-evidence AND absent from the full English
 *     list (catches "cabral"; leaves "young" alone).
 *
 * Token normalization (adversarial review 2026-07-17): possessives are
 * stripped ("Donna's" → base "Donna", the mask keeps the "'s"), apostrophes
 * and hyphens are dropped for dictionary lookup ("O'Brien" → "obrien",
 * census style), hyphenated tokens are also checked per-part ("Smith-Jones"
 * → "jones" is evidence), internal capitals are legal Titlecase
 * ("McDonald", "Jean-Pierre"), and Latin-1 accents are letters ("José
 * García" — the WORD class covers À-ÿ so accented names neither split nor
 * corrupt the output).
 *
 * Name-evidence = on a name list, with frequency-rank guards measured on the
 * bundled data: FIRST-list hits need English rank > 2000 (excludes "will",
 * "may", "general"); SURNAME-only hits need rank > 5000 or absence (excludes
 * "chief" 1793, "blood" 1323, "vital" 4760 — the census list is that
 * inclusive). Known residuals (KNOWN-LIMITS): bare high-frequency
 * word-surnames ("King said…"), off-list multi-token runs ("Zyler
 * Quandril"), lowercase common-word names — those lean on the NER net.
 *
 * Pseudonyms share the Tier-2 PseudonymMap (same person → same Person-N
 * across layers and turns) and restore in the reply.
 *
 * Data: bundled public lists (2010 Census surnames, SSA/NLTK first names,
 * google-20k English in FREQUENCY ORDER — the top-2000 prefix is the veto
 * set). Loaded lazily on first use; mobile is Tier-1-only and never loads
 * them. The English list contains many real names ("donna", "hitchcock"), so
 * it is NEVER used as a blanket veto — that would recreate the exact miss
 * Tier 3 exists to fix (ADR 0022).
 */

const VETO_PREFIX = 2000;
const FIRST_MIN_RANK = VETO_PREFIX;

/** Tokens that must never be treated as names in the ALL-CAPS branches.
 * Three families (all lowercase): clinical acronyms ("ALS"/"EMS" are census
 * surnames above the rank threshold), chart labels ("DOB", "YO", "ER", "ED",
 * "RN" — several are on the name lists too), and narrative verbs that the
 * census surname list happens to contain ("FOUND", "STABLE", "ALERT",
 * "STATES", "LEFT"), which would otherwise glue onto caps name runs. Applied
 * ONLY in ALL-CAPS context — Titlecase "Ed Found" keeps normal rules. */
const CAPS_EXCLUDE = new Set([
  // acronyms
  'als', 'bls', 'cpr', 'ems', 'pcr', 'epcr', 'gcs', 'pmh', 'spo2', 'copd',
  'chf', 'cva', 'mi', 'bp', 'hr', 'rr', 'cc', 'iv', 'io', 'o2', 'dnr', 'aed',
  'ecg', 'ekg', 'etco2', 'loc', 'nkda', 'prn', 'npo', 'sob', 'abd', 'ns',
  'lr', 'epi', 'asa', 'ntg', 'avpu', 'cms', 'cpap', 'bvm', 'npa', 'opa',
  'osha', 'hipaa', 'ift', 'aox', 'aox3', 'aox4', 'etoh', 'mvc', 'mva', 'pta',
  // chart labels / units
  'dob', 'yo', 'er', 'ed', 'hx', 'rn', 'emt', 'md', 'do', 'pa', 'ff', 'po',
  'sl', 'im', 'kvo', 'gsw', 'cao', 'wnl',
  // narrative verbs that are also census surnames
  'found', 'stable', 'alert', 'left', 'states', 'denies', 'supine', 'prone',
  'reports', 'called', 'moved', 'given', 'taken', 'noted', 'per', 'via',
  'fallen', 'hung', 'ran', 'placed',
  // day names (on the name lists; "MONDAY, TUESDAY" is a schedule, not a person)
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

interface NameData {
  first: Set<string>;
  sur: Set<string>;
  english: Set<string>;
  rank: Map<string, number>; // 1-based frequency rank in english.txt
  veto: Set<string>; // top-VETO_PREFIX english words, sentence-initial escape hatch
}

let data: NameData | null = null;

/** The lists ship as a generated module (src/data.gen.ts) rather than
 * fs-loaded files, so the SAME code path runs under Node and Metro/Hermes
 * (mobile cannot read package data files at runtime). */
function loadList(txt: string): string[] {
  return txt
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function nameData(): NameData {
  if (data) return data;
  const english = loadList(ENGLISH_TXT); // rank order preserved
  const rank = new Map<string, number>();
  english.forEach((w, i) => {
    if (!rank.has(w)) rank.set(w, i + 1);
  });
  data = {
    first: new Set(loadList(FIRSTNAMES_TXT)),
    sur: new Set(loadList(SURNAMES_TXT)),
    english: new Set(english),
    rank,
    veto: new Set(english.slice(0, VETO_PREFIX)),
  };
  return data;
}

/** Lowercase + strip apostrophes/hyphens/accents for census-style lookup. */
function normalizeForLookup(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // decomposed diacritics
    .replace(/['’\-]/g, '');
}

/** Internal-capital morphology (McDonald, O'Brien, DeShawn): a capital after a
 * lowercase letter or apostrophe — English words never look like this, so a
 * list hit with this shape is name evidence at ANY rank. */
function hasInternalCapital(word: string): boolean {
  return /[a-zà-öø-ÿ'’][A-ZÀ-ÖØ-Þ]/.test(word);
}

/** True when a token counts as evidence of a real name.
 * FIRST-list hits need English rank > 2000 ("will", "may", "general" out).
 * SURNAME-only hits must be ABSENT from English entirely ("delacruz",
 * "okafor", "natarajan") — the census list is so inclusive that English-word
 * surnames above any rank bar still mass-match Title-Case FORM HEADERS
 * ("First Due Ems Care Report", "History Alcohol Drugs" — "ems" 10202,
 * "alcohol", "glasgow" are all census surnames). Field report 2026-07-17:
 * those solo hits shredded a real ePCR. English-word surnames keep their
 * power in PAIRS ("Donna Hitchcock" via the FIRST token; "SMITH, JOHN" via
 * the pair rule; "MR SMITH" via the anchor) and in internal-capital
 * morphology ("McDonald"); solo mid-sentence they fall to the NER net. */
/** Clinical eponyms that are also census surnames but read as scale/score
 * names in EMS text ("Glasgow Score", "Apgar"). Excluded from SOLO evidence
 * only — "Donna Glasgow" still masks via the pair rule. */
const EPONYM_EXCLUDE = new Set([
  'glasgow', 'apgar', 'braden', 'cincinnati', 'wells', 'morse',
  // name-list noise that reads as chart vocabulary, never as a patient name
  'temp', 'score', 'scale', 'exam', 'chart', 'triage',
  'onset', 'acuity', 'perl', 'sul', 'payer', 'transfer', 'evaluated',
  // EMS role/apparatus words that ride next to names and towns
  'paramedic', 'medic', 'fire', 'rescue', 'ambulance', 'firefighter',
  // demographic labels, equipment, and misc chart vocabulary (PCR-2/3 field tests)
  'male', 'female', 'birth', 'minor', 'vest', 'caregiver', 'ama',
  'gender', 'race', 'ethnicity', 'age', 'barracks', 'transport', 'pilot',
  // medical vocabulary that collides with the census surname list — masking a
  // DIAGNOSIS breaks QA (PCR-6: "shingles", "Flail" masked as people)
  'shingles', 'flail', 'colic', 'croup', 'bruit', 'clonus', 'emesis',
  'avulsion', 'stent', 'angina', 'ascites', 'stridor', 'rales', 'rhonchi',
]);

function nameEvidence(d: NameData, word: string): boolean {
  const internalCap = hasInternalCapital(word);
  const probe = (lower: string): boolean => {
    if (EPONYM_EXCLUDE.has(lower)) return false;
    const r = d.rank.get(lower);
    if (d.first.has(lower)) return r === undefined || r > FIRST_MIN_RANK;
    if (d.sur.has(lower)) return r === undefined || internalCap;
    return false;
  };
  if (probe(normalizeForLookup(word))) return true;
  if (/['’\-]/.test(word)) {
    for (const part of word.split(/['’\-]+/)) {
      if (part.length >= 2 && probe(normalizeForLookup(part))) return true;
    }
  }
  return false;
}

/** Rank-free list membership for a single word (whole or hyphen parts) —
 * exported for the Tier-2 NER plausibility gate. */
export function nameListHit(word: string): boolean {
  const d = nameData();
  const probe = (l: string) => d.first.has(l) || d.sur.has(l);
  if (probe(normalizeForLookup(word))) return true;
  if (/['’\-]/.test(word)) {
    for (const part of word.split(/['’\-]+/)) {
      if (part.length >= 2 && probe(normalizeForLookup(part))) return true;
    }
  }
  return false;
}

/** Exported for the Tier-2 NER plausibility gate. */
export function isCommonEnglish(word: string): boolean {
  return nameData().english.has(normalizeForLookup(word));
}

/** Honorific / role labels whose following capitalized tokens are names. */
const ANCHOR =
  /\b(?:patient|name|pt|resident|client|member|guardian|spouse|mother|father|mr|mrs|ms|dr|mx)\.?\s*[:\-]?\s*(?=[A-ZÀ-ÖØ-Þ])/gi;

// Letters incl. Latin-1 accents; word may contain apostrophes/hyphens.
const LETTER = 'A-Za-zÀ-ÖØ-öø-ÿ';
const WORD = new RegExp(`[${LETTER}][${LETTER}'’\\-]*`, 'g');
// Titlecase: leading capital, then letters — internal capitals allowed
// (McDonald, O'Brien, Jean-Pierre, DeShawn). Must contain at least one
// lowercase letter (else it is ALL-CAPS).
const TITLE_TOKEN = new RegExp(`^[A-ZÀ-ÖØ-Þ][${LETTER}'’\\-]*[a-zà-öø-ÿ][${LETTER}'’\\-]*$|^[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’\\-]*$`);
const ALLCAPS_TOKEN = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’\-]+$/;

/** Placeholders already in the text ([DATE-1948], [EMAIL_1], Person-3 …) must
 * never be re-examined. */
const PLACEHOLDER = /\[[A-Z_]+(?:-\d{2,4}|_\d+)?\]|(?:Person|Org|Location)-\d+/g;

type TokenKind = 'title' | 'allcaps' | 'lower' | 'other';

interface Token {
  /** Base text with any possessive suffix stripped. */
  text: string;
  start: number;
  /** End of the BASE (possessive 's excluded — the mask keeps it). */
  end: number;
  kind: TokenKind;
  sentenceInitial: boolean;
}

function classify(word: string): TokenKind {
  if (ALLCAPS_TOKEN.test(word)) return 'allcaps';
  if (TITLE_TOKEN.test(word)) return 'title';
  if (word === word.toLowerCase()) return 'lower';
  return 'other';
}

function tokenize(text: string): Token[] {
  // Mark spans covered by existing placeholders as untouchable.
  const blocked: Array<[number, number]> = [];
  PLACEHOLDER.lastIndex = 0;
  for (const m of text.matchAll(PLACEHOLDER)) blocked.push([m.index, m.index + m[0].length]);
  const isBlocked = (s: number, e: number) => blocked.some(([bs, be]) => s < be && e > bs);

  const tokens: Token[] = [];
  WORD.lastIndex = 0;
  for (const m of text.matchAll(WORD)) {
    let word = m[0];
    const start = m.index;
    if (isBlocked(start, start + word.length)) continue;
    // Strip a possessive suffix ("Donna's" / "DONNA'S" → "Donna"/"DONNA");
    // the base is what gets classified/masked, the 's survives outside it.
    word = word.replace(/['’][sS]$/, '');
    if (word.length === 0) continue;
    const end = start + word.length;
    const before = text.slice(0, start);
    const sentenceInitial = /(?:^|[.!?\n])\s*$/.test(before);
    tokens.push({ text: word, start, end, kind: classify(word), sentenceInitial });
  }
  return tokens;
}

/** Derive the next Person counter from an existing pseudonym map (mirrors
 * tier2's convention so numbering stays continuous across layers). */
function nextPersonCounter(pseudonyms: PseudonymMap): number {
  let max = 0;
  for (const placeholder of Object.values(pseudonyms)) {
    const m = /^Person-(\d+)$/.exec(placeholder);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

interface Span {
  start: number;
  end: number;
  original: string;
}

/**
 * Find every span the deterministic rules classify as a person name.
 * Exported for the leak test; scrubNames() applies them.
 */
export function findNameSpans(text: string): Span[] {
  const d = nameData();
  const { english, veto } = d;
  const evidence = (w: string): boolean => nameEvidence(d, w);
  /** Rank-free list membership (whole token or any hyphen part) — used by the
   * FIRST→SUR adjacency rule and the caps-run membership test, where the rank
   * guards would blind us to the most common American names (adversarial
   * review round 2: "John Smith" must not be invisible). */
  const partsOf = (w: string): string[] => {
    const whole = normalizeForLookup(w);
    const parts = /['’\-]/.test(w)
      ? w.split(/['’\-]+/).filter((p) => p.length >= 2).map(normalizeForLookup)
      : [];
    return [whole, ...parts];
  };
  // Pair-rule membership: list hit, not an eponym, and NOT an ultra-common
  // English word — "for" (rank 7) and "this" (12) are census surnames, and
  // without the floor "Reason For" reads as a FIRST→SUR name pair. The >300
  // floor keeps "john" (372), the lowest-ranked real given name we must hold.
  const pairRankOk = (p: string): boolean => {
    const r = d.rank.get(p);
    return r === undefined || r > 300;
  };
  /** Could this token BE part of a name? List-hit above the anchor floor
   * (350: keeps "john" 372/"smith" 1282, drops "care" 309/"date" 102), or an
   * off-English rare word. Forms glue labels into Title runs ("Bourne Fire
   * Department Patient Information Last Name") — non-name-ish tokens SEGMENT
   * such runs so only the name-ish core masks (ePCR field test 2026-07-17). */
  const nameish = (t: Token): boolean => {
    if (t.text.length < 2 || EPONYM_EXCLUDE.has(normalizeForLookup(t.text))) return false;
    const anyPart = (pred: (p: string) => boolean) => partsOf(t.text).some(pred);
    const rankOk = (p: string) => {
      const r = d.rank.get(p);
      return r === undefined || r > 350;
    };
    if (
      anyPart(
        (p) => (d.first.has(p) || d.sur.has(p)) && rankOk(p) && !EPONYM_EXCLUDE.has(p),
      )
    )
      return true;
    // Off-English fallback — but a hyphen compound whose every PART is common
    // English or excluded vocabulary ("Pilot-Transport", "Caregiver-Transport")
    // is chart language, not a rare name (PCR-5 glue artifact).
    if (/['’\-]/.test(t.text)) {
      const parts = t.text.split(/['’\-]+/).filter((p) => p.length >= 2);
      if (
        parts.length > 0 &&
        parts.every((p) => {
          const n = normalizeForLookup(p);
          return english.has(n) || EPONYM_EXCLUDE.has(n);
        })
      )
        return false;
    }
    return !english.has(normalizeForLookup(t.text));
  };
  const firstAny = (w: string): boolean =>
    partsOf(w).some((p) => d.first.has(p) && !EPONYM_EXCLUDE.has(p) && pairRankOk(p));
  const surAny = (w: string): boolean =>
    partsOf(w).some((p) => d.sur.has(p) && !EPONYM_EXCLUDE.has(p) && pairRankOk(p));
  const listAny = (w: string): boolean => firstAny(w) || surAny(w);
  /** ALL-CAPS token eligible to sit in a caps name run. */
  const capsCandidate = (t: Token): boolean =>
    t.kind === 'allcaps' &&
    !CAPS_EXCLUDE.has(normalizeForLookup(t.text)) &&
    (listAny(t.text) || !english.has(normalizeForLookup(t.text)));
  /** ALL-CAPS token acceptable AFTER an anchor. List membership with split
   * rank guards (round 3): FIRST needs rank > 300 — keeps JOHN (372), DAVID
   * (730), drops MAY (55); SURNAME needs rank > 1000 — keeps SMITH (1282),
   * BROWN (1268), drops WAS/ON/TO/AND. Off-English rare tokens ("ZYLER")
   * always qualify. Rank alone cannot do this: "john" outranks "able". */
  const capsAnchorable = (t: Token): boolean => {
    if (t.kind !== 'allcaps' || CAPS_EXCLUDE.has(normalizeForLookup(t.text))) return false;
    const norm = normalizeForLookup(t.text);
    if (!english.has(norm)) return true;
    const r = d.rank.get(norm) ?? Number.MAX_SAFE_INTEGER;
    if (firstAny(t.text) && r > 300) return true;
    if (surAny(t.text) && r > 1000) return true;
    return false;
  };
  /** A run reads as a person when it has hard evidence OR the classic
   * given-name-then-surname signature ("John Smith": both rank-blocked as
   * single words, unmistakable as a pair — while "Vital Signs" and "Chief
   * Complaint" never fire because their words are surname-list-only). */
  const runIsName = (run: Token[]): boolean => {
    if (run.some((t) => evidence(t.text))) return true;
    for (let i = 0; i + 1 < run.length; i += 1) {
      if (firstAny(run[i]!.text) && surAny(run[i + 1]!.text)) return true;
    }
    return false;
  };
  const tokens = tokenize(text);
  /** PDF extractors split words with stray spaces ("Revise d Traum a Score",
   * "res ponse"). The reliable signal: the hit REJOINED with its neighbor is
   * an English word — traum+a=trauma, res+ponse=response — while a real name
   * never is (donna+is=donnais). PCR field tests 2026-07-17. */
  const splitArtifact = (idx: number): boolean => {
    const t = tokens[idx]!;
    const joined = (a: Token, b: Token): boolean =>
      /^\s+$/.test(text.slice(a.end, b.start)) &&
      english.has(normalizeForLookup(a.text + b.text));
    const next = tokens[idx + 1];
    if (next && joined(t, next)) return true;
    const prev = tokens[idx - 1];
    if (prev && joined(prev, t)) return true;
    return false;
  };
  const spans: Span[] = [];
  // Overlapping claims MERGE into their union rather than dropping — an anchor
  // claims 3 tokens of "MARIA GARCIA LOPEZ HERNANDEZ" and the caps-run rule
  // claims all 4; the union masks the whole name (round-3 R1: dropping the
  // second claim leaked the 4th surname).
  const claim = (start: number, end: number) => {
    let s0 = start;
    let e0 = end;
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const sp = spans[i]!;
      if (s0 < sp.end && e0 > sp.start) {
        s0 = Math.min(s0, sp.start);
        e0 = Math.max(e0, sp.end);
        spans.splice(i, 1);
      }
    }
    spans.push({ start: s0, end: e0, original: text.slice(s0, e0) });
  };
  // Whitespace-only contiguity: a possessive tail does NOT bridge tokens —
  // "SMITH-JONES'S CHART" masks the name, never the chart (round 3).
  const contiguous = (a: Token, b: Token) => /^\s+$/.test(text.slice(a.end, b.start));

  // 1. Label anchors: up to 3 tokens right after an anchor (one comma
  //    allowed, for the chart-classic "PATIENT: SMITH, JOHN"). Titlecase
  //    tokens are accepted unconditionally. ALL-CAPS tokens are accepted when
  //    they are on a name list at ANY rank (the anchor itself is the
  //    evidence — "MR SMITH" must mask) or absent from English entirely
  //    ("PT ZYLER QUANDRIL"), never when excluded ("PT ALS INTERCEPT",
  //    "…DOB 03/15/1948"); ordinary words end the run ("PT COMPLAINED OF…").
  ANCHOR.lastIndex = 0;
  for (const m of text.matchAll(ANCHOR)) {
    const anchorEnd = m.index + m[0].length;
    const seq: Token[] = [];
    let cursor = anchorEnd;
    let commaUsed = false;
    for (const t of tokens) {
      if (t.start < anchorEnd) continue;
      if (seq.length === 3) break;
      const gap = text.slice(cursor, t.start);
      if (!/^\s*$/.test(gap)) {
        if (seq.length > 0 && !commaUsed && /^,\s*$/.test(gap)) commaUsed = true;
        else break;
      }
      const acceptable =
        (t.kind === 'title' && nameish(t)) || (t.kind === 'allcaps' && capsAnchorable(t));
      if (!acceptable) break;
      seq.push(t);
      cursor = t.end;
    }
    if (seq.length > 0) claim(seq[0]!.start, seq[seq.length - 1]!.end);
  }

  // 2. Titlecase runs, SEGMENTED: contiguous Titlecase words are first split
  //    into name-ish segments (label words like "Information"/"Last"/"Name"
  //    break them), then a segment masks when it reads as a person (evidence
  //    or the FIRST→SUR pair signature). "Bourne Fire Department Patient
  //    Information Last Name" masks only "Bourne"; "Eric Audette Paramedic"
  //    masks only "Eric Audette".
  {
    let run: Token[] = [];
    const flushSegments = () => {
      let seg: Token[] = [];
      const flushSeg = () => {
        if (
          seg.length >= 1 &&
          runIsName(seg) &&
          !(seg.length === 1 && splitArtifact(tokens.indexOf(seg[0]!)))
        )
          claim(seg[0]!.start, seg[seg.length - 1]!.end);
        seg = [];
      };
      for (const t of run) {
        if (nameish(t)) seg.push(t);
        else flushSeg();
      }
      flushSeg();
      run = [];
    };
    for (const t of tokens) {
      if (t.kind === 'title' && (run.length === 0 || contiguous(run[run.length - 1]!, t))) {
        run.push(t);
      } else {
        flushSegments();
        if (t.kind === 'title') run = [t];
      }
    }
    flushSegments();
  }

  // 3. ALL-CAPS name runs: contiguous caps candidates (name-listed at any
  //    rank, or off-English rare tokens — never excluded acronyms/labels/
  //    narrative verbs) that read as a person. Membership is deliberately
  //    narrow: greedily merging ANY capitalized neighbor would swallow whole
  //    caps sentences. A single caps token still needs hard evidence
  //    ("DONNA" masks; bare "SMITH" stays a documented residual).
  {
    let run: Token[] = [];
    const flush = () => {
      if (run.length >= 1 && runIsName(run)) claim(run[0]!.start, run[run.length - 1]!.end);
      run = [];
    };
    for (const t of tokens) {
      if (capsCandidate(t) && (run.length === 0 || contiguous(run[run.length - 1]!, t))) {
        run.push(t);
      } else {
        flush();
        if (capsCandidate(t)) run = [t];
      }
    }
    flush();
  }

  // 3b. Cross-format pairs (round 3, R2/R3): the run rules require uniform
  //     casing and whitespace contiguity, which misses two real conventions —
  //     surname-caps "John SMITH" and the face-sheet "SMITH, JOHN" /
  //     "Smith, John". A capitalized pair (either casing; caps side must be a
  //     caps candidate) masks when it carries the name signature:
  //     FIRST→SUR across whitespace, or SUR,FIRST across one comma.
  {
    const pairable = (t: Token): boolean =>
      t.kind === 'title' || capsCandidate(t);
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const a = tokens[i]!;
      const b = tokens[i + 1]!;
      if (!pairable(a) || !pairable(b)) continue;
      const gap = text.slice(a.end, b.start);
      if (/^\s+$/.test(gap)) {
        if (firstAny(a.text) && surAny(b.text)) claim(a.start, b.end);
      } else if (/^,\s*$/.test(gap)) {
        if (surAny(a.text) && firstAny(b.text)) claim(a.start, b.end);
      }
    }
  }

  // 4. Single Titlecase tokens.
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'title') {
      if (!evidence(t.text)) continue;
      // Tiny sentence-initial veto: high-frequency English word ("Will",
      // "May") followed by a lowercase word — reads as grammar, not a name.
      const next = tokens[i + 1];
      const nextIsLower = !!next && t.kind === 'title' && /^[a-zà-öø-ÿ]/.test(next.text);
      if (t.sentenceInitial && veto.has(normalizeForLookup(t.text)) && nextIsLower) continue;
      if (splitArtifact(i)) continue; // PDF word-split ("Traum a")
      claim(t.start, t.end);
    } else if (t.kind === 'lower') {
      // Lowercase: name-evidence word that is NOT common English ("cabral").
      // 5+ chars: short off-English words that happen to be census surnames
      // ("vile", "sul") read as prose, not names (field report 2026-07-17).
      if (
        !splitArtifact(i) && // "res ponse" tails are wrapped words, not names
        t.text.length >= 5 &&
        evidence(t.text) &&
        !english.has(normalizeForLookup(t.text))
      )
        claim(t.start, t.end);
    }
  }

  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Rewrite every deterministic name span to a Person-N pseudonym, reusing (and
 * extending) the shared PseudonymMap so the same name maps to the same
 * placeholder as Tier-2 NER output.
 */
export function scrubNames(
  text: string,
  pseudonyms: PseudonymMap,
): { text: string; replacements: Replacement[] } {
  const spans = findNameSpans(text);
  let counter = nextPersonCounter(pseudonyms);
  const replacements: Replacement[] = [];
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const key = span.original.toLowerCase();
    let placeholder = pseudonyms[key];
    if (placeholder === undefined) {
      counter += 1;
      placeholder = `Person-${counter}`;
      pseudonyms[key] = placeholder;
    }
    if (!replacements.some((r) => r.placeholder === placeholder)) {
      replacements.push({
        placeholder,
        original: span.original,
        tier: 2,
        kind: 'person',
        restorable: true,
      });
    }
    out += text.slice(cursor, span.start) + placeholder;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, replacements };
}
