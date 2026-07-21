/**
 * TODO: Apple FM NER path retired in favor of NLTagger 2026-07-21; kept for
 * rollback, delete after on-device acceptance. This per-kind machinery drove the
 * Apple FM client (ner-adapter.ts) and is no longer wired into the mobile send
 * path (apps/mobile now uses NLTagger, nltagger-ner.ts). extractNerText below is
 * still REUSED by the NLTagger client to recover the text from the applyTier2
 * prompt; the rest stays unreferenced-but-intact so the swap is reversible.
 *
 * Per-kind NER decomposition for the on-device Tier-2 client (pure logic).
 *
 * WHY: with the one do-everything NER prompt, Apple FM measured ~35-39% strict
 * recall on the in-app eval (0 model errors, so that IS the model's quality
 * with a generic instruction). Small models do measurably better with one
 * narrow instruction plus one tight example, so the mobile NER client
 * decomposes its single applyTier2 call into K focused passes (one per entity
 * family) and merges the results. The shared pipeline in packages/redact is
 * UNCHANGED: applyTier2 still makes ONE generateJson(prompt) call and parses
 * ONE {"entities":[...]} reply; the decomposition happens entirely inside the
 * client behind that seam. Desktop Ollama keeps its single-prompt path.
 *
 * KINDS: passes stay within the pipeline's EntityKind space (person | org |
 * location) because applyTier2 coerces any other kind to 'person' and the
 * pseudonym prefixes only exist for these three. Dates of birth and record /
 * account numbers are deliberately NOT NER passes: generalizeDates and the
 * Tier-1 labeled detectors already handle them deterministically, and routing
 * them through NER would mint bogus Person-N pseudonyms. Location is split in
 * two (street addresses vs cities/places) because those are distinct
 * recognition tasks for a small model.
 *
 * This module is pure (no React Native / Expo imports) so it is unit-tested
 * in packages/platform-mobile/test/per-kind-ner.test.ts with a fake model.
 */

export type NerEntityKind = 'person' | 'org' | 'location';

export interface NerEntity {
  text: string;
  kind: NerEntityKind;
}

export interface NerPass {
  /** Diagnostics id shown on the eval screen ('person', 'org', 'street', 'place'). */
  id: string;
  /** Forced onto every span this pass returns, so pass identity guarantees kind. */
  kind: NerEntityKind;
  buildPrompt(text: string): string;
}

/** One pass result event, driving per-pass diagnostics on the eval screen. */
export interface NerPassEvent {
  pass: string;
  ok: boolean;
  ms: number;
  /** Salvaged raw reply on success (what the parser saw). */
  raw?: string;
  /** Failure reason on error. Kept content-free: never includes vault text. */
  error?: string;
}

export interface RunPerKindOptions {
  onPass?: (event: NerPassEvent) => void;
  /** Ceiling for a single pass. Focused passes are smaller than the old
   * do-everything call, so this is tighter than the legacy 25s bound. */
  perPassTimeoutMs?: number;
  /** Wall-clock budget across ALL passes of one applyTier2 call; passes that
   * would start with less than MIN_PASS_BUDGET_MS of it left are skipped
   * (recorded, never silent). */
  totalBudgetMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const PER_PASS_TIMEOUT_MS = 12_000;
export const TOTAL_BUDGET_MS = 30_000;

/** A pass is not worth starting with less than this much budget left: it is a
 * guaranteed timeout (and, per the abandonment rule below, would also wedge
 * the rest of the run). Such passes are recorded as budget-skipped instead. */
export const MIN_PASS_BUDGET_MS = 2_000;

/**
 * Thrown by the adapter's per-pass timeout wrapper (ner-adapter.ts) so
 * runPerKindNer can tell a WEDGED model call apart from a parse/other failure.
 * The distinction matters: generateStructured takes no abort signal, so a
 * timed-out native call is STILL RUNNING when the promise race rejects, and
 * the Apple FM bridge is driven strictly one call at a time. Issuing the next
 * pass would stack a second concurrent call on it, so a timeout abandons the
 * remaining passes of the run; a parse failure is safe to continue past.
 */
export class NerPassTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NerPassTimeoutError';
  }
}

/** Defensive ceiling on spans accepted from one pass (a looping model must
 * not flood the merge); applyTier2 re-validates every span downstream. */
export const MAX_ENTITIES_PER_PASS = 40;

/**
 * The marker applyTier2's NER prompt places between its instructions and the
 * text under analysis (packages/redact/src/tier2.ts detectEntities). The
 * client splits the incoming prompt here to recover the text for the per-kind
 * prompts. tier2.ts carries a matching do-not-drift comment.
 */
