/**
 * API review-pass adapter (ADR 0043 P8, ADR 0060 Decision 1). Plain chat only,
 * no tools, and memory text is masked at the chosen tier before it is sent.
 * Endpoint source is the existing Converse store; only bounded hosts qualify.
 */
import { createHash } from 'node:crypto';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider } from './openai.js';
import { MEMORY_TYPES, type MemoryEntry } from '@northkeep/core';
import {
  formatReviewPrompt,
  type OllamaClient,
  type ReviewOutbound,
  type ReviewPackHandle,
  type ReviewTokenInfo,
} from '@northkeep/librarian';
import {
  createRedactionSession,
  detectContentInSession,
  detectScopeInSession,
  renderInSession,
  type RedactionSession,
  type Tier,
} from '@northkeep/redact';
import { classifyEndpoint, type ModelProvider } from './provider.js';
import { getEndpointKey, listEndpoints, type EndpointConfig } from './settings.js';

const LOCAL_REFUSE = 'That endpoint is local. Use Review pass for on-device models.';

export function listReviewApiEndpoints(): EndpointConfig[] {
  return listEndpoints().filter((e) => {
    try {
      return classifyEndpoint(e.baseUrl).tier === 'bounded';
    } catch {
      return false;
    }
  });
}

export function reviewSelectionFingerprint(
  scopes: Array<{ scope: string; count: number; shared: boolean }>,
  total: number,
): string {
  const sorted = [...scopes].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  const payload = JSON.stringify({
    scopes: sorted.map((s) => ({ scope: s.scope, count: s.count, shared: s.shared })),
    total,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function providerFor(endpoint: EndpointConfig, apiKey: string): ModelProvider {
  switch (endpoint.kind) {
    case 'openai-compatible':
      return createOpenAICompatibleProvider({ baseUrl: endpoint.baseUrl, apiKey });
    case 'anthropic':
      return createAnthropicProvider({ apiKey, baseUrl: endpoint.baseUrl });
    default: {
      const _never: never = endpoint.kind;
      throw new Error(`Unknown endpoint kind: ${String(_never)}`);
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A refusal before anything was sent; `code` goes into the audit row. */
export class ReviewApiRefusal extends Error {
  readonly code: 'tier2-unavailable' | 'invalid-entry' | 'prepare-failed';
  constructor(code: ReviewApiRefusal['code'], message: string) {
    super(message);
    this.name = 'ReviewApiRefusal';
    this.code = code;
  }
}

/** What prepare produced, for the pending audit row written before the first send. */
export interface ReviewPrepareSummary {
  tier: Tier;
  degraded: boolean;
  degradedCount: number;
  total: number;
  ids: string[];
  scopes: string[];
}

export interface ReviewApiOptions {
  tier: Tier;
  /** Loopback name model for Tiers 2 and 3; tests pass a stub. */
  ollama?: OllamaClient | null;
  drawTag?: () => string;
  /** Runs after every pack is masked and before the first send; a throw refuses the run. */
  beforeSend?: (summary: ReviewPrepareSummary) => void | Promise<void>;
  onDegraded?: (message: string) => void;
}

interface PreparedPack {
  entries: MemoryEntry[];
}

/**
 * The cloud review adapter (ADR 0060 Decision 1). There is no free-text send:
 * `send` accepts only a handle `prepare` built, checked against a module-private
 * WeakSet at runtime, and builds the prompt itself from the masked entries.
 */
const PREPARED = new WeakMap<ReviewPackHandle, PreparedPack>();

export function createReviewApiGenerator(endpoint: EndpointConfig, options: ReviewApiOptions): ReviewOutbound & {
  lastSummary(): ReviewPrepareSummary | null;
} {
  if (classifyEndpoint(endpoint.baseUrl).tier !== 'bounded') {
    throw new Error(LOCAL_REFUSE);
  }
  const key = getEndpointKey(endpoint.id);
  if (key === null || key.length === 0) {
    throw new Error(`No API key is stored for "${endpoint.label}". Add one under Settings.`);
  }
  const provider = providerFor(endpoint, key);
  const tier = options.tier;
  if (tier !== 1 && tier !== 2 && tier !== 3) throw new Error('A cloud review needs Tier 1, 2 or 3.');
  let summary: ReviewPrepareSummary | null = null;

  return {
    lastSummary: () => summary,
    async prepare(packs) {
      const all = packs.flat();
      for (const entry of all) {
        if (!UUID.test(entry.id) || !(MEMORY_TYPES as readonly string[]).includes(entry.type) || !ISO_UTC.test(entry.created_at)) {
          throw new ReviewApiRefusal('invalid-entry', 'A memory in this review has an id, type or date NorthKeep does not recognise. Nothing was sent.');
        }
      }
      let session: RedactionSession;
      try {
        session = createRedactionSession(all.flatMap((e) => [e.content, e.scope, e.id, e.type, e.created_at]), options.drawTag);
      } catch (err) {
        throw new ReviewApiRefusal('prepare-failed', `${err instanceof Error ? err.message : String(err)} Nothing was sent.`);
      }
      const unique = new Map(all.map((e) => [e.id, e]));
      const failed = new Set<string>();
      const degradedIds = new Set<string>();
      // Pass 1: detect in every memory and collection name before rendering
      // any, so a name found in one memory is masked in all of them (code
      // review F2).
      for (const entry of unique.values()) {
        let r = await detectContentInSession(session, entry.content, tier, options.ollama);
        // F3: judged per call; one retry, then the run-level rule.
        if (r.degraded) r = await detectContentInSession(session, entry.content, tier, options.ollama);
        if (r.degraded) {
          if (tier === 2) failed.add(entry.id);
          else degradedIds.add(entry.id);
        }
        detectScopeInSession(session, entry.scope, tier);
      }
      if (failed.size > 0) {
        throw new ReviewApiRefusal(
          'tier2-unavailable',
          `Name masking failed for ${failed.size} of ${unique.size} memories. Nothing was sent. Start the local model, or choose Tier 1 or Tier 3.`,
        );
      }
      const handles: ReviewPackHandle[] = [];
      for (const pack of packs) {
        const tokens = new Set<string>();
        // Pass 2: render with every token the run issued.
        const entries = pack.map((entry) => {
          const content = renderInSession(session, entry.content);
          const scope = renderInSession(session, entry.scope);
          for (const t of content.issued) tokens.add(t);
          for (const t of scope.issued) tokens.add(t);
          return {
            ...entry,
            content: content.wire,
            scope: scope.wire,
            created_at: tier === 3 ? entry.created_at.slice(0, 4) : entry.created_at,
          };
        });
        const tokenInfo = new Map<string, ReviewTokenInfo>();
        for (const t of tokens) {
          const info = session.tokens.get(t)!;
          tokenInfo.set(t, { original: info.original, nameKind: info.nameKind });
        }
        const handle: ReviewPackHandle = Object.freeze({ tag: session.tag, tokens, tokenInfo });
        PREPARED.set(handle, { entries });
        handles.push(handle);
      }
      summary = {
        tier,
        degraded: degradedIds.size > 0,
        degradedCount: degradedIds.size,
        total: unique.size,
        ids: [...unique.keys()],
        scopes: [...new Set([...unique.values()].map((e) => e.scope))].sort(),
      };
      if (degradedIds.size > 0) {
        options.onDegraded?.(`Tier 3, deterministic only (name model offline for ${degradedIds.size} of ${unique.size} memories)`);
      }
      await options.beforeSend?.(summary);
      return handles;
    },
    async send(handle, opts) {
      const prepared = PREPARED.get(handle);
      if (prepared === undefined) throw new Error('Only a pack prepared by this review can be sent.');
      if (classifyEndpoint(endpoint.baseUrl).tier !== 'bounded') {
        throw new Error(LOCAL_REFUSE);
      }
      const prompt = formatReviewPrompt(prepared.entries, { placeholderTag: handle.tag });
      const chatOpts: { model: string; signal?: AbortSignal } = { model: opts.model ?? endpoint.model };
      if (opts.timeoutMs !== undefined) chatOpts.signal = AbortSignal.timeout(opts.timeoutMs);
      const reply = await provider.chat([{ role: 'user', content: prompt }], chatOpts);
      return stripJsonFences(reply);
    },
  };
}
