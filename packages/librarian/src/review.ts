/**
 * Memory review pass (ADR 0043). The model sees a MemoryEntry[] snapshot
 * only. No Vault handle, no tools, no writes (P1).
 */
import { isProjectScope, type MemoryEntry } from '@northkeep/core';
import type { OllamaClient } from './ollama.js';
import { REVIEW_MODEL_PREFERRED } from './ollama.js';
import {
  clusterReviewEntries,
  makeExactDuplicateProposal,
  splitReviewPack,
} from './reviewCluster.js';
import {
  extractRawProposals,
  parseReviewResponse,
  validateProposals,
  type ReviewProposal,
} from './reviewSchema.js';
import { restoreReviewReply, type ReviewPackHandle } from './reviewRestore.js';

const REVIEW_TIMEOUT_MS = 300_000;
const DATA_BEGIN = '===BEGIN MEMORY DATA===';
const DATA_END = '===END MEMORY DATA===';
const NOMIC_STATUS = 'Near-duplicate clustering needs nomic-embed-text. Exact matches only.';
const MAX_REVIEW_ENTRY_CHARS = 12_000;

const SYSTEM_INSTRUCTIONS = `You review a small pack of personal memories and propose edits. You have no tools and cannot write to the vault.

Copy quotes as exact substrings from the entry content. Do not paraphrase.

Return JSON only, in exactly this shape:
{"proposals":[{"kind":"duplicate"|"contradiction"|"stale"|"question","entry_ids":["..."],"quotes":[{"entry_id":"...","quote":"..."}],"explanation":"...","target_entry_id":null,"proposed_content":null,"question":null}]}

Rules:
- Only propose a finding supported by entries inside this pack. Do not invent pairs from outside the pack. Cite only ids listed in the data section.
- duplicate: two or more entries in this pack that state the same fact. Include every member id and a quote from each. Leave target_entry_id and proposed_content null.
- contradiction: two entries in this pack that cannot both be true. Two id-linked quotes required. Propose corrected text only when the entries establish it; otherwise emit a question.
- stale: an entry is explicitly superseded by another fact. Use stated effective dates or source statements, never created_at alone. Quote the target and set target_entry_id and proposed_content only when the replacement is established.
- contradiction and stale must include target_entry_id in entry_ids and quote that target entry itself.
- question: the entries appear inconsistent but the pack does not establish a correction. Set a concise question, leave target_entry_id and proposed_content null, and quote every listed entry.
- created_at is only when NorthKeep recorded a memory. It is not an effective date, truth ranking, or authority signal.
- A temporary exception, one-time event, conditional statement, or narrower scope is not necessarily a reversal. When uncertain, emit a question instead of forcing a replacement.
- If nothing in this pack is a same-fact duplicate, a contradiction, or a stale replacement, return {"proposals":[]}.
- Do not propose undated facts.
- explanation is a short note for the user. It is never applied as a write.`;

export interface ReviewPassResult {
  proposals: ReviewProposal[];
  drops: Record<string, number>;
  model: string;
  batches: number;
  coverage: {
    selected: number;
    compared: number;
    skipped: number;
    failed: number;
    /** Processing completed without unavailable, skipped, or failed review work. */
    complete: boolean;
  };
}

export interface ReviewPassOptions {
  model?: string;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  onStatus?: (msg: string) => void;
  /** RAM-only embedder. Never persist. Missing means exact-hash only. */
  embed?: (text: string) => Promise<ArrayLike<number>>;
}

/** Live entries only (caller uses vault.list()). Drop project: docs. Shared stays in. */
export function selectReviewEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => !isProjectScope(e.scope));
}

function formatDataSection(entries: MemoryEntry[]): string {
  const blocks = entries.map((e) => {
    return `id: ${e.id}\nscope: ${e.scope}\ntype: ${e.type}\ncreated_at: ${e.created_at}\ncontent:\n${e.content}`;
  });
  return `${DATA_BEGIN}\n${blocks.join('\n---\n')}\n${DATA_END}`;
}

/**
 * The pinned review prompt. With `placeholderTag` (the cloud path only, ADR
 * 0060 1.4 amending P3) one sentence is added; its example uses number 0,
 * which a session never issues, so the example is never a real token.
 */
