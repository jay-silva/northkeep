import { describe, expect, it } from 'vitest';
import { BASELINE_CATALOG, lookupModel } from '../src/catalog.js';
import { route } from '../src/route.js';
import type { EndpointConfig } from '../src/settings.js';

/** Catalog matching + the catalog routing phase (M7c, ADR 0011 decision 3). */

const ep = (id: string, baseUrl: string, model: string): EndpointConfig => ({
  id,
  label: id,
  baseUrl,
  model,
  kind: 'openai-compatible',
  hasKey: false,
});

describe('lookupModel', () => {
  it('matches family prefixes inside real tags', () => {
    expect(lookupModel('qwen2.5:14b', [...BASELINE_CATALOG])?.id).toBe('qwen2.5');
    expect(lookupModel('llama3.2:3b', [...BASELINE_CATALOG])?.id).toBe('llama3.2');
    expect(lookupModel('claude-opus-4-8', [...BASELINE_CATALOG])?.id).toBe('claude-opus');
  });
  it('longest match wins: the coder variant beats the family', () => {
    expect(lookupModel('qwen2.5-coder:7b', [...BASELINE_CATALOG])?.id).toBe('qwen2.5-coder');
  });
  it('unknown models are simply not catalogued', () => {
    expect(lookupModel('totally-novel-model', [...BASELINE_CATALOG])).toBeNull();
  });
});

describe('route — catalog phase (no rule spoke)', () => {
  const llama = ep('llama', 'http://127.0.0.1:11434', 'llama3.2:3b'); // quick/general, fast
  const qwen = ep('qwen', 'http://127.0.0.1:11434', 'qwen2.5:14b'); // code/reasoning/general
  const cloud = ep('cloud', 'https://api.example.com', 'claude-opus-4-8'); // code/…, high cost
  const base = { policy: { rules: [] }, defaultEndpointId: 'llama' } as const;

  it('routes code to the code-strong model even though the default is the generalist', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints: [llama, qwen],
      ceiling: 'bounded-allowed',
      ...base,
    });
    expect(d.endpointId).toBe('qwen');
    expect(d.reason).toContain('catalog');
  });

  it('prefers the cheaper strong model when several match (local qwen over hosted opus)', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints: [cloud, qwen],
      ceiling: 'bounded-allowed',
      policy: { rules: [] },
      defaultEndpointId: 'cloud',
    });
    expect(d.endpointId).toBe('qwen'); // free-local beats high cost
  });

  it('quick questions prefer the FAST strong model', () => {
    const d = route({
      message: 'What time is it in Boston?',
      endpoints: [qwen, llama],
      ceiling: 'bounded-allowed',
      ...base,
    });
    expect(d.endpointId).toBe('llama'); // fast beats medium for quick
  });

  it('the ceiling binds the catalog phase too: private-only never picks the hosted match', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints: [cloud, qwen],
      ceiling: 'private-only',
      policy: { rules: [] },
      defaultEndpointId: 'cloud',
    });
    expect(d.endpointId).toBe('qwen');
  });

  it('an explicit rule still beats the catalog', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints: [llama, qwen],
      ceiling: 'bounded-allowed',
      policy: { rules: [{ task: 'code', endpointId: 'llama' }] },
      defaultEndpointId: 'qwen',
    });
    expect(d.endpointId).toBe('llama');
    expect(d.reason).toContain('rule');
  });

  it('uncatalogued models fall through to the default endpoint as before', () => {
    const a = ep('a', 'http://127.0.0.1:1', 'a-model');
    const b = ep('b', 'http://127.0.0.1:2', 'b-model');
    const d = route({
      message: 'fix this ```code```',
      endpoints: [a, b],
      ceiling: 'bounded-allowed',
      policy: { rules: [] },
      defaultEndpointId: 'b',
    });
    expect(d.endpointId).toBe('b');
    expect(d.reason).toContain('default');
  });
});
