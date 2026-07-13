import type { CostTier } from './catalog.js';
import type { TaskKind } from './route.js';

/**
 * The curated known-provider registry (M9b, ADR 0014) that powers guided
 * onboarding: pick a provider → "how to get a key" → paste → pick a model.
 * The freeform "add any OpenAI-compatible endpoint" form remains the escape
 * hatch for anything not listed here.
 *
 * This is PUBLIC METADATA ONLY — base URLs, key-page links, curated model ids,
 * rough cost tiers. It holds NO secrets and NO API keys (keys live in the
 * Keychain via the existing addEndpoint path). Safe to ship in the OSS repo.
 *
 * Values verified against provider docs 2026-07 (they drift — re-verify at each
 * milestone): Anthropic api.anthropic.com / console.anthropic.com; OpenAI
 * api.openai.com/v1 / platform.openai.com/api-keys; Google Gemini
 * generativelanguage.googleapis.com/v1beta/openai / aistudio.google.com/apikey;
 * xAI api.x.ai/v1 / console.x.ai; OpenRouter openrouter.ai/api/v1 / openrouter.ai/keys.
 */

export interface ProviderModel {
  /** The exact model id to send on the wire. */
  id: string;
  /** Human-facing name for the picker. */
  label: string;
  costTier: CostTier;
  /** Approximate context window in tokens, if known. */
  contextWindow?: number;
  /** Task kinds this model is notably good at (drives ordering + hints). */
  strengths: TaskKind[];
  /** Sensible default to preselect in the picker. */
  recommended?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** Native Anthropic vs the universal OpenAI-compatible transport. */
  kind: 'openai-compatible' | 'anthropic';
  /** API base URL to configure the endpoint with. */
  baseUrl: string;
  /** Where the user creates an API key. */
  keyUrl: string;
  /** 2–3 short steps to obtain a key, shown next to the keyUrl link. */
  keySteps: string[];
  /** Stable key prefix, when the provider uses one (soft-validate, warn-not-block). */
  keyPrefix?: string;
  /** Provider API docs, for the curious. */
  docsUrl?: string;
  models: ProviderModel[];
}

export const KNOWN_PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keySteps: [
      'Sign in at console.anthropic.com.',
      'Open Settings → API keys and click Create Key.',
      'Copy the key (starts with sk-ant-) — it is shown only once.',
    ],
    keyPrefix: 'sk-ant-',
    docsUrl: 'https://docs.anthropic.com/en/api/overview',
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', costTier: 'high', contextWindow: 1_000_000, strengths: ['code', 'reasoning', 'long-context', 'creative'], recommended: true },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', costTier: 'medium', contextWindow: 1_000_000, strengths: ['code', 'reasoning', 'long-context'] },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', costTier: 'low', contextWindow: 200_000, strengths: ['quick', 'general'] },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySteps: [
      'Sign in at platform.openai.com.',
      'Open API keys and click Create new secret key.',
      'Copy the key (starts with sk-) — it is shown only once.',
    ],
    keyPrefix: 'sk-',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    models: [
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', costTier: 'medium', contextWindow: 400_000, strengths: ['code', 'reasoning', 'general'], recommended: true },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', costTier: 'high', contextWindow: 400_000, strengths: ['code', 'reasoning', 'long-context'] },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', costTier: 'low', contextWindow: 400_000, strengths: ['quick', 'general'] },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'openai-compatible',
    // Google exposes an OpenAI-compatible surface at this base; the /openai
    // suffix is required (native Gemini lives one path up).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    keySteps: [
      'Sign in at aistudio.google.com.',
      'Click Get API key → Create API key.',
      'Copy the key (starts with AIza).',
    ],
    keyPrefix: 'AIza',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    models: [
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', costTier: 'high', contextWindow: 1_000_000, strengths: ['code', 'reasoning', 'long-context', 'general'], recommended: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', costTier: 'low', contextWindow: 1_000_000, strengths: ['general', 'quick', 'long-context'] },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', costTier: 'low', contextWindow: 1_000_000, strengths: ['quick', 'general'] },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    keySteps: [
      'Sign in at console.x.ai and finish onboarding.',
      'Open API Keys → Create API Key.',
      'Copy the key (starts with xai-).',
    ],
    keyPrefix: 'xai-',
    docsUrl: 'https://docs.x.ai/developers/quickstart',
    models: [
      { id: 'grok-4.5', label: 'Grok 4.5', costTier: 'high', contextWindow: 256_000, strengths: ['reasoning', 'code', 'general'], recommended: true },
      { id: 'grok-3', label: 'Grok 3', costTier: 'medium', contextWindow: 256_000, strengths: ['reasoning', 'general'] },
      { id: 'grok-3-fast', label: 'Grok 3 Fast', costTier: 'medium', contextWindow: 131_000, strengths: ['quick', 'general'] },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keySteps: [
      'Sign in at openrouter.ai.',
      'Open Keys and click Create Key.',
      'Copy the key (starts with sk-or-). One key reaches many models.',
    ],
    keyPrefix: 'sk-or-',
    docsUrl: 'https://openrouter.ai/docs',
    models: [
      { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8 (via OpenRouter)', costTier: 'high', contextWindow: 1_000_000, strengths: ['code', 'reasoning', 'long-context', 'creative'], recommended: true },
      { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra (via OpenRouter)', costTier: 'medium', contextWindow: 400_000, strengths: ['code', 'reasoning', 'general'] },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat (via OpenRouter)', costTier: 'low', contextWindow: 128_000, strengths: ['general', 'code', 'reasoning'] },
      { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick (via OpenRouter)', costTier: 'low', contextWindow: 1_000_000, strengths: ['general', 'code', 'reasoning'] },
    ],
  },
  {
    id: 'meta',
    name: 'Meta Llama (via OpenRouter)',
    kind: 'openai-compatible',
    // DECISION (ADR 0014): Meta wound down its first-party Llama API — there is
    // no cleanly, generally-available OpenAI-compatible api.llama.com endpoint
    // to point at as of 2026-07 (Meta directs developers to third-party hosts).
    // So "Meta Llama" is represented as HOSTED via OpenRouter: same base URL and
    // sk-or- key as the OpenRouter entry, scoped to meta-llama/* model ids.
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keySteps: [
      "Meta has no first-party Llama API — NorthKeep hosts Llama via OpenRouter.",
      'Sign in at openrouter.ai and open Keys → Create Key.',
      'Copy the key (starts with sk-or-).',
    ],
    keyPrefix: 'sk-or-',
    docsUrl: 'https://openrouter.ai/meta-llama',
    models: [
      { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick', costTier: 'low', contextWindow: 1_000_000, strengths: ['general', 'code', 'reasoning'], recommended: true },
      { id: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout', costTier: 'low', contextWindow: 10_000_000, strengths: ['general', 'long-context'] },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', costTier: 'low', contextWindow: 128_000, strengths: ['general', 'code'] },
    ],
  },
];

/** Look up a curated provider by id. */
export function getProvider(id: string): ProviderInfo | null {
  return KNOWN_PROVIDERS.find((p) => p.id === id) ?? null;
}
