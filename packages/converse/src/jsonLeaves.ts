/**
 * Redact/restore over the STRING LEAVES of a JSON document (M10b, ADR 0027).
 *
 * WHY this exists: tool-call arguments travel as raw JSON text (ADR 0027 —
 * providers transport them byte-faithfully). When the agent loop re-redacts
 * the whole prompt per step (ADR 0007), assistant `toolCalls[].arguments`
 * must be redacted too — but running the redactor over the raw JSON string
 * would let it mangle structure (quotes, braces) or miss values that span
 * tokens. So we parse, transform every STRING leaf, and re-serialize.
 * Keys pass through untouched: they are schema identifiers the model chose
 * from OUR tool schemas, not user content. Numbers/booleans pass through:
 * the redactor is a text transform and a numeric leaf cannot carry a masked
 * placeholder back anyway.
 *
 * FAIL CLOSED on malformed JSON: a model can emit truncated/broken argument
 * JSON (the providers pass it through as-is by design). If we cannot parse,
 * the WHOLE raw string is redacted as plain text — never passed unredacted.
 */

/** Apply `fn` to every string leaf of `json`; unparseable input → fn(raw). */
export async function transformJsonLeaves(
  json: string,
  fn: (leaf: string) => Promise<string> | string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    // Fail closed: treat the whole malformed blob as one text leaf.
    return await fn(json);
  }
  const walk = async (node: unknown): Promise<unknown> => {
    if (typeof node === 'string') return await fn(node);
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) out.push(await walk(item));
      return out;
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = await walk(value); // keys are OUR schema identifiers — untouched
      }
      return out;
    }
    return node; // number | boolean | null
  };
  return JSON.stringify(await walk(parsed));
}

/**
 * Redact every string leaf with the given per-leaf redactor (the caller
 * closes over tier/pseudonyms and collects replacements/degraded flags).
 */
export function redactJsonLeaves(
  json: string,
  redactLeaf: (leaf: string) => Promise<string> | string,
): Promise<string> {
  return transformJsonLeaves(json, redactLeaf);
}

/**
 * Mirror of redactJsonLeaves for the way back: a bounded model emits
 * pseudonyms/masks INSIDE its argument strings; restore each leaf so the
 * tool executes on real values (restore is local-only — ADR 0027 decision 2:
 * no restore on egress; the egress-tier re-redaction happens separately).
 * restore() is synchronous, so this stays synchronous too.
 */
export function restoreJsonLeaves(json: string, restoreLeaf: (leaf: string) => string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return restoreLeaf(json);
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return restoreLeaf(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(value);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(parsed));
}
