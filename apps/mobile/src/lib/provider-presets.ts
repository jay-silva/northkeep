import { KNOWN_PROVIDERS } from '@northkeep/converse/dist/provider-catalog.js';
import type { ProviderKind } from './providers-store';

/**
 * Known-provider presets for the mobile "Connect a model" flow, at PARITY with
 * the desktop GUI. The provider list, base URLs, and curated model ids are
 * REUSED from the shared catalog `@northkeep/converse` `KNOWN_PROVIDERS`
 * (packages/converse/src/provider-catalog.ts, ADR 0014) — the single source of
 * truth, web-verified 2026-07. We do not invent or copy base URLs here.
 *
 * Two entries are mobile-only additions (not in the desktop catalog) and are the
 * only things to keep in sync by hand:
 *   - Ollama (on your computer): the desktop treats a local Ollama as a custom
 *     OpenAI-compat endpoint; on the phone we surface it as a first-class LAN
 *     preset (build 18: ATS NSAllowsLocalNetworking permits plain HTTP to
 *     private addresses). No base URL is prefilled: on a phone "localhost" is
 *     the phone itself, so the user must enter their computer's LAN address
 *     (Ollama's documented port 11434, OpenAI-compat `/v1` path; example
 *     below). A private-LAN address classifies as a 'private' endpoint in the
 *     Converse pipeline, same as the desktop classifier.
 *   - Custom: the freeform escape hatch (no base URL preset).
 *
 * `kind` maps the catalog's transport ('openai-compatible' | 'anthropic') onto
 * the mobile ProviderKind ('openai' | 'anthropic').
 */

export interface PresetModel {
  id: string;
  label: string;
  note: string;
}

export interface MobilePreset {
  /** UI id for chip selection. */
  key: string;
  /** Chip label. */
  name: string;
  kind: ProviderKind;
  /** Preset base URL ('' for Custom). */
  baseUrl: string;
  /** Model to preselect (a curated recommended id, when the catalog has one). */
  defaultModel: string;
  /** Curated pick-don't-type model chips (may be empty; discovery fills the rest). */
  models: PresetModel[];
  /** True for the freeform Custom entry. */
  custom?: boolean;
  /** True for the local Ollama entry (LAN-address hint in the UI). */
  local?: boolean;
}

const COST_NOTE: Record<string, string> = {
  high: 'Most capable, higher cost',
  medium: 'Balanced quality and cost',
  low: 'Fast and inexpensive',
};

function modelNote(recommended: boolean | undefined, costTier: string): string {
  const base = COST_NOTE[costTier] ?? costTier;
  return recommended ? `${base} · recommended` : base;
}

/** The catalog providers, mapped to mobile presets (URLs/models reused as-is). */
const CATALOG_PRESETS: MobilePreset[] = KNOWN_PROVIDERS.map((p) => {
  const recommended = p.models.find((m) => m.recommended) ?? p.models[0];
  return {
    key: p.id,
    name: p.name,
    kind: p.kind === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: p.baseUrl,
    defaultModel: recommended?.id ?? '',
    models: p.models.map((m) => ({
      id: m.id,
      label: m.label,
      note: modelNote(m.recommended, m.costTier),
    })),
  } satisfies MobilePreset;
});

/**
 * Example LAN URL for the Ollama preset's placeholder/help text (Ollama's
 * documented port 11434, OpenAI-compat /v1 path, on a typical home-router
 * address). An EXAMPLE only, never prefilled: the user types their own
 * computer's address.
 */
export const OLLAMA_LAN_EXAMPLE_URL = 'http://192.168.1.5:11434/v1';

const OLLAMA_PRESET: MobilePreset = {
  key: 'ollama',
  name: 'Ollama (your computer)',
  kind: 'openai',
  baseUrl: '',
  defaultModel: '',
  models: [],
  local: true,
};

const CUSTOM_PRESET: MobilePreset = {
  key: 'custom',
  name: 'Custom',
  kind: 'openai',
  baseUrl: '',
  defaultModel: '',
  models: [],
  custom: true,
};

/**
 * All presets in picker order: Anthropic first (Claude), the other catalog
 * providers, then local Ollama and Custom.
 */
export const PROVIDER_PRESETS: MobilePreset[] = [...CATALOG_PRESETS, OLLAMA_PRESET, CUSTOM_PRESET];