export const NER_PROMPT_TEXT_MARKER = '\nText:\n';

/** Recover the text under analysis from the applyTier2 NER prompt, or null
 * when the prompt does not carry the marker (caller falls back to a single
 * legacy pass so behavior never regresses on an unexpected prompt shape). */
export function extractNerText(prompt: string): string | null {
  const i = prompt.indexOf(NER_PROMPT_TEXT_MARKER);
  return i >= 0 ? prompt.slice(i + NER_PROMPT_TEXT_MARKER.length) : null;
}

/**
 * The per-kind prompt table (K = 4). Each prompt is ONE narrow instruction
 * plus ONE example in/out pair in the exact output shape the salvage parser
 * and applyTier2 already expect. NO JSON Schema text: appending a raw schema
 * to the prompt is what caused the Apple FM duplicated-key artifact
 * ({"text": "text":"John"}) in the first place. Example spans are invented;
 * applyTier2's span-must-appear-in-text check drops any the model parrots.
 */
export const NER_PASSES: NerPass[] = [
  {
    id: 'person',
    kind: 'person',
    buildPrompt: (text) => `Find every person's name in the text. Respond with JSON only.
Example text: Email Dana Whitfield about the meeting with Dr. Alan Voss.
Example reply: {"entities":[{"text":"Dana Whitfield","kind":"person"},{"text":"Alan Voss","kind":"person"}]}
Copy each name EXACTLY as it appears. Skip titles alone, job roles, and generic words. Reply {"entities":[]} if none.
Text:
${text}`,
  },
  {
    id: 'org',
    kind: 'org',
    buildPrompt: (text) => `Find every organization name in the text: companies, employers, agencies, clinics, schools, courts, and associations. Respond with JSON only.
Example text: She joined Ridgeline Capital after leaving Bayview Health Cooperative.
Example reply: {"entities":[{"text":"Ridgeline Capital","kind":"org"},{"text":"Bayview Health Cooperative","kind":"org"}]}
Copy each name EXACTLY as it appears. Skip generic phrases like "the company". Reply {"entities":[]} if none.
Text:
${text}`,
  },
  {
    id: 'street',
    kind: 'location',
    buildPrompt: (text) => `Find every street address or street name in the text. Respond with JSON only.
Example text: The unit on Calder Avenue is nicer than the one at 44 Birchwood Lane.
Example reply: {"entities":[{"text":"Calder Avenue","kind":"location"},{"text":"44 Birchwood Lane","kind":"location"}]}
Copy each EXACTLY as it appears. Skip cities and countries in this list. Reply {"entities":[]} if none.
Text:
${text}`,
  },
  {
    id: 'place',
    kind: 'location',
    buildPrompt: (text) => `Find every city, town, region, or named place or building in the text. Respond with JSON only.
Example text: She drove from Marlow Falls to the Kestrel Harbor ferry terminal.
Example reply: {"entities":[{"text":"Marlow Falls","kind":"location"},{"text":"Kestrel Harbor","kind":"location"}]}
Copy each EXACTLY as it appears. Skip street addresses in this list. Reply {"entities":[]} if none.
Text:
${text}`,
  },
];

/**
 * Mechanical reply cleanup, applied to EVERY pass reply: salvage down to the
 * outermost {...} (strips code fences / stray prose) and repair the observed
 * Apple FM duplicated-key artifact ("text": "text":"value"). Mirrors
 * AppleFMModel.generateStructured and is idempotent, so applying it both
 * there and here is safe for every backend.
 */
export function salvageEntityJson(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const sliced = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  return sliced.replace(/"(text|kind)":\s*"(?:text|kind)":/g, '"$1":');
}

/**
 * Parse one pass's salvaged reply. The pass's kind is FORCED onto every span
 * (pass identity guarantees kind; small models mislabel the echo field).
 * Throws on structural failure so the caller can record a per-pass error;
 * messages are content-free by construction.
 */
export function parseEntityReply(raw: string, kind: NerEntityKind): NerEntity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(salvageEntityJson(raw));
  } catch {
    throw new Error('non-JSON reply');
  }
  const list = (parsed as { entities?: unknown }).entities;
  if (!Array.isArray(list)) {
    throw new Error('reply missing an entities array');
  }
  const out: NerEntity[] = [];
  for (const item of list.slice(0, MAX_ENTITIES_PER_PASS)) {
    const record = item as { text?: unknown };
    if (typeof record.text !== 'string') continue;
    const span = record.text.trim();
    if (span.length < 2 || span.length > 100) continue;
    out.push({ text: span, kind });
  }
  return out;
}

