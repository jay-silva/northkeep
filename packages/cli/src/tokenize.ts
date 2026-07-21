/**
 * Split a typed command line into argv tokens with minimal quote handling.
 *
 * This is NOT a shell: no variable expansion, no escapes, no globbing, no
 * operators. It only understands single and double quotes so a command from the
 * home prompt can carry a multi-word argument, e.g.
 *   remember "buy milk" --scope personal
 *   remember 'it'  ->  ["remember", "it"]
 * Whitespace outside quotes separates tokens; whitespace inside quotes is
 * preserved. Adjacent quoted and bare runs join into one token (foo" bar" ->
 * `foo bar`). Empty or all-whitespace input yields [].
 */
export function tokenizeCommand(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = null; // closing quote — an empty "" still leaves a token started
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}
