/**
 * Memory review pass (ADR 0043). The model sees a MemoryEntry[] snapshot
 * only. No Vault handle, no tools, no writes (P1).
 */
import { isProjectScope, type MemoryEntry } from '@northkeep/core';
import type { OllamaClient } from './ollama.js';
import { REVIEW_MODEL_PREFERRED } from './ollama.js';
import {
  extractRawProposals,
  parseReviewResponse,
  validateProposals,
  type ReviewProposal,
} from './reviewSchema.js';

const BATCH_MAX_ENTRIES = 25;
const BATCH_MAX_CHARS = 12_000;
const REVIEW_TIMEOUT_MS = 300_000;
const DATA_BEGIN = '===BEGIN MEMORY DATA===';
const DATA_END = '===END MEMORY DATA===';

const SYSTEM_INSTRUCTIONS = `You review a snapshot of personal memories and propose edits. You have no tools and cannot write to the vault.

Copy quotes as exact substrings from the entry content. Do not paraphrase.

Return JSON only, in exactly this shape:
{"proposals":[{"kind":"duplicate"|"contradiction"|"undated"|"stale","entry_ids":["..."],"quotes":[{"entry_id":"...","quote":"..."}],"explanation":"...","target_entry_id":null,"proposed_content":null}]}

Rules:
- duplicate: two or more live entries that state the same fact. Include every member id and a quote from each. Leave target_entry_id and proposed_content null.
- contradiction: two entries that cannot both be true. Two id-linked quotes required. Set target_entry_id to the entry to update and proposed_content to the corrected text.
- undated: a fact that needs a date. One quote. Set target_entry_id and proposed_content (the same fact with an inferred date).
- stale: a fact that looks expired. One quote. Set target_entry_id and proposed_content.
- Cite only ids listed in the data section. Do not invent ids.
- explanation is a short note for the user. It is never applied as a write.`;

export interface ReviewPassResult {
  proposals: ReviewProposal[];
  drops: Record<string, number>;
  model: string;
  batches: number;
}

export interface ReviewPassOptions {
  model?: string;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Live entries only (caller uses vault.list()). Drop project: docs. Shared stays in. */
export function selectReviewEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => !isProjectScope(e.scope));
}

export function batchReviewEntries(entries: MemoryEntry[]): MemoryEntry[][] {
  const batches: MemoryEntry[][] = [];
  let current: MemoryEntry[] = [];
  let chars = 0;
  for (const e of entries) {
    const size = e.content.length + 64;
    if (current.length > 0 && (current.length >= BATCH_MAX_ENTRIES || chars + size > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(e);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function formatDataSection(entries: MemoryEntry[]): string {
  const blocks = entries.map((e) => {
    return `id: ${e.id}\nscope: ${e.scope}\ntype: ${e.type}\ncreated_at: ${e.created_at}\ncontent:\n${e.content}`;
  });
  return `${DATA_BEGIN}\n${blocks.join('\n---\n')}\n${DATA_END}`;
}

function reviewPrompt(entries: MemoryEntry[]): string {
  return `${SYSTEM_INSTRUCTIONS}\n\n${formatDataSection(entries)}`;
}

function mergeDrops(into: Record<string, number>, from: Record<string, number>): void {
  for (const [reason, count] of Object.entries(from)) {
    into[reason] = (into[reason] ?? 0) + count;
  }
}

async function generateBatch(
  ollama: Pick<OllamaClient, 'generateJson'>,
  prompt: string,
  opts: { model: string; timeoutMs: number },
): Promise<string> {
  return ollama.generateJson(prompt, { model: opts.model, timeoutMs: opts.timeoutMs });
}

/**
 * Run the review pass over a snapshot. Does not write the vault. Does not
 * write the report (the caller saves).
 */
export async function runReviewPass(
  entries: MemoryEntry[],
  ollama: Pick<OllamaClient, 'generateJson'>,
  opts?: ReviewPassOptions,
): Promise<ReviewPassResult> {
  const model = opts?.model ?? REVIEW_MODEL_PREFERRED;
  const timeoutMs = opts?.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const batches = batchReviewEntries(entries);
  const proposals: ReviewProposal[] = [];
  const drops: Record<string, number> = {};

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const prompt = reviewPrompt(batch);
    let parsed: unknown | null = null;
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      try {
        const raw = await generateBatch(ollama, prompt, { model, timeoutMs });
        parsed = parseReviewResponse(raw);
      } catch {
        parsed = null;
      }
    }
    if (parsed === null || extractRawProposals(parsed) === null) {
      drops.parse_failed = (drops.parse_failed ?? 0) + 1;
      opts?.onProgress?.(i + 1, batches.length);
      continue;
    }
    const result = validateProposals(parsed, batch);
    proposals.push(...result.proposals);
    mergeDrops(drops, result.drops);
    opts?.onProgress?.(i + 1, batches.length);
  }

  return { proposals, drops, model, batches: batches.length };
}

