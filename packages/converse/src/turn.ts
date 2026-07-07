import crypto from 'node:crypto';
import type { MemoryEntry, RememberInput, RetrieveOptions, ScoredEntry, ListFilter } from '@northkeep/core';
import type { ImportedConversation } from '@northkeep/importers';
import { dedupeCandidates, extractFromConversation, type OllamaClient } from '@northkeep/librarian';
import { applyTier1, redact, restore, type PseudonymMap, type Replacement } from '@northkeep/redact';
import { appendCallLog, type CallLogEntry } from '@northkeep/mcp-server';
import type { ChatMessage, ModelProvider, PrivacyTier } from './provider.js';
import { classifyEndpoint } from './provider.js';

/**
 * runTurn: what happens on one message (ADR 0007). Locally and in order:
 * retrieve → compress → assemble → redact → call → restore → distill → audit.
 *
 * INVARIANT #1: the assembled prompt reaches the provider ONLY after the
 * active redaction tier has run. For a bounded (non-private) endpoint,
 * Tier-1 is the enforced minimum and there is no bypass path in this file —
 * the provider call sits strictly after the redaction step, and a Tier-2
 * request that degrades on a bounded endpoint aborts the turn instead of
 * silently downgrading (invariant #6).
 */

/**
 * The slice of vault access that a turn needs — structural, so tests use
 * fakes. Methods may be async: surfaces that open the encrypted vault under
 * a file lock per operation (the GUI server, the CLI) implement each method
 * as its own short lock window instead of holding the lock across a
 * minutes-long model stream. `commit` persists a batch atomically.
 */
export interface ConverseVault {
  retrieve(query: string, options?: RetrieveOptions): ScoredEntry[] | Promise<ScoredEntry[]>;
  list(filter?: ListFilter): MemoryEntry[] | Promise<MemoryEntry[]>;
  /** Remember all inputs and persist, in one vault-lock window. */
  commit(inputs: RememberInput[]): MemoryEntry[] | Promise<MemoryEntry[]>;
}

/**
 * Adapt anything that exposes `withVault(fn)` over a real Vault (the GUI
 * session, the CLI helper) into a ConverseVault with short lock windows.
 */
export function vaultAdapter(
  withVault: <T>(
    fn: (vault: {
      retrieve(query: string, options?: RetrieveOptions): ScoredEntry[];
      list(filter?: ListFilter): MemoryEntry[];
      remember(input: RememberInput): MemoryEntry;
      save(): void;
    }) => T,
  ) => Promise<T>,
): ConverseVault {
  return {
    retrieve: (query, options) => withVault((v) => v.retrieve(query, options)),
    list: (filter) => withVault((v) => v.list(filter)),
    commit: (inputs) =>
      withVault((v) => {
        const created = inputs.map((input) => v.remember(input));
        if (created.length > 0) v.save();
        return created;
      }),
  };
}

/**
 * Per-conversation state. History is kept as PLAINTEXT (real names, with
 * Tier-1 secrets already one-way-masked in the assistant's restored replies),
 * and the ENTIRE prompt — system + history + new message — is re-redacted at
 * the effective tier on every turn before it is sent. This is the security
 * invariant that makes mid-session endpoint swapping safe: if an earlier turn
 * ran on a private endpoint with redaction off, its plaintext is re-masked
 * the moment the conversation moves to a bounded endpoint. Never store
 * already-redacted "wire" text and replay it — a weaker tier would leak.
 * `pseudonyms` persists so "Bob Henderson" is the same Person-N every turn.
 */
export interface ConverseSession {
  pseudonyms: PseudonymMap;
  plainHistory: ChatMessage[];
}

export function createSession(): ConverseSession {
  return { pseudonyms: {}, plainHistory: [] };
}

export class TurnError extends Error {
  constructor(
    readonly code: 'TIER2_UNAVAILABLE' | 'PROVIDER_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'TurnError';
  }
}

