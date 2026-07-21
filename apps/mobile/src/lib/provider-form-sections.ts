/**
 * Which optional sections the add/edit provider form discloses (Wave 3 density
 * polish, disclosure only). Pure TypeScript with NO React Native / Expo /
 * @northkeep imports, so the preset -> visibility mapping is unit-tested under
 * Node (apps/mobile/test/provider-form-sections.test.ts).
 *
 * WHY THIS EXISTS: the old provider form showed the Base URL field and the
 * "Discover models" control for every OpenAI-compatible provider, including the
 * catalog presets (OpenAI, OpenRouter, Groq, ...) that hardcode their base URL
 * and ship curated model chips. That is clutter on the paths where the user
 * never needs to touch the URL. We disclose Base URL + Discover models only
 * where they are actually needed: the Custom / bring-your-own-endpoint path
 * (and the local Ollama preset), where no base URL is prefilled.
 *
 * SCOPE: pure visibility. This module changes no save, discovery, or key
 * behavior. The free-text model id field is ALWAYS shown by the screen (never
 * gated here), so hiding "Discover models" never blocks picking a non-curated
 * model id -- it stays a disclosure change, not a capability removal.
 *
 * DISCRIMINATOR: does the resolved preset supply a non-empty base URL?
 *  - Anthropic kind: neither section (fixed endpoint, curated Claude chips).
 *  - OpenAI kind + preset hardcodes a base URL (OpenAI/OpenRouter/Groq/...):
 *    hide both; curated chips + free-text cover model choice.
 *  - OpenAI kind + no hardcoded base URL (Custom, Ollama, or editing a custom
 *    provider whose base URL matches no preset): show both; the user must enter
 *    the endpoint, and discovery helps them find its model ids.
 */

export interface ProviderFormSections {
  /** Show the Base URL text field. */
  showBaseUrl: boolean;
  /** Show the "Discover models" control (+ its discovered-model chips). */
  showDiscovery: boolean;
}

export function providerFormSections(input: {
  kind: 'anthropic' | 'openai';
  /** True when the selected/matched preset supplies a non-empty base URL. */
  presetHardcodesBaseUrl: boolean;
}): ProviderFormSections {
  if (input.kind !== 'openai') {
    // Anthropic: fixed endpoint, no discovery.
    return { showBaseUrl: false, showDiscovery: false };
  }
  // OpenAI-compatible: disclose the endpoint controls only when the base URL is
  // not already fixed by a preset (Custom / Ollama / edited custom provider).
  const needsEndpoint = !input.presetHardcodesBaseUrl;
  return { showBaseUrl: needsEndpoint, showDiscovery: needsEndpoint };
}
