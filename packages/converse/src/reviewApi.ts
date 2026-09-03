/**
 * API review-pass adapter (ADR 0043 P8). Plain chat only. No tools.
 * Endpoint source is the existing Converse store; only bounded hosts qualify.
 */
import { createHash } from 'node:crypto';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatibleProvider } from './openai.js';
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

export function createReviewApiGenerator(endpoint: EndpointConfig): {
  generateJson(prompt: string, opts?: { model?: string; timeoutMs?: number }): Promise<string>;
} {
  if (classifyEndpoint(endpoint.baseUrl).tier !== 'bounded') {
    throw new Error(LOCAL_REFUSE);
  }
  const key = getEndpointKey(endpoint.id);
  if (key === null || key.length === 0) {
    throw new Error(`No API key is stored for "${endpoint.label}". Add one under Settings.`);
  }
  const provider = providerFor(endpoint, key);

  return {
    async generateJson(prompt, opts) {
      if (classifyEndpoint(endpoint.baseUrl).tier !== 'bounded') {
        throw new Error(LOCAL_REFUSE);
      }
      const chatOpts: { model: string; signal?: AbortSignal } = {
        model: opts?.model ?? endpoint.model,
      };
      if (opts?.timeoutMs !== undefined) {
        chatOpts.signal = AbortSignal.timeout(opts.timeoutMs);
      }
      const reply = await provider.chat([{ role: 'user', content: prompt }], chatOpts);
      return stripJsonFences(reply);
    },
  };
}
