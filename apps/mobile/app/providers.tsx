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
import { Button, ErrorNote, FieldLabel, colors } from '../src/ui';
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  getSelectedProviderId,
  hasKey,
  listProviders,
  removeProvider,
  saveProvider,
  setSelectedProviderId,
  type ProviderConfig,
  type ProviderKind,
} from '../src/lib/providers-store';

/**
 * BYOK provider settings (M6-3). Add/edit a model provider — Anthropic (native
 * Messages API) or any OpenAI-compatible endpoint. The API key is written to
 * expo-secure-store ONLY (see providers-store.ts); it is never shown back, never
 * stored in the vault, never logged. Editing leaves the key untouched unless a
 * new one is typed.
 */
export default function Providers() {
  const session = useVaultSession();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyed, setKeyed] = useState<Record<string, boolean>>({});

  // form
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kind, setKind] = useState<ProviderKind>('anthropic');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(ANTHROPIC_BASE_URL);
  const [model, setModel] = useState(DEFAULT_ANTHROPIC_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await listProviders();
    const sel = await getSelectedProviderId();
    const flags: Record<string, boolean> = {};
    for (const p of list) flags[p.id] = await hasKey(p.id);
    setProviders(list);
    setSelectedId(sel);
    setKeyed(flags);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;

  function resetForm() {
    setEditingId(null);
    setKind('anthropic');
    setLabel('');
    setBaseUrl(ANTHROPIC_BASE_URL);
    setModel(DEFAULT_ANTHROPIC_MODEL);
    setApiKey('');
    setError(null);
  }

  function onPickKind(next: ProviderKind) {
    setKind(next);
    if (next === 'anthropic') {
      setBaseUrl(ANTHROPIC_BASE_URL);
      if (model.trim().length === 0) setModel(DEFAULT_ANTHROPIC_MODEL);
    } else if (baseUrl === ANTHROPIC_BASE_URL) {
      setBaseUrl('');
    }
  }

  function onEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setKind(p.kind);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setApiKey(''); // blank = keep the stored key
    setError(null);
  }

  async function onSave() {
    setError(null);
    if (label.trim().length === 0) return setError('Give this provider a name.');
    if (model.trim().length === 0) return setError('Enter a model id.');
    if (kind === 'openai' && baseUrl.trim().length === 0) return setError('Enter the endpoint base URL.');
    const isNew = editingId === null;
    if (isNew && apiKey.trim().length === 0) return setError('Enter your API key.');
    setBusy(true);
    try {
      const saved = await saveProvider(
        { id: editingId ?? undefined, label, kind, baseUrl: kind === 'anthropic' ? ANTHROPIC_BASE_URL : baseUrl, model },
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
                      <Text style={styles.cardSub} numberOfLines={1}>
                        {p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'} · {p.model}
                        {keyed[p.id] ? '' : ' · no key'}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable onPress={() => onEdit(p)} hitSlop={8} accessibilityLabel={`Edit ${p.label}`}>
                    <Ionicons name="pencil" size={18} color={colors.muted} style={styles.cardIcon} />
                  </Pressable>
                  <Pressable onPress={() => void onDelete(p.id)} hitSlop={8} accessibilityLabel={`Delete ${p.label}`}>
                    <Ionicons name="trash-outline" size={18} color={colors.danger} style={styles.cardIcon} />
                  </Pressable>
                </View>
              );
            })}
          </>
        ) : null}

        <FieldLabel>{editingId ? 'Edit provider' : 'Add a provider'}</FieldLabel>

        <View style={styles.kindRow}>
          {(['anthropic', 'openai'] as ProviderKind[]).map((k) => {
            const on = kind === k;
            return (
              <Text
                key={k}
                onPress={() => onPickKind(k)}
                style={[styles.kindChip, on ? styles.kindChipOn : styles.kindChipOff]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                {k === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}
              </Text>
            );
          })}
        </View>

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
              onChangeText={setBaseUrl}
              placeholder="https://api.openai.com  (or http://192.168.1.5:11434)"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </>
        ) : null}

        <FieldLabel>Model id</FieldLabel>
        <TextInput
          style={styles.input}
          value={model}
          onChangeText={setModel}
          placeholder={kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : 'gpt-4o'}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <FieldLabel>API key</FieldLabel>
        <TextInput
          style={styles.input}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={editingId ? 'Leave blank to keep the stored key' : 'sk-…'}
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
  cardMain: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
  cardText: { flex: 1 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  cardSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  cardIcon: { marginLeft: 14 },
  kindRow: { flexDirection: 'row', gap: 8 },
  kindChip: {
    fontSize: 13,
    fontWeight: '600',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
  },
  kindChipOn: { color: '#ffffff', borderColor: colors.accent, backgroundColor: colors.accent },
  kindChipOff: { color: colors.muted, borderColor: colors.border, backgroundColor: colors.card },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    fontSize: 15,
  },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  saveBtn: { marginTop: 20 },
  cancelBtn: { marginTop: 10 },
});
