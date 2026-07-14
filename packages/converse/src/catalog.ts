import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import type { TaskKind } from './route.js';

/**
 * The model catalog (M7c, ADR 0011 decision 3): what each model is GOOD AT,
 * so the concierge can choose well when no user rule speaks. This is DATA,
 * not behavior — a curated baseline shipped in-repo, overridable/extendable
 * by the user at ~/.northkeep/catalog.json (their entries win). No network:
 * a remote catalog feed is deferred to its own ADR (invariant #7).
 */

/**
 * Rough price band for a model. `free-local` runs on the user's own machine;
 * the paid tiers are order-of-magnitude buckets, not exact quotes (see
 * costLabel() for the approximate $/1M-token ranges shown in the UI).
 */
export type CostTier = 'free-local' | 'low' | 'medium' | 'high';

export interface CatalogEntry {
  /** Canonical id prefix, matched against configured model ids. */
  id: string;
  /** Extra substrings that identify this model family. */
  aliases?: string[];
  strengths: TaskKind[];
  /** Tokens, approximate — used to prefer models for long-context work. */
  contextWindow?: number;
  costTier: CostTier;
  /**
   * APPROXIMATE list price in USD per 1,000,000 INPUT tokens. Rough public
   * order-of-magnitude figures (knowledge cutoff early 2026), NOT quotes —
   * used only for the local per-turn cost estimate (see estimateTurnCost).
   * `0` for free-local models. Omitted when we have no figure; helpers then
   * return null rather than guess.
   */
  inputPer1M?: number;
  /** APPROXIMATE list price in USD per 1,000,000 OUTPUT tokens. See inputPer1M. */
  outputPer1M?: number;
  speedTier: 'fast' | 'medium' | 'slow';
  /**
   * Approx download/RAM footprint in GB for LOCAL (free-local) models — used by
   * the hardware recommender to size a pull against available memory. Family
   * entries carry a representative size (the common default tag). Omitted for
   * hosted models, which download nothing.
   */
  sizeGB?: number;
  notes?: string;
}

/**
 * Curated baseline (knowledge cutoff early 2026). Deliberately family-level:
 * "qwen2.5" matches qwen2.5:7b/14b/32b tags. Order matters only for display;
 * matching picks the LONGEST matching id/alias so "qwen2.5-coder" beats
 * "qwen2.5".
 */
