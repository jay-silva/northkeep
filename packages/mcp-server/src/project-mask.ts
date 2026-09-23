import { applyTier1 } from '@northkeep/redact';

/**
 * Tier-1 return masking for project payloads (ADR 0048), shared by the MCP
 * tools and the CLI board so both mask the same fields. Identifier keys stay
 * exact: masking them would corrupt the record of what, when and who.
 */
export const PROJECT_IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  'id', 'revision', 'vault_id', 'project', 'scope', 'updated_at', 'checked_at',
  'operation_id', 'base_revision', 'result_revision', 'request_fingerprint',
  'saved_at', 'type', 'access', 'mode',
  'session_id', 'opened_at', 'last_read_at',
  'host', 'host_version', 'recorded_at', 'oldest', 'newest',
  // Board fields the board itself emits (ADR 0054 Decision 3); status and line stay maskable.
  'date', 'last_activity', 'activity_source', 'reason', 'generated_at',
]);

export function maskProjectFields(value: unknown, tier: 0 | 1, key?: string): unknown {
  if (tier === 0) return value;
  if (typeof value === 'string') {
    return key && PROJECT_IDENTIFIER_KEYS.has(key) ? value : applyTier1(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => maskProjectFields(item, tier));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        maskProjectFields(child, tier, childKey),
      ]),
    );
  }
  return value;
}
