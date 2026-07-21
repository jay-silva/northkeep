import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect, Stack, router, useLocalSearchParams } from 'expo-router';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../src/ui';
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  getProviderKey,
  CLAUDE_MODELS,
  listProviders,
  saveProvider,
  setSelectedProviderId,
  type ProviderConfig,
} from '../src/lib/providers-store';
import {
  OLLAMA_LAN_EXAMPLE_URL,
  PROVIDER_PRESETS,
  type MobilePreset,
  type PresetModel,
} from '../src/lib/provider-presets';
import { assertMobileEndpointUrl } from '../src/lib/endpoint-gate';
import { createMobileProvider } from '../src/lib/mobile-providers';
import { providerFormSections } from '../src/lib/provider-form-sections';

/**
 * Add / edit a BYOK provider (Wave 3: split off the Providers list so the form is
 * a focused, calm screen). All logic is lifted verbatim from the old inline form
 * in providers.tsx: preset -> URL/model prefill, https-or-LAN endpoint gate,
 * model discovery, and key handling (the API key is written to expo-secure-store
 * ONLY, never shown back, and editing leaves the stored key untouched unless a
 * new one is typed). Disclosure (Wave 3, provider-form-sections.ts) hides the
 * Base URL field and Discover models on the catalog presets that hardcode a base
 * URL; the free-text model id field is always shown, so no model is ever
 * unreachable.
 *
 * Entry: /provider-form (add) or /provider-form?id=<providerId> (edit), pushed
 * from providers.tsx. On save or cancel it router.back()s; the list refreshes on
 * focus.
 */

/** Cap discovered-model chips (OpenRouter returns hundreds); free-text covers the rest. */
const DISCOVER_CHIP_LIMIT = 40;