// Prices below (inputPer1M / outputPer1M, USD per 1M tokens) are APPROXIMATE
// public list figures rounded to order of magnitude — knowledge cutoff early
// 2026, NOT live quotes. They exist only to power the local, on-device per-turn
// cost estimate; treat every number as "approx". Local models are 0 (they run
// on your own machine). Update freely — nothing here is authoritative.
export const BASELINE_CATALOG: readonly CatalogEntry[] = [
  // --- Local (Ollama) families: free, run on-device. sizeGB is the common
  // default tag's footprint; the hardware recommender sizes pulls against it.
  { id: 'llama3.2', strengths: ['quick', 'general'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'fast', sizeGB: 2, notes: 'Small, snappy local generalist (3B).' },
  { id: 'llama3.1', strengths: ['general', 'reasoning'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'medium', sizeGB: 5 },
  { id: 'llama3.3', strengths: ['general', 'reasoning'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'slow', sizeGB: 40 },
  { id: 'qwen2.5-coder', strengths: ['code'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'medium', sizeGB: 5, notes: 'Code-specialized Qwen.' },
  { id: 'qwen2.5', strengths: ['code', 'reasoning', 'general'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'medium', sizeGB: 9 },
  { id: 'qwen3', strengths: ['code', 'reasoning', 'general'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'medium', sizeGB: 9 },
  { id: 'deepseek-r1', strengths: ['reasoning'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'slow', sizeGB: 5, notes: 'Deliberate chain-of-thought reasoner (distill).' },
  { id: 'mistral', strengths: ['quick', 'general'], contextWindow: 32_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'fast', sizeGB: 4 },
  { id: 'gemma3', aliases: ['gemma2'], strengths: ['general', 'creative'], contextWindow: 128_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'fast', sizeGB: 5 },
  { id: 'phi4', strengths: ['reasoning', 'code'], contextWindow: 16_000, costTier: 'free-local', inputPer1M: 0, outputPer1M: 0, speedTier: 'fast', sizeGB: 9 },
  // --- Anthropic (native provider). IDs current as of 2026-07. Prices ≈ Claude
  // list (opus $15/$75, sonnet $3/$15, haiku $0.80/$4 per 1M).
  { id: 'claude-opus', strengths: ['code', 'reasoning', 'long-context', 'creative'], contextWindow: 1_000_000, costTier: 'high', inputPer1M: 15, outputPer1M: 75, speedTier: 'medium', notes: 'Frontier-class; strongest all-rounder.' },
  { id: 'claude-sonnet', strengths: ['code', 'reasoning', 'long-context'], contextWindow: 1_000_000, costTier: 'medium', inputPer1M: 3, outputPer1M: 15, speedTier: 'medium' },
  { id: 'claude-haiku', strengths: ['quick', 'general'], contextWindow: 200_000, costTier: 'low', inputPer1M: 0.8, outputPer1M: 4, speedTier: 'fast' },
  // --- OpenAI. gpt-5 family (gpt-5.6 sol/terra/luna) + o-series reasoners.
  { id: 'gpt-5', aliases: ['gpt-5.6', 'gpt-5.5'], strengths: ['code', 'reasoning', 'general', 'long-context'], contextWindow: 400_000, costTier: 'high', inputPer1M: 10, outputPer1M: 30, speedTier: 'medium', notes: 'Frontier OpenAI generalist.' },
  { id: 'o3', aliases: ['o4-mini', 'o1'], strengths: ['reasoning', 'code'], contextWindow: 200_000, costTier: 'high', inputPer1M: 10, outputPer1M: 40, speedTier: 'slow', notes: 'OpenAI o-series deliberate reasoner.' },
  { id: 'gpt-4o-mini', strengths: ['quick', 'general'], contextWindow: 128_000, costTier: 'low', inputPer1M: 0.15, outputPer1M: 0.6, speedTier: 'fast' },
  { id: 'gpt-4o', strengths: ['general', 'creative', 'code'], contextWindow: 128_000, costTier: 'medium', inputPer1M: 2.5, outputPer1M: 10, speedTier: 'medium' },
  // --- Google Gemini (OpenAI-compatible endpoint). Longest match wins, so
  // "gemini-3-pro" beats the "gemini" flash family.
  { id: 'gemini-3-pro', strengths: ['code', 'reasoning', 'long-context', 'general'], contextWindow: 1_000_000, costTier: 'high', inputPer1M: 5, outputPer1M: 15, speedTier: 'medium', notes: 'Frontier Gemini.' },
  { id: 'gemini', strengths: ['general', 'quick', 'long-context'], contextWindow: 1_000_000, costTier: 'low', inputPer1M: 0.1, outputPer1M: 0.4, speedTier: 'fast', notes: 'Gemini Flash: cheap, fast, huge context.' },
  // --- xAI Grok. "grok-4" matches grok-4.5; "grok" catches grok-3/-3-fast.
  { id: 'grok-4', strengths: ['reasoning', 'code', 'general'], contextWindow: 256_000, costTier: 'high', inputPer1M: 3, outputPer1M: 15, speedTier: 'medium', notes: 'Frontier Grok.' },
  { id: 'grok', strengths: ['general', 'reasoning'], contextWindow: 131_000, costTier: 'medium', inputPer1M: 2, outputPer1M: 10, speedTier: 'medium' },
  // --- DeepSeek (hosted chat model; deepseek-r1 above is the local reasoner).
  { id: 'deepseek-chat', strengths: ['general', 'code', 'reasoning'], contextWindow: 128_000, costTier: 'low', inputPer1M: 0.27, outputPer1M: 1.1, speedTier: 'medium', notes: 'Cheap, capable hosted generalist.' },
  // --- Meta Llama, HOSTED (via OpenRouter — see provider-catalog.ts). Hyphenated
  // ids ("llama-3.3", "llama-4") stay distinct from the dotted local tags.
  { id: 'llama-4', strengths: ['general', 'code', 'reasoning'], contextWindow: 10_000_000, costTier: 'low', inputPer1M: 0.2, outputPer1M: 0.6, speedTier: 'fast', notes: 'Hosted Llama 4 (huge context).' },
  { id: 'llama-3.3', strengths: ['general', 'code'], contextWindow: 128_000, costTier: 'low', inputPer1M: 0.13, outputPer1M: 0.4, speedTier: 'medium', notes: 'Hosted Llama 3.3 70B.' },
];

export function catalogPath(): string {
  return path.join(northkeepHome(), 'catalog.json');
}

/** Baseline + the user's override file (user entries win on equal match length). */
export function loadCatalog(): CatalogEntry[] {
  let user: CatalogEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath(), 'utf8')) as { models?: unknown };
    if (Array.isArray(parsed.models)) {
      user = parsed.models.filter(
        (m): m is CatalogEntry =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as CatalogEntry).id === 'string' &&
          Array.isArray((m as CatalogEntry).strengths),
      );
    }
  } catch {
    // No override file (the normal case) or unparseable — baseline only.
  }
  return [...user, ...BASELINE_CATALOG];
}

/**
 * Find the catalog entry for a configured model id ("qwen2.5:14b",
 * "claude-opus-4-8", "org/model:tag"). Longest matching id/alias wins;
 * user entries beat baseline on ties (they come first).
 */
/**
 * Human-facing cost badge for a tier: a compact symbol plus an APPROXIMATE
 * per-1M-token price range (rough order-of-magnitude buckets, not quotes —
 * surface them labelled "approx"). Used by the model pickers, endpoint list,
 * and routing reasons so cost is never invisible (M9b, ADR 0014).
 */
export function costLabel(tier: CostTier): { symbol: string; range: string } {
  switch (tier) {
    case 'free-local':
      return { symbol: 'Free', range: 'runs on your Mac' };
    case 'low':
      return { symbol: '$', range: '~$0.15–0.60 / 1M tokens (approx)' };
    case 'medium':
      return { symbol: '$$', range: '~$1–5 / 1M tokens (approx)' };
    case 'high':
      return { symbol: '$$$', range: '~$5–15+ / 1M tokens (approx)' };
  }
}

export function lookupModel(modelId: string, catalog: CatalogEntry[] = loadCatalog()): CatalogEntry | null {
  const norm = modelId.toLowerCase();
  let best: { entry: CatalogEntry; len: number } | null = null;
  for (const entry of catalog) {
    for (const key of [entry.id, ...(entry.aliases ?? [])]) {
      const k = key.toLowerCase();
      if (norm.includes(k) && (best === null || k.length > best.len)) {
        best = { entry, len: k.length };
      }
    }
  }
  return best?.entry ?? null;
}

// --- Local, on-device cost metering (M9?, honest "approx" stance). Nothing
// here touches the network: a turn's cost is token counts × the catalog's
// APPROXIMATE per-token prices, computed on the user's machine. Figures are
// order-of-magnitude and always surfaced labelled "approx". ---

/**
 * Token counts for one turn. `estimated` is true when the provider did not
 * report real usage and we fell back to a chars/token heuristic (see turn.ts).
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/**
 * APPROXIMATE USD cost of a turn on a given model: input/output tokens times
 * the catalog's per-1M prices. Returns null when the entry is unknown or has
 * no price (we never guess a price). Free-local models price to exactly $0.
 * `approximate` is always true — these are rough figures, never quotes.
 */
export function estimateTurnCost(
  usage: { inputTokens: number; outputTokens: number },
  entry: CatalogEntry | null,
): { usd: number; approximate: boolean } | null {
  if (!entry || entry.inputPer1M === undefined || entry.outputPer1M === undefined) return null;
  const usd =
    (usage.inputTokens / 1_000_000) * entry.inputPer1M +
    (usage.outputTokens / 1_000_000) * entry.outputPer1M;
  return { usd, approximate: true };
}

/**
 * What this turn would have cost on each of the user's OTHER configured models,
 * cheapest first — the local comparison view ("≈ $X on Grok; ≈ $0 on Qwen").
 * Endpoints are matched to catalog entries by model id; any whose price is
 * unknown is dropped (an empty array is a valid, graceful result). Pure and
 * fully local. Endpoints are typed structurally so callers can pass their
 * EndpointConfig list directly.
 */
export function compareTurnCost(
  usage: { inputTokens: number; outputTokens: number },
  configuredEndpoints: ReadonlyArray<{ label: string; model: string }>,
  catalog: CatalogEntry[] = loadCatalog(),
): Array<{ label: string; model: string; usd: number }> {
  const rows: Array<{ label: string; model: string; usd: number }> = [];
  for (const ep of configuredEndpoints) {
    const cost = estimateTurnCost(usage, lookupModel(ep.model, catalog));
    if (cost === null) continue; // unknown price — omit rather than invent one
    rows.push({ label: ep.label, model: ep.model, usd: cost.usd });
  }
  rows.sort((a, b) => a.usd - b.usd);
  return rows;
}

/**
 * Very rough token count from character length (~4 chars/token, the common
 * English-text rule of thumb). Only used when a provider reports no real usage;
 * results are marked `estimated` so the UI can hedge them.
 */
export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}
