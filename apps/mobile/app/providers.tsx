import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, Stack, useFocusEffect } from 'expo-router';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../src/ui';
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  getProviderKey,
  getSelectedProviderId,
  CLAUDE_MODELS,
  hasKey,
  listProviders,
  ON_DEVICE_PROVIDER_ID,
  removeProvider,
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
import { getLocalModel } from '../src/lib/local-model';
import type { LocalModelResolution } from '@northkeep/platform-mobile/dist/local-model/index.js';

/**
 * BYOK provider settings (M6-3 / M6-6). Pick a known provider (URLs + curated
 * models reused from the shared @northkeep/converse catalog), or Custom for any
 * OpenAI-compatible endpoint. Anthropic shows one-tap Claude model chips; every
 * OpenAI-compatible provider can "Discover models" from the live endpoint. The
 * API key is written to expo-secure-store ONLY; it is never shown back, never
 * stored in the vault, never logged. Editing leaves the key untouched unless a
 * new one is typed.
 */

/** Cap discovered-model chips (OpenRouter returns hundreds); free-text covers the rest. */
const DISCOVER_CHIP_LIMIT = 40;

export default function Providers() {
  const session = useVaultSession();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyed, setKeyed] = useState<Record<string, boolean>>({});
  const [localRes, setLocalRes] = useState<LocalModelResolution | null>(null);

  // form
  const [editingId, setEditingId] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    const list = await listProviders();
    const sel = await getSelectedProviderId();
    const flags: Record<string, boolean> = {};
    for (const p of list) flags[p.id] = await hasKey(p.id);
    // Apple-first detection; the llama fallback is never auto-probed here, so no
    // model file can download implicitly (invariant #7).
    const res = await getLocalModel();
    setProviders(list);
    setSelectedId(sel);
    setKeyed(flags);
    setLocalRes(res);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;

  const preset = PROVIDER_PRESETS.find((p) => p.key === presetKey) ?? null;
  const curatedModels: PresetModel[] = kind === 'anthropic' ? CLAUDE_MODELS : (preset?.models ?? []);
  const selectedNote =
    curatedModels.find((m) => m.id === model.trim())?.note ??
    (discovered?.includes(model.trim()) ? 'From your endpoint' : 'Custom model id (typed below).');

  function resetForm() {
    setEditingId(null);
    setPresetKey('anthropic');
    setKind('anthropic');
    setLabel('');
    setBaseUrl(ANTHROPIC_BASE_URL);
    setModel(DEFAULT_ANTHROPIC_MODEL);
    setApiKey('');
    setError(null);
    setDiscovered(null);
    setDiscoverMsg(null);
  }

  function onPickPreset(p: MobilePreset) {
    setPresetKey(p.key);
    setKind(p.kind);
    setBaseUrl(p.baseUrl);
    setModel(p.defaultModel);
    setDiscovered(null);
    setDiscoverMsg(null);
    if (!p.custom && label.trim().length === 0) setLabel(p.name);
  }

  function onEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setKind(p.kind);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setApiKey(''); // blank = keep the stored key
    setError(null);
    setDiscovered(null);
    setDiscoverMsg(null);
    const match = PROVIDER_PRESETS.find((pr) => pr.kind === p.kind && pr.baseUrl === p.baseUrl);
    setPresetKey(match?.key ?? '');
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
      resetForm();
      await refresh();
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

  async function onDelete(id: string) {
    setBusy(true);
    try {
      await removeProvider(id);
      if (editingId === id) resetForm();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onSelect(id: string) {
    await setSelectedProviderId(id);
    setSelectedId(id);
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: 'Providers' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <FieldLabel>On-device</FieldLabel>
        {(() => {
          const available = localRes?.model != null;
          const selected = selectedId === ON_DEVICE_PROVIDER_ID && available;
          return (
            <Pressable
              style={[styles.card, { gap: 10 }, selected && styles.cardSelected, !available && styles.cardDisabled]}
              onPress={() => available && void onSelect(ON_DEVICE_PROVIDER_ID)}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: !available }}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={selected ? colors.accent : colors.muted}
              />
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>On-device (private)</Text>
                <Text style={styles.cardSub} numberOfLines={2}>
                  {available
                    ? `${localRes?.model?.label} · fully private, no key, works in airplane mode`
                    : 'Not available on this phone (needs Apple Intelligence on iOS 26)'}
                </Text>
              </View>
            </Pressable>
          );
        })()}
        <Text style={styles.hint}>
          On-device chat runs entirely on your phone with Apple Intelligence and never sends
          anything off the device. A downloadable local model (about 1 to 2 GB) for older phones is
          not enabled in this build and would be an explicit, separate opt-in.
        </Text>

        {providers.length > 0 ? (
          <>
            <FieldLabel>Your providers</FieldLabel>
            {providers.map((p) => {
              const selected = p.id === selectedId;
              return (
                <View key={p.id} style={[styles.card, selected && styles.cardSelected]}>
                  <Pressable style={styles.cardMain} onPress={() => void onSelect(p.id)} accessibilityRole="button">
                    <Ionicons
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={selected ? colors.accent : colors.muted}
                    />
                    <View style={styles.cardText}>
                      <Text style={styles.cardTitle}>{p.label}</Text>
                      {/* Identity field: provider + model. Wraps, never truncates. */}
                      <Text style={styles.cardSub}>
                        {p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'} · {p.model}
                        {keyed[p.id] ? '' : ' · no key'}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() => onEdit(p)}
                    hitSlop={{ top: 13, bottom: 13, left: 13, right: 13 }}
                    accessibilityLabel={`Edit ${p.label}`}
                  >
                    <Ionicons name="pencil" size={18} color={colors.muted} style={styles.cardIcon} />
                  </Pressable>
                  <Pressable
                    onPress={() => void onDelete(p.id)}
                    hitSlop={{ top: 13, bottom: 13, left: 13, right: 13 }}
                    accessibilityLabel={`Delete ${p.label}`}
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.danger} style={styles.cardIcon} />
                  </Pressable>
                </View>
              );
            })}
          </>
        ) : null}

        <FieldLabel>{editingId ? 'Edit provider' : 'Add a provider'}</FieldLabel>

        {editingId === null ? (
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
        ) : null}

        <FieldLabel>Name</FieldLabel>
        <TextInput
          style={styles.input}
          value={label}
          onChangeText={setLabel}
          placeholder="My Claude key"
          placeholderTextColor={colors.muted}
        />

        {kind === 'openai' ? (
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

        {kind === 'openai' ? (
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
        {editingId ? (
          <Button title="Cancel edit" kind="secondary" onPress={resetForm} style={styles.cancelBtn} />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  cardSelected: { borderColor: colors.accent },
  cardDisabled: { opacity: 0.55 },
  cardMain: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
  cardText: { flex: 1 },
  cardTitle: { ...type.body, color: colors.text, fontWeight: '600' },
  cardSub: { ...type.caption, color: colors.muted, fontWeight: '400', marginTop: 2 },
  cardIcon: { marginLeft: 14 },
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
