import * as SecureStore from 'expo-secure-store';

/**
 * BYOK model-provider storage for M6-3 Converse.
 *
 * SECURITY POSTURE (invariant-critical):
 *  - API keys live in expo-secure-store ONLY, one keychain item per provider
 *    (`nk.converse.key.<id>`). They are NEVER written to the vault blob, never
 *    to any plaintext store, never logged, and never returned to the audit view.
 *  - Non-secret provider metadata (label, kind, base URL, model id) is kept as a
 *    JSON list in its own keychain item. There is no AsyncStorage in this app,
 *    and metadata deliberately never travels alongside the key.
 *  - WHEN_UNLOCKED_THIS_DEVICE_ONLY on every item (matches secure-store.ts):
 *    keys never migrate to a new device and never land in an iCloud/adb backup.
 *
 * NEEDS ON-DEVICE VALIDATION: SecureStore accessibility semantics are
 * device-only (same caveat as src/lib/secure-store.ts).
 */

export type ProviderKind = 'anthropic' | 'openai';

/** Non-secret provider config. The API key is stored separately, never here. */
export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Endpoint base URL. Anthropic is fixed; OpenAI-compatible is user-entered. */
  baseUrl: string;
  model: string;
}

const PROVIDERS_KEY = 'nk.converse.providers';
const SELECTED_KEY = 'nk.converse.selected';
const KEY_PREFIX = 'nk.converse.key.';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/**
 * Current Claude models offered as one-tap picks in the provider screen (a user
 * can still type any model id). Ordered best-first within intent. Keep the ids
 * exact — Anthropic model ids are complete as-is, never date-suffixed.
 */
export const CLAUDE_MODELS: { id: string; label: string; note: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'Most capable, best default' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Near-Opus quality, lower cost' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest and cheapest' },
  { id: 'claude-fable-5', label: 'Fable 5', note: 'Most capable overall, premium price' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', note: 'Previous-generation Opus' },
];

/**
 * Reserved selection id for the on-device model (M6-4). It is NOT a stored
 * ProviderConfig (no key, no endpoint, no metadata); it is a sentinel the
 * selection persists, so "On-device (private)" survives app restarts like any
 * other choice. listProviders() never returns it; Converse special-cases it and
 * routes the turn through the local model (runOnDeviceTurn). Kept out of the
 * `nk.converse.key.*` namespace so no key item is ever created for it.
 */
export const ON_DEVICE_PROVIDER_ID = 'on-device';

/** Keychain keys must be alphanumeric + ".-_"; keep generated ids in that set. */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function keyItem(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

export async function listProviders(): Promise<ProviderConfig[]> {
  const raw = await SecureStore.getItemAsync(PROVIDERS_KEY, OPTIONS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is ProviderConfig =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as ProviderConfig).id === 'string' &&
        ((p as ProviderConfig).kind === 'anthropic' || (p as ProviderConfig).kind === 'openai'),
    );
  } catch {
    return [];
  }
}

async function writeProviders(list: ProviderConfig[]): Promise<void> {
  // Only non-secret metadata is serialized here — never a key.
  await SecureStore.setItemAsync(PROVIDERS_KEY, JSON.stringify(list), OPTIONS);
}

/**
 * Add or update a provider. The API key goes to its own keychain item; passing
 * an empty apiKey on an EDIT leaves the existing key untouched (so the user can
 * change the label/model without re-typing the key). A new provider requires a
 * key.
 */
export async function saveProvider(
  input: Omit<ProviderConfig, 'id'> & { id?: string },
  apiKey: string,
): Promise<ProviderConfig> {
  const list = await listProviders();
  const id = input.id ?? newId();
  const cfg: ProviderConfig = {
    id,
    label: input.label.trim(),
    kind: input.kind,
    baseUrl: input.baseUrl.trim(),
    model: input.model.trim(),
  };
  if (apiKey.length > 0) {
    await SecureStore.setItemAsync(keyItem(id), apiKey, OPTIONS);
  }
  const next = list.some((p) => p.id === id)
    ? list.map((p) => (p.id === id ? cfg : p))
    : [...list, cfg];
  await writeProviders(next);
  // First provider added becomes the selected one.
  if ((await getSelectedProviderId()) === null) await setSelectedProviderId(id);
  return cfg;
}

export async function removeProvider(id: string): Promise<void> {
  const list = await listProviders();
  await writeProviders(list.filter((p) => p.id !== id));
  await SecureStore.deleteItemAsync(keyItem(id));
  if ((await getSelectedProviderId()) === id) {
    const remaining = list.filter((p) => p.id !== id);
    await setSelectedProviderId(remaining[0]?.id ?? null);
  }
}

export async function getSelectedProviderId(): Promise<string | null> {
  return SecureStore.getItemAsync(SELECTED_KEY, OPTIONS);
}

export async function setSelectedProviderId(id: string | null): Promise<void> {
  if (id === null) await SecureStore.deleteItemAsync(SELECTED_KEY);
  else await SecureStore.setItemAsync(SELECTED_KEY, id, OPTIONS);
}

/** True if a key is stored for this provider — WITHOUT returning the key. */
export async function hasKey(id: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(keyItem(id), OPTIONS)) !== null;
}

/**
 * Load the API key for a turn. Kept out of React state and never logged; read
 * it right before the call and let it fall out of scope after. Returns null if
 * absent.
 */
export async function getProviderKey(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(keyItem(id), OPTIONS);
}