export function formatReviewPrompt(entries: MemoryEntry[], opts?: { placeholderTag?: string }): string {
  const rule = opts?.placeholderTag === undefined
    ? ''
    : `\n- Some values are replaced by placeholders such as [${opts.placeholderTag}:EMAIL_0]. Copy them exactly as written; do not guess what they hide.`;
  return `${SYSTEM_INSTRUCTIONS}${rule}\n\n${formatDataSection(entries)}`;
}

function reviewPrompt(entries: MemoryEntry[]): string {
  return formatReviewPrompt(entries);
}

/**
 * The cloud path (ADR 0060 1.2). `prepare` masks every pack before the first
 * send and returns handles; `send` builds the prompt itself from what a handle
 * holds. runReviewPass never formats a prompt for this path.
 */
export interface ReviewOutbound {
  prepare(packs: MemoryEntry[][]): Promise<ReviewPackHandle[]>;
  send(handle: ReviewPackHandle, opts: { model: string; timeoutMs: number }): Promise<string>;
}

function isOutbound(g: Pick<OllamaClient, 'generateJson'> | ReviewOutbound): g is ReviewOutbound {
  return typeof (g as ReviewOutbound).prepare === 'function' && typeof (g as ReviewOutbound).send === 'function';
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

async function embedSingletons(
  singletons: MemoryEntry[],
  embed: (text: string) => Promise<ArrayLike<number>>,
): Promise<{ embeddings: Map<string, Float32Array>; failed: Set<string> }> {
  const map = new Map<string, Float32Array>();
  const failed = new Set<string>();
  let dimensions: number | null = null;
  for (const entry of singletons) {
    try {
      const vec = await embed(entry.content);
      const value = Float32Array.from(vec);
      const magnitude = value.reduce((sum, component) => sum + component * component, 0);
      if (
        value.length === 0 ||
        !value.every(Number.isFinite) ||
        !Number.isFinite(magnitude) ||
        magnitude === 0 ||
        (dimensions !== null && value.length !== dimensions)
      ) {
        failed.add(entry.id);
        continue;
      }
      dimensions ??= value.length;
      map.set(entry.id, value);
    } catch {
      failed.add(entry.id);
    }
  }
  return { embeddings: map, failed };
}

/**
 * Run the review pass over a snapshot. Does not write the vault. Does not
 * write the report (the caller saves). Cluster-first: exact hash emits
 * duplicates with no model; cosine packs (when embed is provided) are the
 * only generateJson inputs.
 */
export async function runReviewPass(
  entries: MemoryEntry[],
  ollama: Pick<OllamaClient, 'generateJson'> | ReviewOutbound,
  opts?: ReviewPassOptions,
): Promise<ReviewPassResult> {
  const model = opts?.model ?? REVIEW_MODEL_PREFERRED;
  const timeoutMs = opts?.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const proposals: ReviewProposal[] = [];
  const drops: Record<string, number> = {};
  const usedIds = new Set<string>();
  const comparedIds = new Set<string>();
  const skippedIds = new Set<string>();
  const failedIds = new Set<string>();

  const prelim = clusterReviewEntries(entries);
  for (const cluster of prelim) {
    if (cluster.kind === 'exact') {
      proposals.push(makeExactDuplicateProposal(cluster.members, usedIds));
      for (const member of cluster.members) comparedIds.add(member.id);
    }
  }
  const exactIds = new Set(
    prelim.filter((c) => c.kind === 'exact').flatMap((c) => c.members.map((m) => m.id)),
  );
  const singletons = entries.filter((e) => !exactIds.has(e.id));
  const representatives = prelim
    .filter((cluster) => cluster.kind === 'exact')
    .map((cluster) => cluster.members[0]!);
  const semanticEntries = [...singletons, ...representatives];

  const finish = (batches: number): ReviewPassResult => {
    const compared = [...comparedIds].filter(
      (id) => !skippedIds.has(id) && !failedIds.has(id),
    ).length;
    return {
      proposals,
      drops,
      model,
      batches,
      coverage: {
        selected: entries.length,
        compared,
        skipped: skippedIds.size,
        failed: failedIds.size,
        complete:
          skippedIds.size === 0 &&
          failedIds.size === 0 &&
          drops.semantic_unavailable === undefined &&
          drops.pack_split_gap === undefined &&
          compared === entries.length,
      },
    };
  };

  if (opts?.embed === undefined) {
    opts?.onStatus?.(NOMIC_STATUS);
    for (const entry of singletons) skippedIds.add(entry.id);
    for (const entry of representatives) failedIds.add(entry.id);
    if (representatives.length > 0) drops.semantic_unavailable = representatives.length;
    if (singletons.length > 0) drops.embedding_unavailable = singletons.length;
    return finish(0);
  }

  opts?.onStatus?.('Creating semantic review comparisons.');
  const embeddable = semanticEntries.filter((entry) => {
    if (entry.content.length <= MAX_REVIEW_ENTRY_CHARS) return true;
    skippedIds.add(entry.id);
    return false;
  });
  const embedded = await embedSingletons(embeddable, opts.embed);
  for (const id of embedded.failed) failedIds.add(id);
  if (embedded.failed.size > 0) {
    drops.embedding_failed = embedded.failed.size;
    opts?.onStatus?.(`${embedded.failed.size} memories could not be compared because embeddings failed.`);
  }
  const packed = clusterReviewEntries(semanticEntries, embedded.embeddings).filter(
    (c) => c.kind === 'candidate' || c.kind === 'related',
  );
  const packedIds = new Set(packed.flatMap((cluster) => cluster.members.map((member) => member.id)));
  for (const id of embedded.embeddings.keys()) {
    if (!packedIds.has(id)) comparedIds.add(id);
  }

  const modelPacks: MemoryEntry[][] = [];
  for (const cluster of packed) {
    const split = splitReviewPack(cluster.members);
    modelPacks.push(...split.packs);
    for (const skipped of split.skipped) skippedIds.add(skipped.id);
    if (split.splitCount > 0) {
      drops.pack_split = (drops.pack_split ?? 0) + split.splitCount;
      drops.pack_split_gap = (drops.pack_split_gap ?? 0) + split.splitCount;
      for (const member of cluster.members) failedIds.add(member.id);
    }
  }

  if (modelPacks.length === 0) {
    if (skippedIds.size > 0) {
      drops.oversized_entry = skippedIds.size;
      opts?.onStatus?.(`${skippedIds.size} memories were too large for a bounded review pack.`);
    }
    return finish(0);
  }

  if (drops.pack_split_gap !== undefined) {
    opts?.onStatus?.('Some related memories required separate review packs and are counted as incomplete comparisons.');
  }

  // Every pack is masked before the first send, so a refusal leaves nothing sent.
  const handles = isOutbound(ollama) ? await ollama.prepare(modelPacks) : null;

  for (let i = 0; i < modelPacks.length; i++) {
    const pack = modelPacks[i]!;
    const handle = handles?.[i];
    let parsed: unknown | null = null;
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      try {
        const raw = handle !== undefined && isOutbound(ollama)
          ? await ollama.send(handle, { model, timeoutMs })
          : await generateBatch(ollama as Pick<OllamaClient, 'generateJson'>, reviewPrompt(pack), { model, timeoutMs });
        parsed = parseReviewResponse(raw);
      } catch {
        parsed = null;
      }
    }
    if (parsed === null || extractRawProposals(parsed) === null) {
      drops.parse_failed = (drops.parse_failed ?? 0) + 1;
      for (const entry of pack) failedIds.add(entry.id);
      opts?.onStatus?.(`Review batch ${i + 1} failed validation after retry.`);
      opts?.onProgress?.(i + 1, modelPacks.length);
      continue;
    }
    const restored = handle !== undefined ? restoreReviewReply(parsed, pack, handle) : { parsed, drops: {} };
    const result = validateProposals(restored.parsed, pack);
    proposals.push(...result.proposals);
    mergeDrops(drops, restored.drops);
    mergeDrops(drops, result.drops);
    if (Object.keys(result.drops).length > 0 || Object.keys(restored.drops).length > 0) {
      for (const entry of pack) failedIds.add(entry.id);
      opts?.onStatus?.(`Review batch ${i + 1} contained invalid findings and has incomplete coverage.`);
    } else {
      for (const entry of pack) comparedIds.add(entry.id);
    }
    opts?.onProgress?.(i + 1, modelPacks.length);
  }

  if (skippedIds.size > 0) {
    drops.oversized_entry = skippedIds.size;
    opts?.onStatus?.(`${skippedIds.size} memories were too large for a bounded review pack.`);
  }
  for (const id of failedIds) comparedIds.delete(id);
  for (const id of skippedIds) comparedIds.delete(id);
  return finish(modelPacks.length);
}
