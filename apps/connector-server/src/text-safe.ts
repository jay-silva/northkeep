/**
 * Copy of packages/core/src/text-safe.ts (the connector cannot import core).
 * A test keeps the two giving the same answers.
 */

/**
 * Cc and Cf cover NEL, the bidi overrides and the BOM; U+2028 and U+2029 are
 * Zl and Zp, so they need naming.
 */
const UNSAFE_CODE_POINTS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A surrogate half without its partner: not a character, and JSON escapes it as one. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** ADR 0092 section 1: a memory line beside the note, as one line. Whitespace goes first, so a break never joins two words. */
export function flatLine(input: string): string {
  return input
    .replace(/[\s\u0085\u2028\u2029]+/gu, ' ')
    .replace(UNSAFE_CODE_POINTS, '')
    .replace(UNPAIRED_SURROGATE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Removes rather than substitutes, so a terminator cannot survive as a gap the
 * eye still reads as a break. Caps in UTF-16 units, the unit core's writer
 * validation counts, without splitting a pair.
 */
export function tameOneLine(input: string, max: number): string {
  const stripped = input
    .replace(UNSAFE_CODE_POINTS, '')
    .replace(UNPAIRED_SURROGATE, '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  for (const cp of stripped) {
    if (out.length + cp.length > max) break;
    out += cp;
  }
  return out;
}

/** ADR 0085 D1: an app's self-reported name as NorthKeep stores it. */
export const APP_NAME_MAX = 80;

/** The OAuth client_name as stored and shown; undefined when nothing printable is left. */
export function tameAppName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const tamed = tameOneLine(raw, APP_NAME_MAX);
  return tamed === '' ? undefined : tamed;
}