/**
 * Merge per-pass entity lists. The ONLY collapse is a case-insensitive EXACT
 * duplicate (the same span found by two passes), which keeps the EARLIER
 * pass's kind (NER_PASSES order, then discovery order, so the merge is
 * deterministic and person outranks an org echo of the same span).
 *
 * Overlapping-but-different spans are ALL kept, deliberately. Downstream
 * applyTier2 (packages/redact/src/tier2.ts) sorts entities longest-first and
 * replaces whole-word occurrences, so nested spans are handled correctly
 * there: "Annapolis Shipyards" is masked before "Ann", and a STANDALONE "Ann"
 * elsewhere in the text still gets its own pseudonym. Dropping the contained
 * span here (the old rule) left those standalone occurrences unmasked, which
 * is a leak, not a dedupe.
 */
export function mergeEntities(perPass: NerEntity[][]): NerEntity[] {
  const seen = new Set<string>();
  const kept: NerEntity[] = [];
  for (const list of perPass) {
    for (const entity of list) {
      const key = entity.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(entity);
    }
  }
  return kept;
}

/**
 * Run the K per-kind passes SEQUENTIALLY (the Apple FM bridge is driven one
 * call at a time everywhere else in this package; concurrent sessions are
 * unverified on device) and return ONE merged {"entities":[...]} JSON string,
 * the exact contract applyTier2's parser expects from generateJson.
 *
 * Degraded-proceeds: a pass that throws a parse/other failure is recorded via
 * onPass and the remaining passes still run. A pass that TIMES OUT
 * (NerPassTimeoutError) is recorded and ABANDONS the rest of the run: the
 * timed-out native call is still executing (no abort signal), and the bridge
 * is single-call-only, so issuing further passes would stack concurrent
 * calls. Whatever merged so far is returned. Only when NO pass succeeded does
 * this throw, which applyTier2 converts to tier2Degraded exactly like a
 * failed single call today. Tier-1 is never touched by any of this.
 *
 * `callModel(prompt, timeoutMs)` must resolve to the model's raw reply and
 * reject with NerPassTimeoutError on timeout; the adapter wraps
 * generateStructured plus its timeout there. timeoutMs shrinks as the total
 * budget is spent; passes with less than MIN_PASS_BUDGET_MS left (a
 * guaranteed timeout) are skipped and recorded, keeping worst-case wall-clock
 * bounded.
 */
export async function runPerKindNer(
  text: string,
  callModel: (prompt: string, timeoutMs: number) => Promise<string>,
  options: RunPerKindOptions = {},
): Promise<string> {
  const perPassTimeout = options.perPassTimeoutMs ?? PER_PASS_TIMEOUT_MS;
  const budget = options.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const now = options.now ?? Date.now;
  const started = now();

  const lists: NerEntity[][] = [];
  const failures: string[] = [];
  let timedOut = false;
  for (const pass of NER_PASSES) {
    if (timedOut) {
      // An earlier pass wedged the (single-call-only) bridge; do not stack
      // another native call on it. Recorded, never silent.
      failures.push(`${pass.id}: skipped, earlier pass timed out`);
      options.onPass?.({ pass: pass.id, ok: false, ms: 0, error: 'skipped: earlier pass timed out' });
      continue;
    }
    const remaining = budget - (now() - started);
    if (remaining < MIN_PASS_BUDGET_MS) {
      failures.push(`${pass.id}: skipped, time budget exhausted`);
      options.onPass?.({ pass: pass.id, ok: false, ms: 0, error: 'skipped: time budget exhausted' });
      continue;
    }
    const passStart = now();
    try {
      const raw = salvageEntityJson(
        await callModel(pass.buildPrompt(text), Math.min(perPassTimeout, remaining)),
      );
      lists.push(parseEntityReply(raw, pass.kind));
      options.onPass?.({ pass: pass.id, ok: true, ms: now() - passStart, raw });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${pass.id}: ${message}`);
      options.onPass?.({ pass: pass.id, ok: false, ms: now() - passStart, error: message });
      if (err instanceof NerPassTimeoutError) timedOut = true;
    }
  }

  if (lists.length === 0) {
    throw new Error(`All ${NER_PASSES.length} NER passes failed: ${failures.join('; ')}`);
  }
  return JSON.stringify({ entities: mergeEntities(lists) });
}
