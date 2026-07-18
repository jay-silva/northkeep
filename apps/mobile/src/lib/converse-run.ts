import {
  runTurn,
  createSession,
  TurnError,
  type ConverseSession,
  type ConverseVault,
} from '@northkeep/converse/dist/turn.js';
import { redactDeterministic, type RedactionResult } from '@northkeep/redact';
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
 *   - redactFn : the on-phone firewall (ADR 0022 mobile mirror). The
 *                deterministic layers ALWAYS run: Tier-1 secrets + every full
 *                date to year + dictionary/anchor/caps/pair name scrubbing —
 *                no model needed, never degrades. When the on-device model
 *                (M6-4, Apple FM) is present AND ready, its NER pass runs
 *                FIRST as an additional net (desktop Tier-3 shape); if it
 *                errors mid-turn the deterministic layers still hold and the
 *                send PROCEEDS (redactTier 3 semantics — Tier 2 would abort).
 *                We never pass tier 0 toward a cloud endpoint.
 *   - distill  : false — no on-phone distillation.
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
   * On-device model (M6-4). When present AND ready, a CLOUD turn adds local
   * NER pseudonymization on top of the always-on deterministic layers. When
   * null/absent/not-ready, the deterministic layers alone protect the turn.
   * Ignored by runOnDeviceTurn, which uses the model as the provider itself.
   */
  localModel?: LocalModel | null;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export type MaskedItem = { placeholder: string; original: string; kind: string };

export interface MobileTurnResult {
  reply: string;
  tierApplied: 0 | 1 | 2 | 3;
  endpointHost: string;
  privacy: 'private' | 'bounded';
  memoriesUsed: Array<{ id: string; type: string; content: string }>;
  /** Exactly what left the device this turn (redacted; no key). */
  outbound: OutboundCapture;
  /** What was masked (real → placeholder), for the audit view. Ephemeral. */
  redactions: MaskedItem[];
}

/** The most recent outbound payload, for the "What left this device" screen. */
export interface LastAudit {
  at: string;
  providerLabel: string;
  tierApplied: 0 | 1 | 2 | 3;
  endpointHost: string;
  privacy: 'private' | 'bounded';
  outbound: OutboundCapture;
  /** What was masked on this turn (real → placeholder). Never persisted. */
  redactions: MaskedItem[];
  /**
   * True when the turn ran entirely on the phone (runOnDeviceTurn): the captured
   * payload is what the LOCAL model was given and never left the device. The
   * audit view must say so, not present it as an egress.
   */
  onDevice: boolean;
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

  // M6-4 + ADR 0022: the deterministic layers ALWAYS run; a ready on-device
  // model adds an NER pass first (union — it can only ADD masks). If the NER
  // errors mid-turn its failure is contained: the deterministic layers already
  // ran, the send proceeds (tier-3 semantics), and nothing is silently weaker
  // than the always-on floor.
  const useLocalNer = input.localModel ? await input.localModel.isReady() : false;
  const localNer =
    useLocalNer && input.localModel ? makeLocalTier2RedactFn(input.localModel) : null;

  const composedRedactFn = async (
    text: string,
    opts?: Parameters<typeof redactDeterministic>[1],
  ): Promise<RedactionResult> => {
    let working = text;
    const replacements: RedactionResult['replacements'] = [];
    if (localNer) {
      try {
        const ner = await localNer(working, { tier: 2, pseudonyms: opts?.pseudonyms });
        if (!ner.tier2Degraded) {
          working = ner.redacted;
          replacements.push(...ner.replacements);
        }
      } catch {
        // NER is the bonus net; the deterministic layers below are the floor.
      }
    }
    const det = await redactDeterministic(working, opts);
    return {
      redacted: det.redacted,
      replacements: [...replacements, ...det.replacements],
      tierApplied: det.tierApplied,
      tier2Degraded: false, // the always-on floor ran; nothing degraded
    };
  };

  const result = await runTurn({
    message: input.message,
    session: input.session,
    provider,
    model: input.provider.model,
    vault: vaultFrom(input.retrieve),
    // Tier 3 semantics: deterministic layers are the guarantee; the local NER
    // rides on top and its failure never aborts the turn. Never 0 on device.
    redactTier: useLocalNer ? 3 : 1,
    redactFn: composedRedactFn,
    distill: false, // no on-phone distillation
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

  const redactions: MaskedItem[] = (result.redactions ?? []).map((r) => ({
    placeholder: r.placeholder,
    original: r.original,
    kind: r.kind,
  }));

  lastAudit = {
    at: new Date().toISOString(),
    providerLabel: input.provider.label,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    outbound: captured,
    redactions,
    onDevice: false,
  };

  return {
    reply: result.reply,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    memoriesUsed: result.memoriesUsed.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    outbound: captured,
    redactions,
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
    redactions: [], // nothing masked — nothing left the device
    onDevice: true,
  };

  return {
    reply: result.reply,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    memoriesUsed: result.memoriesUsed.map((m) => ({ id: m.id, type: m.type, content: m.content })),
    outbound: lastAudit.outbound,
    redactions: [],
  };
}
