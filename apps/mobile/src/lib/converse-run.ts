import {
  runTurn,
  createSession,
  TurnError,
  type ConverseSession,
  type ConverseVault,
} from '@northkeep/converse/dist/turn.js';
import type { RetrieveOptions, ScoredEntry } from '@northkeep/core';
import { createMobileProvider, type OutboundCapture } from './mobile-providers';
import type { ProviderConfig } from './providers-store';

/**
 * The M6-3 Converse turn on device. This runs the REAL runTurn pipeline
 * (packages/converse/src/turn.ts): retrieve -> compress -> assemble -> redact
 * -> call -> restore -> (distill) -> audit, in that order, with the
 * invariant-critical rules intact (Tier-1 firewall strictly before the provider
 * call; the WHOLE prompt re-redacted every turn). We do not re-implement any of
 * that here — we only INJECT the mobile-specific seams runTurn already exposes:
 *
 *   - provider : an expo/fetch ModelProvider (mobile-providers.ts)
 *   - vault    : a ConverseVault backed by the unlocked vault's scored retrieve
 *   - redactTier: 1 — the HARD outbound firewall. Tier-2 (Ollama NER) does not
 *                 exist on the phone; the UI shows a loud persistent banner
 *                 (invariant #6). We never pass tier 0, so nothing outbound
 *                 ever skips Tier-1.
 *   - distill  : false — no on-device distillation (no local model; and we do
 *                 not want a chat turn silently writing/syncing new memories).
 *                 Deferred; see the report.
 *   - catalog  : [] — skip loadCatalog()'s node:fs read; cost estimate is null.
 *   - auditFn  : in-memory no-op — the append-only call-log file is desktop-only.
 *
 * The "what left this device" proof is captured at the provider boundary: the
 * `messages` array runTurn hands to provider.chat() IS the post-redaction wire
 * prompt. We snapshot that body (never headers, so the key cannot appear) and
 * expose it to the audit view.
 */

export { createSession, TurnError };
export type { ConverseSession };

export interface MobileTurnInput {
  message: string;
  session: ConverseSession;
  provider: ProviderConfig;
  apiKey: string;
  /** Scored retrieval over the unlocked vault (VaultSession.retrieve). */
  retrieve: (query: string, options?: RetrieveOptions) => ScoredEntry[];
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface MobileTurnResult {
  reply: string;
  tierApplied: 0 | 1 | 2;
  endpointHost: string;
  privacy: 'private' | 'bounded';
  memoriesUsed: Array<{ id: string; type: string; content: string }>;
  /** Exactly what left the device this turn (redacted; no key). */
  outbound: OutboundCapture;
}

/** The most recent outbound payload, for the "What left this device" screen. */
export interface LastAudit {
  at: string;
  providerLabel: string;
  tierApplied: 0 | 1 | 2;
  endpointHost: string;
  privacy: 'private' | 'bounded';
  outbound: OutboundCapture;
}

let lastAudit: LastAudit | null = null;
export function getLastAudit(): LastAudit | null {
  return lastAudit;
}

export async function runMobileTurn(input: MobileTurnInput): Promise<MobileTurnResult> {
  let captured: OutboundCapture | null = null;
  const provider = createMobileProvider(input.provider, input.apiKey, (c) => {
    captured = c;
  });

  const vault: ConverseVault = {
    // Scope-enforced scored retrieval happens inside the vault (core).
    retrieve: (query, options) => input.retrieve(query, options),
    // list/commit are only used by distillation, which we disable below.
    list: () => [],
    commit: () => [],
  };

  const result = await runTurn({
    message: input.message,
    session: input.session,
    provider,
    model: input.provider.model,
    vault,
    redactTier: 1, // hard Tier-1 firewall — never 0 on device
    distill: false, // no on-phone distillation (no Ollama)
    catalog: [], // avoid loadCatalog() node:fs; cost lookup returns null
    auditFn: () => {}, // call-log file is desktop-only
    onToken: input.onToken,
    signal: input.signal,
  });

  if (!captured) {
    // provider.chat() always fires onOutbound before the network call; if we
    // reach here the turn somehow produced a reply without sending — fail loud
    // rather than claim we have audit proof we do not.
    throw new Error('Internal: outbound payload was not captured for the audit view.');
  }

  lastAudit = {
    at: new Date().toISOString(),
    providerLabel: input.provider.label,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    outbound: captured,
  };

  return {
    reply: result.reply,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    memoriesUsed: result.memoriesUsed.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    outbound: captured,
  };
}
