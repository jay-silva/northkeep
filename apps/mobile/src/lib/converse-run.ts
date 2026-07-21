import {
  runTurn,
  createSession,
  TurnError,
  type ConverseSession,
  type ConverseVault,
} from '@northkeep/converse/dist/turn.js';
import { redact } from '@northkeep/redact';
import type { RetrieveOptions, ScoredEntry } from '@northkeep/core';
import type { LocalModel } from '@northkeep/platform-mobile/dist/local-model/index.js';
import { createMobileProvider, type OutboundCapture } from './mobile-providers';
import { createLocalModelProvider } from './local-provider';
import { createNLTaggerNerClient } from './nltagger-ner';
import type { ProviderConfig } from './providers-store';

// Apple FM NER path retired in favor of NLTagger 2026-07-21; kept for rollback,
// delete after on-device acceptance. The send path no longer wires the Apple FM
// per-kind client (makeLocalTier2RedactFn) or its per-pass fold (foldFailedNerPasses):
//   import { makeLocalTier2RedactFn } from './local-model';
//   import { foldFailedNerPasses, type NerPassRecord } from './ner-degrade';
// NLTagger is a single native tagNames call with no per-kind passes, so there
// are no partial-pass failures to fold; a native failure degrades the whole
// pass (tier2Degraded), which runTurn still reports.

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
   * On-device model (M6-4). No longer used by the cloud NER net: since
   * 2026-07-21 the name net is the always-on NLTagger client (nltagger-ner.ts),
   * which needs no model detection or download. Retained on the input for
   * call-site compatibility and possible future use; runMobileTurn does not read
   * it. Airplane-mode chat still uses the model directly via runOnDeviceTurn.
   */
  localModel?: LocalModel | null;
  /**
   * Explicit "send with the deterministic floor only" (the Tier-1 resend after
   * a name-net abort). When true, runMobileTurn withholds the NLTagger client so
   * redact() runs deterministic-only; the deterministic shield always runs
   * regardless. Defaults to false (NLTagger name net on, the iOS posture).
   */
  disableNameNet?: boolean;
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
  /**
   * True when the Tier-2 NLTagger name net did not run this turn (native module
   * absent, e.g. Android, or the native call threw), taken from runTurn's own
   * tier2Degraded, the pipeline's source of truth. The deterministic layers
   * still ran; the audit view must say so LOUDLY (invariant #6), never
   * silently.
   */
  tier2Degraded: boolean;
  /**
   * Always empty with the NLTagger net: it is a SINGLE native pass, not a
   * per-kind decomposition, so there are no partial-pass failures to report; a
   * native failure degrades the whole pass and surfaces as tier2Degraded above.
   * Retained (content-free, pass ids only) for the audit view's shape and for
   * the retired Apple FM path's rollback.
   */
  failedPasses: string[];
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
  /** Mirrors MobileTurnResult.tier2Degraded for the audit warning. */
  tier2Degraded: boolean;
  /** Mirrors MobileTurnResult.failedPasses (pass ids only, content-free). */
  failedPasses: string[];
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

  // M6-4 + ADR 0022 (NLTagger swap 2026-07-21): run the REAL desktop Tier-3
  // pipeline on the phone. redact() runs its deterministic dictionary floor
  // first, then hands the dict-masked text to the NLTagger name net as one
  // strict-gated pass. NLTagger ships in every iOS, so the net is ALWAYS on
  // here — no model detection, download, or readiness gate. A degraded/absent
  // net (Android, or a native throw mid-turn) PROCEEDS on the deterministic
  // guarantee (tier-3 semantics) and is reported as tier2Degraded. The explicit
  // Tier-1 resend (disableNameNet) withholds the client so redact() runs
  // deterministic-only. Unlike the retired Apple FM client there are no per-kind
  // passes, so there is no partial-pass fold: failedPasses stays empty and
  // tier2Degraded is the single degrade signal.
  const nerClient = input.disableNameNet ? null : createNLTaggerNerClient();
  const redactFn = (text: string, opts?: Parameters<typeof redact>[1]) =>
    redact(text, opts, nerClient);

  const result = await runTurn({
    message: input.message,
    session: input.session,
    provider,
    model: input.provider.model,
    vault: vaultFrom(input.retrieve),
    redactTier: 3, // deterministic guarantee + NER net when the model is ready
    redactFn,
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
  // NLTagger is a single native pass with no per-kind decomposition, so there
  // are never partial-pass failures to report; a native failure degrades the
  // whole pass and surfaces as result.tier2Degraded below. Kept for the audit
  // shape (the view still renders TIER2_UNAVAILABLE_MESSAGE on full degrade).
  const failedPasses: string[] = [];

  lastAudit = {
    at: new Date().toISOString(),
    providerLabel: input.provider.label,
    tierApplied: result.tierApplied,
    endpointHost: result.endpointHost,
    privacy: result.privacy,
    outbound: captured,
    redactions,
    tier2Degraded: result.tier2Degraded,
    failedPasses,
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
    tier2Degraded: result.tier2Degraded,
    failedPasses,
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
    tier2Degraded: false, // tier 0: no egress, so there is no name net to degrade
    failedPasses: [],
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
    tier2Degraded: false,
    failedPasses: [],
  };
}
