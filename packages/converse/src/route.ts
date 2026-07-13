import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import { loadCatalog, lookupModel, type CatalogEntry } from './catalog.js';
import { classifyEndpoint } from './provider.js';
import type { EndpointConfig } from './settings.js';

/**
 * route() — the model concierge's chooser (M7b, ADR 0011). Runs strictly
 * BEFORE runTurn and only picks (endpoint, model); the send path — retrieval,
 * redaction, the provider call — is untouched, so invariant #1 is unaffected
 * by anything in this file.
 *
 * The load-bearing rule (ADR 0011 decision 2): routing may only choose
 * endpoints AT OR BELOW the conversation's privacy ceiling. A rule that points
 * above the ceiling is SKIPPED and the skip is named in the reason — the
 * concierge tells the user it could do better elsewhere; it never silently
 * escalates a private conversation off the machine.
 */

export type TaskKind = 'code' | 'reasoning' | 'creative' | 'long-context' | 'quick' | 'general';

export type PrivacyCeiling = 'private-only' | 'bounded-allowed';

export interface RoutingRule {
  /** Which task this rule routes; '*' catches everything. */
  task: TaskKind | '*';
  endpointId: string;
  /** Optional model override on that endpoint. */
  model?: string;
}

export interface RoutePolicy {
  rules: RoutingRule[];
}

export interface RouteDecision {
  endpointId: string;
  model: string;
  task: TaskKind;
  /** Human-readable: how this choice was made (goes to the audit log + UI). */
  reason: string;
}

// --- task classification: cheap, deterministic heuristics. A local-model
// classifier can sharpen this later (M7c); heuristics are the always-available
// floor, so routing never blocks a turn (invariant #6: degrade gracefully).

const CODE_HINTS =
  /```|\bfunction\b|\bconst \w+ =|\bdef \w+\(|\bclass \w+|\bimport \w|=>|\bregex\b|\bstack trace\b|\bcompil|debug|typescript|python|javascript|\bsql\b|\bbash\b|\berror: /i;
const CREATIVE_HINTS =
  /\b(write|draft|compose)\b.*\b(story|poem|song|essay|blog|post|speech|toast)\b|\bbrainstorm\b|\bslogan\b|\btagline\b/i;
const REASONING_HINTS =
  /\b(why|analyze|analyse|compare|evaluate|trade-?offs?|pros and cons|plan|strategy|should (i|we)|what if|explain the difference)\b/i;
const SUMMARIZE_HINTS = /\b(summariz|summaris|tl;?dr|key points|condense|shorten)\b/i;

const LONG_INPUT_CHARS = 6000;
const QUICK_MAX_CHARS = 120;

export function classifyTask(message: string): TaskKind {
  if (CODE_HINTS.test(message)) return 'code';
  if (message.length > LONG_INPUT_CHARS || SUMMARIZE_HINTS.test(message)) return 'long-context';
  if (CREATIVE_HINTS.test(message)) return 'creative';
  if (REASONING_HINTS.test(message)) return 'reasoning';
  if (message.length <= QUICK_MAX_CHARS && /\?/.test(message)) return 'quick';
  return 'general';
}

// --- policy storage: routing.json next to providers.json. Rules only —
// no secrets, no content. 0600 like its siblings.

export function routingPath(): string {
  return path.join(northkeepHome(), 'routing.json');
}

export function loadRoutingPolicy(): RoutePolicy {
  try {
    const raw = fs.readFileSync(routingPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RoutePolicy>;
    return { rules: Array.isArray(parsed.rules) ? parsed.rules.filter(isRoutingRule) : [] };
  } catch {
    return { rules: [] };
  }
}

export function saveRoutingPolicy(policy: RoutePolicy): void {
  fs.mkdirSync(path.dirname(routingPath()), { recursive: true });
  fs.writeFileSync(routingPath(), `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
}

const TASK_KINDS: ReadonlySet<string> = new Set([
  'code',
  'reasoning',
  'creative',
  'long-context',
  'quick',
  'general',
  '*',
]);