export default function ProviderForm() {
  const session = useVaultSession();
  const params = useLocalSearchParams<{ id?: string }>();
  const editingId = typeof params.id === 'string' && params.id.length > 0 ? params.id : null;

  // For edit, we must load the stored provider before showing the form.
  const [ready, setReady] = useState(editingId === null);

  const [presetKey, setPresetKey] = useState<string>('anthropic');
  const [kind, setKind] = useState<'anthropic' | 'openai'>('anthropic');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(ANTHROPIC_BASE_URL);
  const [model, setModel] = useState(DEFAULT_ANTHROPIC_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // model discovery (openai kind)
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);

  // Populate the form from the stored provider on entry to an edit. Runs once.
  useEffect(() => {
    if (!editingId) return;
    void (async () => {
      const list = await listProviders();
      const p = list.find((x) => x.id === editingId);
      if (p) {
        setKind(p.kind);
        setLabel(p.label);
        setBaseUrl(p.baseUrl);
        setModel(p.model);
        setApiKey(''); // blank = keep the stored key
        const match = PROVIDER_PRESETS.find((pr) => pr.kind === p.kind && pr.baseUrl === p.baseUrl);
        setPresetKey(match?.key ?? '');
      }
      setReady(true);
    })();
    // editingId is entry-only; the form is remounted per navigation.
  }, [editingId]);

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;

  const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey) ?? null;
  const curatedModels: PresetModel[] = kind === 'anthropic' ? CLAUDE_MODELS : (preset?.models ?? []);
  const selectedNote =
    curatedModels.find((m) => m.id === model.trim())?.note ??
    (discovered?.includes(model.trim()) ? 'From your endpoint' : 'Custom model id (typed below).');

  // Disclosure (Wave 3): Base URL + Discover models only where the base URL is
  // not fixed by a preset. presetHardcodesBaseUrl is true when the selected /
  // matched preset supplies a non-empty base URL (OpenAI/OpenRouter/Groq/...);
  // false for Custom, Ollama, or an edited custom provider that matched no preset.
  const presetHardcodesBaseUrl = kind === 'openai' && (preset?.baseUrl ?? '').length > 0;
  const sections = providerFormSections({ kind, presetHardcodesBaseUrl });

  function onPickPreset(p: MobilePreset) {
    setPresetKey(p.key);
    setKind(p.kind);
    setBaseUrl(p.baseUrl);
    setModel(p.defaultModel);
    setDiscovered(null);
    setDiscoverMsg(null);
    if (!p.custom && label.trim().length === 0) setLabel(p.name);
  }

  async function onSave() {
    setError(null);
    if (label.trim().length === 0) return setError('Give this provider a name.');
    if (model.trim().length === 0) return setError('Enter a model id.');
    if (kind === 'openai' && baseUrl.trim().length === 0) return setError('Enter the endpoint base URL.');
    // Endpoint gate (build 18): https anywhere; plain http only to addresses on
    // the user's own network (matches the app's ATS NSAllowsLocalNetworking).
    let endpointUrl = '';
    if (kind === 'openai') {
      try {
        endpointUrl = assertMobileEndpointUrl(baseUrl);
      } catch (err) {
        return setError(err instanceof Error ? err.message : String(err));
      }
    }
    const isNew = editingId === null;
    if (isNew && apiKey.trim().length === 0 && kind === 'anthropic') return setError('Enter your API key.');
    setBusy(true);
    try {
      const saved = await saveProvider(
        { id: editingId ?? undefined, label, kind, baseUrl: kind === 'anthropic' ? ANTHROPIC_BASE_URL : endpointUrl, model },
        apiKey.trim(),
      );
      if (isNew) await setSelectedProviderId(saved.id);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Query the entered endpoint for its model ids, reusing the shared converse
   * protocol via createMobileProvider(...).listModels() (/v1/models, then Ollama
   * /api/tags). The key travels only as the auth header inside that request; it
   * is never logged and never placed in an error message here.
   */
  async function onDiscover() {
    const url = baseUrl.trim();
    setDiscoverMsg(null);
    if (url.length === 0) {
      setDiscoverMsg('Enter the base URL first, then load models.');
      return;
    }
    setDiscovering(true);
    try {
      let key = apiKey.trim();
      if (key.length === 0 && editingId) key = (await getProviderKey(editingId)) ?? '';
      const cfg: ProviderConfig = {
        id: editingId ?? 'discover',
        label: label.trim() || 'discover',
        kind: 'openai',
        baseUrl: url,
        model: model.trim(),
      };
      const ids = await createMobileProvider(cfg, key).listModels();
      if (ids.length === 0) {
        setDiscovered([]);
        setDiscoverMsg('The endpoint returned no models. You can still type a model id below.');
      } else {
        setDiscovered(ids);
      }
    } catch {
      // Never surface the raw error (could echo the URL); never the key.
      setDiscovered(null);
      setDiscoverMsg(
        'Could not load models. Check the base URL and key, that the endpoint is reachable, then type a model id below.',
      );
    } finally {
      setDiscovering(false);
    }
  }

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Stack.Screen options={{ title: 'Edit provider' }} />
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: editingId ? 'Edit provider' : 'Add a provider' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {editingId === null ? (
          <>
            <FieldLabel>Provider</FieldLabel>
            <View style={styles.modelRow}>
              {PROVIDER_PRESETS.map((p) => {
                const on = presetKey === p.key;
                return (
                  <Pressable
                    key={p.key}
                    onPress={() => onPickPreset(p)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.kindChip, on ? styles.kindChipOn : styles.kindChipOff]}>{p.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : null}

        <FieldLabel>Name</FieldLabel>
        <TextInput
          style={styles.input}
          value={label}
          onChangeText={setLabel}
          placeholder="My Claude key"
          placeholderTextColor={colors.muted}
        />

        {sections.showBaseUrl ? (
          <>
            <FieldLabel>Base URL</FieldLabel>
            <TextInput
              style={styles.input}
              value={baseUrl}
              onChangeText={(v) => {
                setBaseUrl(v);
                setDiscovered(null);
                setDiscoverMsg(null);
              }}
              placeholder={preset?.local ? OLLAMA_LAN_EXAMPLE_URL : 'https://api.openai.com/v1'}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {preset?.local ? (
              <Text style={styles.modelNote}>
                Run Ollama on your computer and let it accept connections from your network: start
                it with OLLAMA_HOST=0.0.0.0, or turn on network access in the Ollama app's
                settings. Then enter your computer's address here, like {OLLAMA_LAN_EXAMPLE_URL}.
                iOS will ask for local network permission the first time you connect. Chats to a
                local network address stay on your network and count as private.
              </Text>
            ) : null}
          </>
        ) : null}

        <FieldLabel>Model</FieldLabel>
        {curatedModels.length > 0 ? (
          <View style={styles.modelRow}>
            {curatedModels.map((m) => {
              const on = model.trim() === m.id;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => setModel(m.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.kindChip, on ? styles.kindChipOn : styles.kindChipOff]}>{m.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {sections.showDiscovery ? (
          <>
            <View style={styles.discoverRow}>
              <Button
                title={discovering ? 'Loading models...' : 'Discover models'}
                kind="secondary"
                onPress={() => void onDiscover()}
                busy={discovering}
                style={styles.discoverBtn}
              />
            </View>
            {discoverMsg ? <Text style={styles.modelNote}>{discoverMsg}</Text> : null}
            {discovered && discovered.length > 0 ? (
              <>
                <Text style={styles.discoverLabel}>Models on this endpoint</Text>
                <View style={styles.modelRow}>
                  {discovered.slice(0, DISCOVER_CHIP_LIMIT).map((id) => {
                    const on = model.trim() === id;
                    return (
                      <Pressable
                        key={id}
                        onPress={() => setModel(id)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                      >
                        <Text style={[styles.kindChip, on ? styles.kindChipOn : styles.kindChipOff]}>{id}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {discovered.length > DISCOVER_CHIP_LIMIT ? (
                  <Text style={styles.modelNote}>
                    {`Showing the first ${DISCOVER_CHIP_LIMIT} of ${discovered.length}. Type any model id below to use another.`}
                  </Text>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        <Text style={styles.modelNote}>{selectedNote}</Text>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={setModel}
          placeholder={kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : 'Type or pick a model id'}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <FieldLabel>API key</FieldLabel>
        <TextInput
          style={styles.input}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={editingId ? 'Leave blank to keep the stored key' : preset?.local ? 'Usually not needed for a local endpoint' : 'sk-…'}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Text style={styles.hint}>
          Your key is stored in the device keychain (secure store) only. It never enters your vault,
          never syncs, and is never shown in the "what left this device" view.
        </Text>

        <ErrorNote message={error} />
        <Button
          title={editingId ? 'Save changes' : 'Add provider'}
          onPress={() => void onSave()}
          busy={busy}
          style={styles.saveBtn}
        />
        <Button title="Cancel" kind="secondary" onPress={() => router.back()} style={styles.cancelBtn} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  modelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  modelNote: { ...type.caption, color: colors.muted, fontWeight: '400', marginBottom: 10 },
  discoverRow: { flexDirection: 'row', marginTop: 4, marginBottom: 8 },
  discoverBtn: { paddingVertical: 10, paddingHorizontal: 16 },
  discoverLabel: {
    ...type.caption,
    color: colors.muted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  kindChip: {
    ...type.footnote,
    fontWeight: '600',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  kindChipOn: { color: colors.bg, borderColor: colors.accent, backgroundColor: colors.accent },
  kindChipOff: { color: colors.muted, borderColor: colors.border, backgroundColor: colors.card },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    ...type.body,
  },
  hint: { ...type.footnote, color: colors.muted, marginTop: 8 },
  saveBtn: { marginTop: 20 },
  cancelBtn: { marginTop: 10 },
});