export interface TurnOptions {
  message: string;
  session: ConverseSession;
  provider: ModelProvider;
  model: string;
  vault: ConverseVault;
  /** 0 = no redaction (allowed ONLY for private endpoints), 1, or 2. */
  redactTier: 0 | 1 | 2;
  allowedScopes?: string[];
  /** Scope for memories distilled from this conversation. */
  memoryScope?: string;
  memoryLimit?: number;
  memoryCharBudget?: number;
  /** Loopback distillation model; null = heuristic extraction only. */
  distillOllama?: OllamaClient | null;
  /** Set false to skip memory distillation for this turn. */
  distill?: boolean;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  /** Injection points for tests. */
  redactFn?: typeof redact;
  restoreFn?: typeof restore;
  auditFn?: (entry: CallLogEntry) => void;
  now?: () => Date;
}

export interface TurnResult {
  /** The reply, pseudonyms restored (Tier-1 masks stay masked, by design). */
  reply: string;
  privacy: PrivacyTier;
  endpointHost: string;
  model: string;
  tierApplied: 0 | 1 | 2;
  tier2Degraded: boolean;
  memoriesUsed: Array<{ id: string; type: string; scope: string; content: string }>;
  memoriesCreated: MemoryEntry[];
  distillMode: 'llm' | 'heuristic' | 'off';
}