/**
 * The one rule validator — used by loadRoutingPolicy (tolerant read: invalid
 * rules are dropped) AND by write surfaces, which must REJECT invalid rules
 * loudly instead of persisting something the loader will silently discard.
 */
export function isRoutingRule(rule: unknown): rule is RoutingRule {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.task === 'string' &&
    TASK_KINDS.has(r.task) &&
    typeof r.endpointId === 'string' &&
    (r.model === undefined || typeof r.model === 'string')
  );
}

// --- the chooser

export interface RouteArgs {
  message: string;
  endpoints: EndpointConfig[];
  policy: RoutePolicy;
  ceiling: PrivacyCeiling;
  /** Where to land when no rule matches (usually the default endpoint). */
  defaultEndpointId?: string | null;
  /** Injectable for tests; defaults to loadCatalog(). */
  catalog?: CatalogEntry[];
}

const withinCeiling = (ep: EndpointConfig, ceiling: PrivacyCeiling): boolean =>
  ceiling === 'bounded-allowed' || classifyEndpoint(ep.baseUrl).tier === 'private';

export function route(args: RouteArgs): RouteDecision {
  const task = classifyTask(args.message);
  const byId = new Map(args.endpoints.map((ep) => [ep.id, ep]));
  const skipped: string[] = [];

  // First matching rule (exact task first, then '*'), ceiling-enforced.
  for (const exactFirst of [true, false]) {
    for (const rule of args.policy.rules) {
      if (exactFirst ? rule.task !== task : rule.task !== '*') continue;
      const ep = byId.get(rule.endpointId);
      if (!ep) continue; // rule points at a removed endpoint
      if (!withinCeiling(ep, args.ceiling)) {
        // NEVER silently escalate: name the better option and move on.
        skipped.push(ep.label);
        continue;
      }
      return {
        endpointId: ep.id,
        model: rule.model ?? ep.model,
        task,
        reason:
          `auto: ${task} → ${ep.label} (rule)` +
          (skipped.length > 0 ? `; skipped ${skipped.join(', ')}: above the privacy ceiling` : ''),
      };
    }
  }

  // Catalog phase (M7c): no rule spoke — among ceiling-allowed endpoints,
  // prefer one whose configured model the catalog marks STRONG at this task.
  // Rules stay authoritative (explicit user intent beats curated data); the
  // default endpoint remains the fallback when the catalog has no opinion.
  const catalog = args.catalog ?? loadCatalog();
  const catalogPick = pickByCatalog(task, args.endpoints, args.ceiling, catalog);
  if (catalogPick) {
    return {
      endpointId: catalogPick.ep.id,
      model: catalogPick.ep.model,
      task,
      reason:
        `auto: ${task} → ${catalogPick.ep.label} (catalog: ${catalogPick.ep.model} is strong at ${task})` +
        (skipped.length > 0 ? `; skipped ${skipped.join(', ')}: above the privacy ceiling` : ''),
    };
  }

  // No usable rule → the default endpoint, if the ceiling allows it.
  const fallback = args.defaultEndpointId ? byId.get(args.defaultEndpointId) : undefined;
  if (fallback && withinCeiling(fallback, args.ceiling)) {
    return {
      endpointId: fallback.id,
      model: fallback.model,
      task,
      reason:
        `auto: ${task} → ${fallback.label} (default)` +
        (skipped.length > 0 ? `; skipped ${skipped.join(', ')}: above the privacy ceiling` : ''),
    };
  }

  // Last resort: any endpoint within the ceiling (private ones for a pinned chat).
  const candidate = args.endpoints.find((ep) => withinCeiling(ep, args.ceiling));
  if (candidate) {
    return {
      endpointId: candidate.id,
      model: candidate.model,
      task,
      reason: `auto: ${task} → ${candidate.label} (only endpoint within the privacy ceiling)`,
    };
  }

  throw new RouteError(
    args.ceiling === 'private-only'
      ? 'This conversation is pinned private, and no private (local/LAN) endpoint is configured. Add one, or unpin the conversation.'
      : 'No endpoints are configured.',
  );
}

