/**
 * Connector tombstone helpers (ADR 0038 addendum). Shared by the in-memory
 * store, Neon, and the PUT /client/entries route so route tests and Postgres
 * tests apply the same rules.
 */

export const TOMBSTONE_USER_MESSAGE =
  'This scope was unshared. Re-share it deliberately if you want it back.';

export class TombstoneConflictError extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(TOMBSTONE_USER_MESSAGE);
    this.name = 'TombstoneConflictError';
    this.conflicts = [...conflicts].sort();
  }
}

/** True only when the env flag is an explicit on-value. Default is off. */
export function isTombstoneEnforceOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CONNECTOR_TOMBSTONE_ENFORCE;
  return v === '1' || v === 'true';
}

/** Parse an ISO-8601 timestamp as a UTC instant. Invalid → null (fail closed). */
export function parseUtcMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A pushed scope conflicts when a tombstone exists and the client shared_at
 * is missing, unparsable, or not strictly after unshared_at.
 */
export function findTombstoneConflicts(
  tombstones: Array<{ scope: string; unsharedAt: string }>,
  scopes: string[],
  sharedAt: Record<string, string | undefined>,
): string[] {
  const latest = new Map<string, string>();
  for (const t of tombstones) {
    if (!scopes.includes(t.scope)) continue;
    const prev = latest.get(t.scope);
    if (prev === undefined) {
      latest.set(t.scope, t.unsharedAt);
      continue;
    }
    const prevMs = parseUtcMs(prev);
    const nextMs = parseUtcMs(t.unsharedAt);
    if (nextMs === null) continue;
    if (prevMs === null || nextMs >= prevMs) latest.set(t.scope, t.unsharedAt);
  }
  const conflicts: string[] = [];
  for (const [scope, unsharedAt] of latest) {
    const clientAt = sharedAt[scope];
    if (clientAt === undefined) {
      conflicts.push(scope);
      continue;
    }
    const clientMs = parseUtcMs(clientAt);
    const tombMs = parseUtcMs(unsharedAt);
    if (clientMs === null || tombMs === null || clientMs <= tombMs) {
      conflicts.push(scope);
    }
  }
  return conflicts.sort();
}

/** Keep a tombstone when unshared_at is strictly after the accepted shared_at (concurrent unshare). */
export function shouldKeepTombstone(unsharedAt: string, acceptedSharedAt: string): boolean {
  const u = parseUtcMs(unsharedAt);
  const s = parseUtcMs(acceptedSharedAt);
  if (u === null || s === null) return true;
  return u > s;
}

export function parseSharedAtMap(raw: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