const DEFAULT_MEMORY_LIMIT = 6;
const DEFAULT_CHAR_BUDGET = 4000;
/** Keep memories scoring within this fraction of the best match; drop the rest. */
const RELEVANCE_RATIO = 0.6;

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const {
    message,
    session,
    provider,
    model,
    vault,
    allowedScopes,
    onToken,
    signal,
  } = options;
  const redactFn = options.redactFn ?? redact;
  const restoreFn = options.restoreFn ?? restore;
  const auditFn = options.auditFn ?? appendCallLog;
  const now = options.now ?? (() => new Date());

  const { tier: privacy, host: endpointHost } = classifyEndpoint(provider.baseUrl);

  // Bounded endpoints get Tier-1 minimum, whatever the caller asked for.
  const effectiveTier: 0 | 1 | 2 =
    privacy === 'bounded' && options.redactTier === 0 ? 1 : options.redactTier;

  // 1. Retrieve (scope-enforced in the store, M4).
  const scored = await vault.retrieve(message, {
    allowedScopes,
    limit: options.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
  });

  // 2. Compress to budget. Keep score order, drop the weak tail, stop when the
  //    character budget is spent. Keyword retrieval scores the WHOLE message,
  //    so a long message ("...my friend Bob wants to know what coffee...")
  //    loosely matches unrelated memories; injecting all of them makes a
  //    chatty model confabulate. The relevance floor keeps only memories
  //    scoring within RELEVANCE_RATIO of the best match (the top match is
  //    always kept). Tunable; semantic retrieval will make this sharper.
  //    A small local model also wants a tighter digest — lower memoryCharBudget.
  const budget = options.memoryCharBudget ?? DEFAULT_CHAR_BUDGET;
  const floor = (scored[0]?.score ?? 0) * RELEVANCE_RATIO;
  const used: ScoredEntry[] = [];
  let spent = 0;
  for (const s of scored) {
    if (used.length > 0 && s.score < floor) break; // scored is sorted desc
    if (spent + s.entry.content.length > budget && used.length > 0) break;
    used.push(s);
    spent += s.entry.content.length;
  }

  // 3. Assemble.
  const memoryBlock =
    used.length === 0
      ? ''
      : [
          '## What you remember about the user',
          `(from their private memory vault — entries: ${used.map((s) => s.entry.id.slice(0, 8)).join(', ')})`,
          ...used.map((s) => `- [${s.entry.type}] ${s.entry.content}`),
        ].join('\n');
  const systemText = [
    'You are the user\'s private assistant. Their own memory vault provides the context below; use it naturally and never claim to have no memory of them.',
    'Some names or values may appear as placeholders like "Person-1" or "[SSN]". Use the placeholders exactly as written — they are restored to the real values on the user\'s machine after you answer.',
    memoryBlock,
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');

  // 4. Redact outbound. STRICTLY before the provider call; no path skips it
  //    for a bounded endpoint. The WHOLE prompt is redacted every turn —
  //    system + full history + new message — so nothing that was captured at
  //    a weaker tier (e.g. plaintext from an earlier private-endpoint turn)
  //    can ride along unredacted when the conversation moves to a bounded
  //    endpoint. `replacements` is rebuilt per turn and therefore covers every
  //    pseudonym present in this prompt, so the reply restores completely.
  const plainPrompt: ChatMessage[] = [
    { role: 'system', content: systemText },
    ...session.plainHistory,
    { role: 'user', content: message },
  ];
  let wirePrompt = plainPrompt;
  const replacements: Replacement[] = [];
  let tierApplied: 0 | 1 | 2 = 0;
  let tier2Degraded = false;
  // Fail closed: redact for anything that isn't an explicit tier-0 (the only
  // value allowed to skip, and only ever set for a private endpoint above).
  if (effectiveTier !== 0) {
    const redacted: ChatMessage[] = [];
    for (const msg of plainPrompt) {
      const r = await redactFn(msg.content, {
        tier: effectiveTier,
        pseudonyms: session.pseudonyms,
      });
      if (r.tier2Degraded) tier2Degraded = true;
      redacted.push({ role: msg.role, content: r.redacted });
      replacements.push(...r.replacements);
    }
    if (effectiveTier === 2 && tier2Degraded && privacy === 'bounded') {
      // Loud, not silent (invariant #6): the user asked for pseudonymization
      // toward a remote endpoint and it is not available — do not send.
      audit(auditFn, now, {
        ok: false,
        denied: true,
        error: 'tier2-unavailable',
        endpointHost,
        model,
        privacy,
        tier: effectiveTier,
        allowedScopes,
        message,
        used: [],
        created: [],
      });
      throw new TurnError(
        'TIER2_UNAVAILABLE',
        'Tier-2 pseudonymization is unavailable (is Ollama running?) and this endpoint is not private. Nothing was sent. Start the local model, or explicitly switch this endpoint to Tier 1.',
      );
    }
    wirePrompt = redacted;
    tierApplied = effectiveTier === 2 && tier2Degraded ? 1 : effectiveTier;
  }

  // 5. Call the provider — direct client→endpoint, nothing proxies.
  const wireMessages: ChatMessage[] = wirePrompt;
  let wireReply: string;
  try {
    wireReply = await provider.chat(wireMessages, { model, onToken, signal });
  } catch (err) {
    audit(auditFn, now, {
      ok: false,
      error: err instanceof Error ? err.message : 'provider call failed',
      endpointHost,
      model,
      privacy,
      tier: tierApplied,
      allowedScopes,
      message,
      used: used.map((s) => s.entry),
      created: [],
    });
    throw new TurnError(
      'PROVIDER_FAILED',
      err instanceof Error ? err.message : 'The model endpoint did not answer.',
    );
  }

  // 6. Restore pseudonyms locally (Tier-1 masks are one-way and stay). This
  //    turn's `replacements` covers every pseudonym in the prompt — including
  //    ones re-introduced from history — so a name the model echoes from an
  //    earlier turn still round-trips.
  const reply = restoreFn(wireReply, replacements);

  // History is stored as PLAINTEXT (see ConverseSession): the user's real
  // message and the restored reply. It is re-redacted at send time every
  // turn, so it is always masked to the CURRENT endpoint's tier — never
  // replayed at a stale, weaker tier.
  session.plainHistory.push(
    { role: 'user', content: message },
    { role: 'assistant', content: reply },
  );

  // 8. Distill this exchange into memory — on the RESTORED plaintext, which
  //    never leaves the machine (loopback Ollama or pure heuristics).
  let memoriesCreated: MemoryEntry[] = [];
  let distillMode: TurnResult['distillMode'] = 'off';
  if (options.distill !== false) {
    const outcome = await distillExchange({
      vault,
      allowedScopes,
      message,
      reply,
      memoryScope: options.memoryScope ?? 'personal',
      ollama: options.distillOllama ?? null,
      now,
    });
    memoriesCreated = outcome.created;
    distillMode = outcome.mode;
  }

  // 9. Audit — one content-free row.
  audit(auditFn, now, {
    ok: true,
    endpointHost,
    model,
    privacy,
    tier: tierApplied,
    allowedScopes,
    message,
    used: used.map((s) => s.entry),
    created: memoriesCreated,
  });

  return {
    reply,
    privacy,
    endpointHost,
    model,
    tierApplied,
    tier2Degraded,
    memoriesUsed: used.map((s) => ({
      id: s.entry.id,
      type: s.entry.type,
      scope: s.entry.scope,
      content: s.entry.content,
    })),
    memoriesCreated,
    distillMode,
  };
}