/**
 * Deterministic catalog choice: candidates are ceiling-allowed endpoints whose
 * configured model is catalog-known AND strong at the task. Tiebreak by what
 * the task cares about — speed for quick, context window for long-context,
 * cost (cheapest first, local-first ethos) otherwise; then configured order.
 */
function pickByCatalog(
  task: RouteDecision['task'],
  endpoints: EndpointConfig[],
  ceiling: PrivacyCeiling,
  catalog: CatalogEntry[],
): { ep: EndpointConfig; entry: CatalogEntry } | null {
  const COST_ORDER = { 'free-local': 0, low: 1, medium: 2, high: 3 } as const;
  const SPEED_ORDER = { fast: 0, medium: 1, slow: 2 } as const;
  const candidates = endpoints
    .filter((ep) => withinCeiling(ep, ceiling))
    .map((ep) => ({ ep, entry: lookupModel(ep.model, catalog) }))
    .filter((c): c is { ep: EndpointConfig; entry: CatalogEntry } =>
      c.entry !== null && c.entry.strengths.includes(task),
    );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (task === 'quick') {
      const d = SPEED_ORDER[a.entry.speedTier] - SPEED_ORDER[b.entry.speedTier];
      if (d !== 0) return d;
    }
    if (task === 'long-context') {
      const d = (b.entry.contextWindow ?? 0) - (a.entry.contextWindow ?? 0);
      if (d !== 0) return d;
    }
    return COST_ORDER[a.entry.costTier] - COST_ORDER[b.entry.costTier];
  });
  return candidates[0]!;
}

/**
 * The concierge's gentle upsell (M9d, ADR 0014). Classify the task, find the
 * catalog's STRONGEST model for it, and — only if NONE of the user's configured
 * endpoints already map to a model that is also strong at that task — return a
 * non-nagging suggestion naming the better model. Otherwise null (they're
 * already covered). Deterministic, no network; does not touch route().
 */
export function suggestBetterModel(
  message: string,
  configuredEndpoints: EndpointConfig[],
  catalog: CatalogEntry[] = loadCatalog(),
): { modelLabel: string; task: TaskKind; reason: string } | null {
  const task = classifyTask(message);

  // Already have a model that's strong at this task? Then say nothing.
  const covered = configuredEndpoints.some((ep) => {
    const entry = lookupModel(ep.model, catalog);
    return entry?.strengths.includes(task) ?? false;
  });
  if (covered) return null;

  // The catalog's best model for this task: highest quality (cost as a proxy),
  // then widest context. A frontier hosted model wins the recommendation.
  const COST_RANK = { 'free-local': 0, low: 1, medium: 2, high: 3 } as const;
  const best = catalog
    .filter((e) => e.strengths.includes(task))
    .sort(
      (a, b) =>
        COST_RANK[b.costTier] - COST_RANK[a.costTier] ||
        (b.contextWindow ?? 0) - (a.contextWindow ?? 0),
    )[0];
  if (!best) return null;

  const modelLabel = prettyModelLabel(best.id);
  return {
    modelLabel,
    task,
    reason: `${taskNoun(task)} — ${modelLabel} would handle this better; connect it to route it there.`,
  };
}

function prettyModelLabel(id: string): string {
  return id
    .split(/[-_./]/)
    .filter((w) => w.length > 0)
    .map((w) => (/^(gpt|xai|ai|llm)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function taskNoun(task: TaskKind): string {
  switch (task) {
    case 'code':
      return 'This looks like a coding question';
    case 'reasoning':
      return 'This looks like a reasoning task';
    case 'creative':
      return 'This looks like creative writing';
    case 'long-context':
      return 'This looks like a long-document task';
    case 'quick':
      return 'This is a quick question';
    case 'general':
      return 'For this';
  }
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}
