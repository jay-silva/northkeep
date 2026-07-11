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

export interface CatalogEntry {
  /** Canonical id prefix, matched against configured model ids. */
  id: string;
  /** Extra substrings that identify this model family. */
  aliases?: string[];
  strengths: TaskKind[];
  /** Tokens, approximate — used to prefer models for long-context work. */
  contextWindow?: number;
  costTier: 'free-local' | 'low' | 'medium' | 'high';
  speedTier: 'fast' | 'medium' | 'slow';
  notes?: string;
}

/**
 * Curated baseline (knowledge cutoff early 2026). Deliberately family-level:
 * "qwen2.5" matches qwen2.5:7b/14b/32b tags. Order matters only for display;
 * matching picks the LONGEST matching id/alias so "qwen2.5-coder" beats
 * "qwen2.5".
 */
export const BASELINE_CATALOG: readonly CatalogEntry[] = [
  { id: 'llama3.2', strengths: ['quick', 'general'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'fast', notes: 'Small, snappy local generalist.' },
  { id: 'llama3.1', strengths: ['general', 'reasoning'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'medium' },
  { id: 'llama3.3', strengths: ['general', 'reasoning'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'medium' },
  { id: 'qwen2.5-coder', strengths: ['code'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'medium', notes: 'Code-specialized Qwen.' },
  { id: 'qwen2.5', strengths: ['code', 'reasoning', 'general'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'medium' },
  { id: 'qwen3', strengths: ['code', 'reasoning', 'general'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'medium' },
  { id: 'deepseek-r1', strengths: ['reasoning'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'slow', notes: 'Deliberate chain-of-thought reasoner.' },
  { id: 'mistral', strengths: ['quick', 'general'], contextWindow: 32_000, costTier: 'free-local', speedTier: 'fast' },
  { id: 'gemma3', aliases: ['gemma2'], strengths: ['general', 'creative'], contextWindow: 128_000, costTier: 'free-local', speedTier: 'fast' },
  { id: 'phi4', strengths: ['reasoning', 'code'], contextWindow: 16_000, costTier: 'free-local', speedTier: 'fast' },
  { id: 'claude-opus', strengths: ['code', 'reasoning', 'long-context', 'creative'], contextWindow: 1_000_000, costTier: 'high', speedTier: 'medium', notes: 'Frontier-class; strongest all-rounder.' },
  { id: 'claude-sonnet', strengths: ['code', 'reasoning', 'long-context'], contextWindow: 1_000_000, costTier: 'medium', speedTier: 'medium' },
  { id: 'claude-haiku', strengths: ['quick', 'general'], contextWindow: 200_000, costTier: 'low', speedTier: 'fast' },
  { id: 'gpt-4o-mini', strengths: ['quick', 'general'], contextWindow: 128_000, costTier: 'low', speedTier: 'fast' },
  { id: 'gpt-4o', strengths: ['general', 'creative', 'code'], contextWindow: 128_000, costTier: 'medium', speedTier: 'medium' },
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
