import { describe, expect, it } from 'vitest';
import { KNOWN_PROVIDERS, getProvider } from '../src/provider-catalog.js';

/** The curated onboarding registry (M9b, ADR 0014) — public metadata only. */

const EXPECTED_IDS = ['anthropic', 'openai', 'google', 'xai', 'openrouter', 'meta'];

describe('KNOWN_PROVIDERS', () => {
  it('seeds all six providers Jay chose', () => {
    expect(KNOWN_PROVIDERS.map((p) => p.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('every provider has a valid kind and non-empty base/key URLs, steps, and models', () => {
    for (const p of KNOWN_PROVIDERS) {
      expect(['openai-compatible', 'anthropic'], p.id).toContain(p.kind);
      expect(p.baseUrl, p.id).toMatch(/^https:\/\//);
      expect(p.keyUrl, p.id).toMatch(/^https:\/\//);
      expect(p.keySteps.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.models.length, p.id).toBeGreaterThan(0);
      for (const m of p.models) {
        expect(m.id, `${p.id}/${m.label}`).not.toBe('');
        expect(m.label, `${p.id}/${m.id}`).not.toBe('');
        expect(['free-local', 'low', 'medium', 'high'], `${p.id}/${m.id}`).toContain(m.costTier);
      }
    }
  });

  it('only Anthropic is the native kind; the rest are OpenAI-compatible', () => {
    expect(getProvider('anthropic')?.kind).toBe('anthropic');
    for (const id of ['openai', 'google', 'xai', 'openrouter', 'meta']) {
      expect(getProvider(id)?.kind, id).toBe('openai-compatible');
    }
  });

  it('carries no secrets — no field looks like a live key', () => {
    const blob = JSON.stringify(KNOWN_PROVIDERS);
    // sk-ant-/sk-/xai- appear only as documented PREFIXES, never as full keys.
    expect(blob).not.toMatch(/sk-ant-[A-Za-z0-9]{10,}/);
    expect(blob).not.toMatch(/xai-[A-Za-z0-9]{10,}/);
  });

  it('Meta Llama is represented via OpenRouter (Meta has no first-party API)', () => {
    const meta = getProvider('meta')!;
    expect(meta.baseUrl).toContain('openrouter.ai');
    expect(meta.keyPrefix).toBe('sk-or-');
    expect(meta.models.every((m) => m.id.startsWith('meta-llama/'))).toBe(true);
  });

  it('getProvider returns null for an unknown id', () => {
    expect(getProvider('nope')).toBeNull();
  });
});
