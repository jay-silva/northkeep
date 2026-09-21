/**
 * One sanitizer for every client-supplied string that lands in a brief the
 * model reads. A round-2 attack got past the old [\x00-\x1f] class with U+0085
 * and U+2028: both terminate a line for a reader, neither is a C0 control.
 */

/**
 * Cc and Cf cover NEL, the bidi overrides and the BOM; U+2028 and U+2029 are
 * Zl and Zp, so they need naming.
 */
const UNSAFE_CODE_POINTS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A surrogate half without its partner: not a character, and JSON escapes it as one. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

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
