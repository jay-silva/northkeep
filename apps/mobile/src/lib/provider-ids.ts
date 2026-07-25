/**
 * Provider identifiers and the shapes that describe one, with NO React Native
 * imports.
 *
 * Split out of providers-store.ts so pure logic (and its tests) can reach these
 * without pulling in expo-secure-store, which cannot be parsed outside the RN
 * bundler. providers-store re-exports them, so there is still one source of
 * truth for the id.
 */

/** The sentinel id for the on-device model. Not a configured provider. */
export const ON_DEVICE_PROVIDER_ID = 'on-device';

export type ProviderKind = 'anthropic' | 'openai';

/** The non-secret half of a provider; keys never appear in this shape. */
export interface ProviderMeta {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Endpoint base URL. Anthropic is fixed; OpenAI-compatible is user-entered. */
  baseUrl: string;
  model: string;
}
