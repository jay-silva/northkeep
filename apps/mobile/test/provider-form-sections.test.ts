import { describe, expect, it } from 'vitest';
import { providerFormSections } from '../src/lib/provider-form-sections';

describe('providerFormSections', () => {
  it('Anthropic: discloses neither base URL nor discovery (fixed endpoint)', () => {
    // presetHardcodesBaseUrl is irrelevant for anthropic; both false.
    expect(providerFormSections({ kind: 'anthropic', presetHardcodesBaseUrl: false })).toEqual({
      showBaseUrl: false,
      showDiscovery: false,
    });
    expect(providerFormSections({ kind: 'anthropic', presetHardcodesBaseUrl: true })).toEqual({
      showBaseUrl: false,
      showDiscovery: false,
    });
  });

  it('OpenAI preset that hardcodes a base URL (OpenAI/OpenRouter/Groq): hides both', () => {
    expect(providerFormSections({ kind: 'openai', presetHardcodesBaseUrl: true })).toEqual({
      showBaseUrl: false,
      showDiscovery: false,
    });
  });

  it('Custom / Ollama (no hardcoded base URL): shows base URL AND discovery', () => {
    expect(providerFormSections({ kind: 'openai', presetHardcodesBaseUrl: false })).toEqual({
      showBaseUrl: true,
      showDiscovery: true,
    });
  });

  it('editing a custom provider whose base URL matches no preset still shows both', () => {
    // The screen leaves presetHardcodesBaseUrl false when no preset matches the
    // edited provider's base URL, so the endpoint controls stay reachable.
    expect(providerFormSections({ kind: 'openai', presetHardcodesBaseUrl: false })).toEqual({
      showBaseUrl: true,
      showDiscovery: true,
    });
  });

  it('base URL and discovery are always disclosed together (never one without the other)', () => {
    for (const kind of ['anthropic', 'openai'] as const) {
      for (const presetHardcodesBaseUrl of [true, false]) {
        const s = providerFormSections({ kind, presetHardcodesBaseUrl });
        expect(s.showBaseUrl).toBe(s.showDiscovery);
      }
    }
  });
});