async function distillExchange(args: {
  vault: ConverseVault;
  allowedScopes?: string[];
  message: string;
  reply: string;
  memoryScope: string;
  ollama: OllamaClient | null;
  now: () => Date;
}): Promise<{ created: MemoryEntry[]; mode: 'llm' | 'heuristic' }> {
  const conversation: ImportedConversation = {
    id: crypto.randomUUID(),
    title: 'Converse',
    source: 'converse',
    created_at: args.now().toISOString(),
    messages: [
      { role: 'user', text: args.message, created_at: null },
      { role: 'assistant', text: args.reply, created_at: null },
    ],
  };
  const extraction = await extractFromConversation(conversation, args.ollama);
  // Never memorize a secret. The distillation model sees the raw exchange
  // (real SSNs, cards, keys), so any candidate that still contains a Tier-1
  // secret is dropped — the vault stores facts about the user, not their
  // secrets. `applyTier1` is synchronous and pure; a non-empty replacement
  // set means the candidate carried a secret.
  const secretFree = extraction.candidates.filter(
    (c) => applyTier1(c.content).replacements.length === 0,
  );
  const existing = await args.vault.list({ allowedScopes: args.allowedScopes });
  const { unique } = dedupeCandidates(secretFree, existing);
  const created =
    unique.length === 0
      ? []
      : await args.vault.commit(
          unique.map((candidate) => ({
            content: candidate.content,
            type: candidate.type,
            scope: args.memoryScope,
            source: 'converse',
            sourceModel: extraction.model === 'heuristic' ? null : extraction.model,
            confidence: candidate.confidence,
            metadata: { conversation_id: conversation.id },
          })),
        );
  return { created, mode: extraction.mode };
}

function audit(
  auditFn: (entry: CallLogEntry) => void,
  now: () => Date,
  args: {
    ok: boolean;
    denied?: boolean;
    error?: string;
    endpointHost: string;
    model: string;
    privacy: PrivacyTier;
    tier: number;
    allowedScopes?: string[];
    message: string;
    used: MemoryEntry[];
    created: MemoryEntry[];
  },
): void {
  const entry: CallLogEntry = {
    ts: now().toISOString(),
    tool: 'converse',
    provider: 'northkeep-converse',
    granted_scopes: args.allowedScopes,
    redaction_tier: args.tier,
    params: {
      query_terms: args.message.split(/\s+/).filter((t) => t.length > 0).length,
      content_chars: args.message.length,
    },
    ok: args.ok,
    ...(args.denied !== undefined ? { denied: args.denied } : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
    result_count: args.used.length,
    result_ids: args.used.map((e) => e.id),
    disclosed_scopes: [...new Set(args.used.map((e) => e.scope))],
    endpoint_host: args.endpointHost,
    model: args.model,
    privacy: args.privacy,
    ...(args.created.length > 0 ? { created_ids: args.created.map((e) => e.id) } : {}),
  };
  try {
    auditFn(entry);
  } catch {
    // The audit write must not take a completed turn down with it; the row
    // is advisory, the enforcement already happened above.
  }
}
