import type { OllamaClient } from '@northkeep/librarian';
import { isCommonEnglish, nameListHit } from './names.js';
import type { EntityKind, PseudonymMap, Replacement } from './types.js';

/**
 * Tier-2: on-device named-entity pseudonymization. A local model finds
 * people, orgs, and locations; each maps to a stable pseudonym (Person-1,
 * Org-2) so the same entity reads consistently and the response can be
 * restored. 85–95% recall in-domain — good, not perfect (see KNOWN-LIMITS).
 *
 * Unavailable without Ollama: the caller degrades LOUDLY (invariant #6),
 * never silently drops to Tier-1.
 */

const PREFIX: Record<EntityKind, string> = { person: 'Person', org: 'Org', location: 'Place' };

interface EntityHit {
  text: string;
  kind: EntityKind;
}

export interface Tier2Outcome {
  text: string;
  replacements: Replacement[];
  degraded: boolean;
}

export async function applyTier2(
  text: string,
  ollama: OllamaClient | null,
  pseudonyms: PseudonymMap,
  /** Strict gate (Tier 3): the deterministic layers own common names there,
   * so NER is restricted to plausible RESIDUALS (off-English tokens). Tier 2
   * standalone keeps full legacy recall — NER is its only name layer. */
  strictGate = false,
): Promise<Tier2Outcome> {
  if (ollama === null || !(await ollama.available())) {
    return { text, replacements: [], degraded: true };
  }
  let entities: EntityHit[];
  try {
    entities = await detectEntities(text, ollama, strictGate);
  } catch {
    return { text, replacements: [], degraded: true };
  }

  // Longest-first so "Bob Henderson" is replaced before a stray "Bob".
  entities.sort((a, b) => b.text.length - a.text.length);
  const counters = new Map<EntityKind, number>();
  for (const placeholder of Object.values(pseudonyms)) {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(placeholder);
    if (m) {
      const kind = (Object.keys(PREFIX) as EntityKind[]).find((k) => PREFIX[k] === m[1]);
      if (kind) counters.set(kind, Math.max(counters.get(kind) ?? 0, Number(m[2])));
    }
  }

  const replacements: Replacement[] = [];
  let out = text;
  for (const entity of entities) {
    const key = entity.text.toLowerCase();
    let placeholder = pseudonyms[key];
    if (placeholder === undefined) {
      const n = (counters.get(entity.kind) ?? 0) + 1;
      counters.set(entity.kind, n);
      placeholder = `${PREFIX[entity.kind]}-${n}`;
      pseudonyms[key] = placeholder;
    }
    // Whole-word, case-insensitive replacement of every occurrence.
    const re = new RegExp(`\\b${escapeRegex(entity.text)}\\b`, 'gi');
    if (!re.test(out)) continue;
    out = out.replace(re, placeholder);
    if (!replacements.some((r) => r.placeholder === placeholder)) {
      replacements.push({
        placeholder,
        original: entity.text,
        tier: 2,
        kind: entity.kind,
        restorable: true, // pseudonyms round-trip on the way back
      });
    }
  }
  return { text: out, replacements, degraded: false };
}

async function detectEntities(
  text: string,
  ollama: OllamaClient,
  strictGate: boolean,
): Promise<EntityHit[]> {
  const prompt = `Extract named entities from the text. Respond with JSON only:
{"entities":[{"text":"exact span","kind":"person|org|location"}]}

Rules: person = individual people's names; org = companies/institutions;
location = specific places (streets, cities, buildings). Copy the span
EXACTLY as it appears. Skip generic words, titles alone, dates, and numbers.
{"entities":[]} if none.

Text:
${text.slice(0, 6000)}`;
  const raw = await ollama.generateJson(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable model output is a FAILURE, not "no entities" — throw so the
    // caller marks Tier-2 degraded (invariant #6) rather than silently
    // passing names through unpseudonymized.
    throw new Error('Tier-2 model returned non-JSON output.');
  }
  const list = (parsed as { entities?: unknown }).entities;
  if (!Array.isArray(list)) {
    throw new Error('Tier-2 model output missing an entities array.');
  }
  const hits: EntityHit[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const record = item as { text?: unknown; kind?: unknown };
    if (typeof record.text !== 'string') continue;
    const span = record.text.trim();
    if (span.length < 2 || span.length > 100) continue;
    if (!text.includes(span)) continue; // model must quote real spans, not invent
    if (!plausibleEntity(span, strictGate)) continue; // 3B junk gate (field report 2026-07-17)
    const kind =
      record.kind === 'org' || record.kind === 'location' ? record.kind : 'person';
    const key = span.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ text: span, kind: kind as EntityKind });
  }
  return hits;
}

/** Placeholders our own layers emitted — the model must NEVER re-mask them
 * ("Person-1" → "Person-2" cascade corruption, seen on a real ePCR). */
const PLACEHOLDER_SPAN = /\[[A-Z_]+(?:-\d{2,4}|_\d+)?\]|\b(?:Person|Org|Place|Location)-\d+\b/;

/**
 * Plausibility gate for 3B-model entity spans. On structured documents the
 * small model labels FORM FIELD HEADERS ("Sex", "Date", "Arrived", "Situation
 * Symptom Onset"), hex IDs ("8ca72b71"), and stray adjectives ("vile") as
 * people. A span may be masked only when it contains something that could
 * actually be a name: a name-list token at any rank, or a real word (3+
 * letters) absent from common English ("Zyler", "Natarajan", "Barnstable").
 * Spans containing our own placeholders are always refused.
 */
function plausibleEntity(span: string, strictGate: boolean): boolean {
  if (PLACEHOLDER_SPAN.test(span)) return false;
  const tokens = span.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*/g) ?? [];
  if (tokens.length === 0) return false; // pure digits/punctuation is not a name
  if (!strictGate) {
    // Tier 2: NER is the ONLY name layer, and legitimate org names are often
    // built entirely from common English words ("Cascade Analytics", "First
    // National Bank") — filtering them would cut real recall (caught by the
    // eval harness's perfect-backend gate). Only the placeholder ban applies.
    return true;
  }
  // Tier 3 strict: common-English tokens are the deterministic layers' job
  // ("Donna", "Smith"); NER may only add masks for OFF-English residuals
  // ("Zyler", "Natarajan") — the census list is too full of English words
  // ("date", "vile", "sul" are all surnames) to trust list membership here.
  // Names in prose are capitalized: a span with no capitalized token is a
  // stray word ("vile"), not a person — refuse it outright.
  if (!tokens.some((t) => /^[A-ZÀ-ÖØ-Þ]/.test(t))) return false;
  return tokens.some((t) => !isCommonEnglish(t) && (t.length >= 3 || nameListHit(t)));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
