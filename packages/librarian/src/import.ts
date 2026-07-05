import type { MemoryEntry } from '@northkeep/core';
import type { ImportedConversation, MemoryCandidate } from '@northkeep/importers';
import { dedupeCandidates, type DedupeResult } from './dedupe.js';
import { extractFromConversation } from './extract.js';
import { createOllamaClient, type OllamaClient } from './ollama.js';

export interface ImportRunResult {
  candidates: MemoryCandidate[];
  duplicatesDropped: number;
  conflicts: DedupeResult['conflicts'];
  /** True when ANY conversation fell back to heuristic extraction. */
  degraded: boolean;
  conversationsProcessed: number;
}

export interface ImportRunOptions {
  /** Existing vault entries, for cross-import dedupe. */
  existing: MemoryEntry[];
  /** Cap on conversations to process (0/undefined = all). */
  limit?: number;
  onProgress?: (done: number, total: number, mode: 'llm' | 'heuristic') => void;
  /** Injectable for tests; null forces the heuristic path. */
  ollama?: OllamaClient | null;
}

/**
 * Extract → pool → dedupe. Returns candidates ONLY — nothing is written to
 * the vault here; approval and persistence are the caller's (the user's) job.
 */
export async function runImport(
  conversations: ImportedConversation[],
  options: ImportRunOptions,
): Promise<ImportRunResult> {
  const limited =
    options.limit && options.limit > 0 ? conversations.slice(0, options.limit) : conversations;

  let ollama: OllamaClient | null;
  if (options.ollama !== undefined) {
    ollama = options.ollama;
  } else {
    const client = createOllamaClient();
    ollama = (await client.available()) ? client : null;
  }

  const pooled: MemoryCandidate[] = [];
  let degraded = false;
  let done = 0;
  for (const conversation of limited) {
    const result = await extractFromConversation(conversation, ollama);
    if (result.mode === 'heuristic') degraded = true;
    pooled.push(...result.candidates);
    done += 1;
    options.onProgress?.(done, limited.length, result.mode);
  }

  const deduped = dedupeCandidates(pooled, options.existing);
  return {
    candidates: deduped.unique,
    duplicatesDropped: deduped.duplicatesDropped,
    conflicts: deduped.conflicts,
    degraded,
    conversationsProcessed: limited.length,
  };
}
