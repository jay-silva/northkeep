/**
 * Pure fold from per-kind NER pass records to the audit view's degrade
 * summary, plus the exact user-facing copy. Invariant #6 (degrade privacy
 * loudly): a turn where the Tier-2 name net ran only partially, or not at
 * all, must be visible in "What left this device", not just in a console
 * warning. Everything here is content-free by construction: pass ids only
 * ('person', 'org', 'street', 'place', 'single'), never vault text.
 *
 * No React Native / Expo imports (repo convention) so this is unit-tested
 * under Node in apps/mobile/test/ner-degrade.test.ts.
 */

/** The slice of a NerPassEvent this fold needs (structural, so no dependency
 * on the platform-mobile dist types from a pure module). */
export interface NerPassRecord {
  pass: string;
  ok: boolean;
}

/**
 * Unique ids of passes that failed at least once this turn, in first-failure
 * order. runTurn re-redacts the whole prompt, so one turn can run each pass
 * several times; "failed at least once" is the honest summary for the user.
 */
export function foldFailedNerPasses(events: ReadonlyArray<NerPassRecord>): string[] {
  const failed: string[] = [];
  for (const event of events) {
    if (!event.ok && !failed.includes(event.pass)) failed.push(event.pass);
  }
  return failed;
}

/** Shown when the Tier-2 name net did not run at all (runTurn tier2Degraded). */
export const TIER2_UNAVAILABLE_MESSAGE =
  'Tier 2 name detection was unavailable for this turn. Deterministic masking still ran.';

/**
 * Shown when some per-kind passes failed but others ran, e.g.
 * "Name detection ran partially: the person pass failed this turn."
 * Returns '' for an empty list (nothing to warn about).
 */
export function partialNerFailureMessage(failedPasses: ReadonlyArray<string>): string {
  if (failedPasses.length === 0) return '';
  const noun = failedPasses.length === 1 ? 'pass' : 'passes';
  return `Name detection ran partially: the ${listWords(failedPasses)} ${noun} failed this turn.`;
}

function listWords(items: ReadonlyArray<string>): string {
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
