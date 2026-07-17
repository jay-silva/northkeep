import {
  runTurn,
  createSession,
  TurnError,
  type ConverseSession,
  type ConverseVault,
} from '@northkeep/converse/dist/turn.js';
import type { RetrieveOptions, ScoredEntry } from '@northkeep/core';
import type { LocalModel } from '@northkeep/platform-mobile/dist/local-model/index.js';
import { createMobileProvider, type OutboundCapture } from './mobile-providers';
import { createLocalModelProvider } from './local-provider';
import { makeLocalTier2RedactFn } from './local-model';
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
  /**
   * On-device model (M6-4). When present AND ready, a CLOUD turn is upgraded to
   * Tier-2: named entities are pseudonymized on the phone before send (desktop
   * shape). When null/absent/not-ready, the turn stays at the Tier-1 floor.
   * Ignored by runOnDeviceTurn, which uses the model as the provider itself.
   */
  localModel?: LocalModel | null;
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

function vaultFrom(
  retrieve: (query: string, options?: RetrieveOptions) => ScoredEntry[],
): ConverseVault {
  return {
    // Scope-enforced scored retrieval happens inside the vault (core).
    retrieve: (query, options) => retrieve(query, options),
    // list/commit are only used by distillation, which we disable below.
    list: () => [],
    commit: () => [],
  };
}

export async function runMobileTurn(input: MobileTurnInput): Promise<MobileTurnResult> {
  let captured: OutboundCapture | null = null;
  const provider = createMobileProvider(input.provider, input.apiKey, (c) => {
    captured = c;
  });

  // M6-4: upgrade to Tier-2 when an on-device model is present AND ready to
  // pseudonymize named entities locally. Not-ready (or absent) keeps the Tier-1
  // floor — never a silent downgrade. If the model then errors mid-turn,
  // applyTier2 flags tier2Degraded and runTurn ABORTS the bounded-endpoint send
  // (TurnError TIER2_UNAVAILABLE) rather than leak names (invariant #6).
  const useTier2 = input.localModel ? await input.localModel.isReady() : false;

  const result = await runTurn({
    message: input.message,
    session: input.session,
    provider,
    model: input.provider.model,
    vault: vaultFrom(input.retrieve),
    // Bounded (cloud) endpoint: Tier-1 is the guaranteed minimum, Tier-2 when a
    // ready local model can pseudonymize on-device first. Never 0 on a cloud turn.
    redactTier: useTier2 ? 2 : 1,
    ...(useTier2 && input.localModel
      ? { redactFn: makeLocalTier2RedactFn(input.localModel) }
      : {}),
    distill: false, // no on-phone distillation yet
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

/** Input for an airplane-mode turn: the on-device model IS the provider. */
export interface OnDeviceTurnInput {
  message: string;
  session: ConverseSession;
  localModel: LocalModel;
  retrieve: (query: string, options?: RetrieveOptions) => ScoredEntry[];
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

/**
 * Airplane-mode private chat (M6-4): the reply is generated on the phone by the
 * LocalModel. The endpoint is a localhost sentinel, so runTurn classifies it
 * 'private' and runs at redact tier 0 — correct, because nothing leaves the
 * device to redact against. The outbound capture still records what the model
 * was given, so "What left this device" can honestly show it never egressed.
 */
export async function runOnDeviceTurn(input: OnDeviceTurnInput): Promise<MobileTurnResult> {
  let captured: OutboundCapture | null = null;
  const provider = createLocalModelProvider(input.localModel);
  // Wrap chat() so the same OutboundCapture the cloud providers emit is produced
  // for the audit view (the local provider itself does not take an onOutbound).
  const baseChat = provider.chat.bind(provider);
  const capturingProvider = {
    ...provider,
    chat: (messages: Parameters<typeof baseChat>[0], options: Parameters<typeof baseChat>[1]) => {
      captured = {
        kind: 'openai',
        endpoint: provider.baseUrl,
        model: input.localModel.label,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      };
      return baseChat(messages, options);
    },
  };

  const result = await runTurn({
    message: input.message,
    session: input.session,
    provider: capturingProvider,
    model: input.localModel.label,
    vault: vaultFrom(input.retrieve),
    redactTier: 0, // private endpoint: on-device, no egress to redact against
    distill: false,
    catalog: [],
    auditFn: () => {},
    onToken: input.onToken,
    signal: input.signal,
  });

  lastAudit = {
    at: new Date().toISOString(),
    providerLabel: `${input.localModel.label} (on-device)`,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    outbound: captured ?? {
      kind: 'openai',
      endpoint: provider.baseUrl,
      model: input.localModel.label,
      messages: [],
    },
  };

  return {
    reply: result.reply,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    memoriesUsed: result.memoriesUsed.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    outbound: lastAudit.outbound,
  };
}
