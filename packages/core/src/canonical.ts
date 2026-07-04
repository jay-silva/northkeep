/**
 * Canonical JSON per SPEC/memory-schema.md: keys sorted lexicographically at
 * every level, no insignificant whitespace, null for absent optional fields.
 * The hash chain depends on this being stable forever — changing it is a
 * schema-major event.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  // Strings hash in Unicode NFC so the chain survives normalization-changing
  // round-trips (editors, exports, other conforming implementations).
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
