import { applyTier1, redact, type PseudonymMap, type Tier } from '@northkeep/redact';
import { PROJECT_IDENTIFIER_KEYS, maskProjectFields } from './project-mask.js';

/**
 * Return masking over MCP (ADR 0060 Decision 2). NORTHKEEP_REDACT_TIER picks
 * the tier applied to what the vault returns: 0 none, 1 secrets, 2 also names,
 * 3 also every date to the year. Any other value is refused, never read as 0.
 *
 * Tiers 2 and 3 run after the vault is closed. A field whose name masking
 * fails is retried once; at Tier 2 a second failure refuses the whole call,
 * at Tier 3 the deterministic layers still ran and the call says so.
 */

export type ReturnTier = 0 | 1 | 2 | 3;

export type ParsedReturnTier = { ok: true; tier: ReturnTier } | { ok: false; value: string; message: string };

export function parseReturnRedactionTier(raw: string | undefined = process.env.NORTHKEEP_REDACT_TIER): ParsedReturnTier {
  if (raw === undefined || raw === '' || raw === '0') return { ok: true, tier: 0 };
  if (raw === '1' || raw === '2' || raw === '3') return { ok: true, tier: Number(raw) as ReturnTier };
  const shown = raw.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
  return { ok: false, value: shown, message: `NORTHKEEP_REDACT_TIER=${shown} is not 0, 1, 2 or 3; nothing was done.` };
}

export const TIER2_FAILED_MESSAGE =
  'Name masking failed (NORTHKEEP_REDACT_TIER=2); nothing was returned. Start the local model or use Tier 1 or 3.';

export const TIER3_DEGRADED_NOTE =
  'Tier 3 ran without the name model; names outside the built-in lists may be unmasked.';

export function contentWriteRefusal(tier: ReturnTier): string {
  return `Saving text is disabled while NORTHKEEP_REDACT_TIER=${tier} because this app only sees masked text.`;
}

/**
 * Names the host must send back to call a tool. They stay exact even at Tier 3
 * (residual R12): masking them would break the next call.
 */
export const HANDLE_KEYS: ReadonlySet<string> = new Set(['scope', 'project', 'slug', 'disclosed_scopes', 'granted_scopes']);

/** Date-valued keys reduced to the year at Tier 3 (ADR 0060 F4). */
export const DATE_KEYS: ReadonlySet<string> = new Set([
  'created_at', 'updated_at', 'checked_at', 'saved_at', 'recorded_at', 'opened_at', 'last_read_at',
  'oldest', 'newest', 'date', 'last_activity', 'generated_at', 'completed_at', 'forgotten_at',
]);

/** A whole string that is a full date or date-time, the structural catch-all for Tier 3. */
const FULL_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export interface MaskOutcome {
  payload: unknown;
  /** Tier 3 ran without the name model for at least one field. */
  degraded: boolean;
  /** Tier 2 could not mask names for at least one field: refuse the call. */
  failed: boolean;
}

interface MaskContext {
  tier: 2 | 3;
  pseudonyms: PseudonymMap;
  degraded: boolean;
  failed: boolean;
}

async function maskText(text: string, ctx: MaskContext): Promise<string> {
  if (!/[\p{L}\p{N}]/u.test(text)) return text;
  let r = await redact(text, { tier: ctx.tier, pseudonyms: ctx.pseudonyms });
  if (r.tier2Degraded) r = await redact(text, { tier: ctx.tier, pseudonyms: ctx.pseudonyms });
  if (r.tier2Degraded) {
    if (ctx.tier === 2) ctx.failed = true;
    else ctx.degraded = true;
  }
  return r.redacted;
}

function yearOf(value: string): string {
  return value.slice(0, 4);
}

/**
 * kind 'memory': only `content` fields are user text; other leaves are record
 * fields. kind 'project': every leaf except identifier keys is user text,
 * exactly the fields the Tier-1 project walk masks.
 */
async function walk(value: unknown, kind: 'memory' | 'project', ctx: MaskContext, key?: string): Promise<unknown> {
  if (typeof value === 'string') {
    if (key !== undefined && HANDLE_KEYS.has(key)) return value;
    const userText = kind === 'memory' ? key === 'content' : !(key !== undefined && PROJECT_IDENTIFIER_KEYS.has(key));
    if (userText) return maskText(value, ctx);
    if (ctx.tier === 3 && ((key !== undefined && DATE_KEYS.has(key) && /^\d{4}/.test(value)) || FULL_DATE.test(value))) {
      return yearOf(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Arrays inherit their key: a list of scopes is a list of handles.
    const out: unknown[] = [];
    for (const item of value) out.push(await walk(item, kind, ctx, key !== undefined && HANDLE_KEYS.has(key) ? key : undefined));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = await walk(child, kind, ctx, childKey);
    }
    return out;
  }
  return value;
}

function maskMemoryTier1(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return key === 'content' ? applyTier1(value).text : value;
  if (Array.isArray(value)) return value.map((item) => maskMemoryTier1(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskMemoryTier1(v, k)]),
    );
  }
  return value;
}

export async function maskReturnPayload(
  payload: unknown,
  kind: 'memory' | 'project',
  tier: ReturnTier,
  pseudonyms: PseudonymMap,
): Promise<MaskOutcome> {
  if (tier === 0) return { payload, degraded: false, failed: false };
  if (tier === 1) {
    return {
      payload: kind === 'project' ? maskProjectFields(payload, 1) : maskMemoryTier1(payload),
      degraded: false,
      failed: false,
    };
  }
  const ctx: MaskContext = { tier: tier as Tier as 2 | 3, pseudonyms, degraded: false, failed: false };
  const masked = await walk(payload, kind, ctx);
  return { payload: masked, degraded: ctx.degraded, failed: ctx.failed };
}
