import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, Stack, router, useFocusEffect } from 'expo-router';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, FieldLabel, colors, type } from '../src/ui';
import {
  getSelectedProviderId,
  hasKey,
  listProviders,
  ON_DEVICE_PROVIDER_ID,
  removeProvider,
  setSelectedProviderId,
  type ProviderConfig,
} from '../src/lib/providers-store';
import { getLocalModel } from '../src/lib/local-model';
import {
  ON_DEVICE_PRIVATE_LABEL,
  PROVIDER_TIER_INTRO,
  effectiveTierLabel,
} from '../src/lib/redaction-tier';
import type { LocalModelResolution } from '@northkeep/platform-mobile/dist/local-model/index.js';

/**
 * BYOK provider settings (M6-3 / M6-6). This screen is the calm hub (Wave 3):
 * the on-device option, the saved-provider list (select / edit / delete each),
 * and a single "Add a provider" entry. The add/edit FORM lives on its own
 * focused screen (provider-form.tsx); tapping Add or a row's Edit pushes there.
 * The per-provider effective-tier labels (Wave 2) stay on the list cards. The
 * API key is written to expo-secure-store ONLY, on the form screen; it is never
 * shown back here, never stored in the vault, never logged.
 */

export default function Providers() {
  const session = useVaultSession();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyed, setKeyed] = useState<Record<string, boolean>>({});
  const [localRes, setLocalRes] = useState<LocalModelResolution | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Disclosure only (Wave 2): the SAME condition converse.tsx uses to add the
  // on-device NER pass to a cloud turn. True -> a cloud message is pseudonymized
  // on this phone (Tier 2); false -> only the deterministic Tier-1 floor runs.
  // This changes no send/redaction behavior; it only labels the posture here.
  const tier2Available = localRes?.model != null;

  async function onDelete(id: string) {
    setBusy(true);
    try {
      await removeProvider(id);
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Providers' }} />
      <Text style={styles.tierIntro}>{PROVIDER_TIER_INTRO}</Text>

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
              {available ? <TierLine tone="good" text={ON_DEVICE_PRIVATE_LABEL} /> : null}
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
                    <TierLine
                      tone={tier2Available ? 'good' : 'warn'}
                      text={effectiveTierLabel(tier2Available)}
                    />
                  </View>
                </Pressable>
                <Pressable
                  onPress={() => router.push({ pathname: '/provider-form', params: { id: p.id } })}
                  hitSlop={{ top: 13, bottom: 13, left: 13, right: 13 }}
                  accessibilityLabel={`Edit ${p.label}`}
                >
                  <Ionicons name="pencil" size={18} color={colors.muted} style={styles.cardIcon} />
                </Pressable>
                <Pressable
                  onPress={() => void onDelete(p.id)}
                  disabled={busy}
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

      <FieldLabel>Add a provider</FieldLabel>
      <Button
        title="Add a provider"
        onPress={() => router.push('/provider-form')}
        style={styles.addBtn}
      />
      <Text style={styles.hint}>
        Bring your own key for Claude, an OpenAI-compatible endpoint, or a local Ollama on your
        computer. You choose the model and confirm what protects each message before it leaves this
        phone.
      </Text>
    </ScrollView>
  );
}

/**
 * Effective outbound-redaction tier line (Wave 2, disclosure only). Sits under a
 * provider's identity row and states, calmly, what protects a message before it
 * leaves this phone. 'good' = accent (Tier 2 or on-device private); 'warn' =
 * warnText (Tier 1 only), matching the converse.tsx banner tones so the two
 * surfaces read as one voice. Labels only: no send/redaction behavior changes.
 */
function TierLine({ tone, text }: { tone: 'good' | 'warn'; text: string }) {
  const color = tone === 'good' ? colors.accent : colors.warnText;
  return (
    <View style={styles.tierRow}>
      <Ionicons name={tone === 'good' ? 'lock-closed' : 'alert-circle'} size={12} color={color} />
      <Text style={[styles.tierText, { color }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  tierIntro: { ...type.footnote, color: colors.muted, marginBottom: 16, lineHeight: 19 },
  tierRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 5 },
  tierText: { ...type.caption, fontWeight: '600', flex: 1, lineHeight: 16 },
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
  hint: { ...type.footnote, color: colors.muted, marginTop: 8 },
  addBtn: { marginTop: 4 },
});
