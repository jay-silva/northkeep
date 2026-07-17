import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { Redirect, router, useFocusEffect } from 'expo-router';
import type { LocalModelResolution } from '@northkeep/platform-mobile/dist/local-model/index.js';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, colors } from '../src/ui';
import {
  getSelectedProviderId,
  getProviderKey,
  listProviders,
  ON_DEVICE_PROVIDER_ID,
  type ProviderConfig,
} from '../src/lib/providers-store';
import { getLocalModel } from '../src/lib/local-model';
import {
  createSession,
  runMobileTurn,
  runOnDeviceTurn,
  TurnError,
  type ConverseSession,
} from '../src/lib/converse-run';

/**
 * Converse (M6-3 + M6-4): chat over the REAL runTurn pipeline
 * (packages/converse/src/turn.ts) with vault memory context.
 *
 * Three privacy postures, shown loudly (invariant #6):
 *  - On-device (private): the whole turn runs on the phone (runOnDeviceTurn),
 *    no key, nothing sent off the device.
 *  - Cloud + Tier-2 on-device: a local model pseudonymizes names/orgs/places on
 *    the phone BEFORE the redacted prompt is sent to the chosen provider.
 *  - Cloud + Tier-1 only: no on-device model, so only deterministic secrets are
 *    masked; names are not pseudonymized here (the loud degradation state).
 */

type UIMessage = { role: 'user' | 'assistant'; content: string };
type Mode = 'on-device' | 'cloud' | 'none';

export default function Converse() {
  const session = useVaultSession();
  const [cloudProvider, setCloudProvider] = useState<ProviderConfig | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState<LocalModelResolution | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAudit, setHasAudit] = useState(false);

  const convSession = useRef<ConverseSession>(createSession());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  // On focus: re-read the selected provider AND detect the on-device model
  // (Apple-first; memoized). The llama fallback is never auto-detected here, so
  // no model file can be downloaded implicitly (invariant #7).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const [id, all, res] = await Promise.all([
          getSelectedProviderId(),
          listProviders(),
          getLocalModel(),
        ]);
        if (!alive) return;
        setSelectedId(id);
        setResolution(res);
        const onDevice = id === ON_DEVICE_PROVIDER_ID && res.model !== null;
        setCloudProvider(onDevice ? null : (all.find((p) => p.id === id) ?? all[0] ?? null));
        setLoaded(true);
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;

  const localReady = resolution?.model != null;
  const mode: Mode =
    selectedId === ON_DEVICE_PROVIDER_ID && localReady
      ? 'on-device'
      : cloudProvider
        ? 'cloud'
        : 'none';

  async function onSend() {
    const text = input.trim();
    if (text.length === 0 || busy || mode === 'none') return;
    setError(null);
    setInput('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

    const onToken = (token: string) => {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + token };
        return next;
      });
    };

    try {
      let reply: string;
      if (mode === 'on-device') {
        const localModel = resolution!.model!;
        const result = await runOnDeviceTurn({
          message: text,
          session: convSession.current,
          localModel,
          retrieve: (q, o) => session.retrieve(q, o),
          signal: controller.signal,
          onToken,
        });
        reply = result.reply;
      } else {
        const provider = cloudProvider!;
        // Read the key immediately before the call; never hold it in React state.
        const apiKey = await getProviderKey(provider.id);
        if (apiKey === null) {
          setError('No API key stored for this provider. Open Providers and re-enter it.');
          setMessages((prev) => prev.slice(0, -2));
          setBusy(false);
          return;
        }
        const result = await runMobileTurn({
          message: text,
          session: convSession.current,
          provider,
          apiKey,
          // Enables Tier-2 pseudonymization on-device when a model is ready.
          localModel: localReady ? resolution!.model : null,
          retrieve: (q, o) => session.retrieve(q, o),
          signal: controller.signal,
          onToken,
        });
        reply = result.reply;
      }
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: reply };
        return next;
      });
      setHasAudit(true);
    } catch (err) {
      const msg =
        err instanceof TurnError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The turn failed.';
      setError(msg);
      setMessages((prev) => (prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev));
    } finally {
      setBusy(false);
      abortRef.current = null;
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  }

  const headerLabel =
    mode === 'on-device'
      ? `On-device (private) · ${resolution?.model?.label ?? 'local model'}`
      : mode === 'cloud'
        ? `${cloudProvider!.label} · ${cloudProvider!.model}`
        : loaded
          ? 'No provider set'
          : ' ';

  const banner = statusBanner(mode, localReady);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {banner ? <StatusBanner tone={banner.tone} message={banner.message} /> : null}

      <View style={styles.headerRow}>
        <Text style={styles.providerLabel} numberOfLines={1}>
          {headerLabel}
        </Text>
        <Pressable style={styles.headerBtn} onPress={() => router.push('/providers')} accessibilityRole="button">
          <Ionicons name="swap-horizontal-outline" size={16} color={colors.accent} />
          <Text style={styles.headerBtnText}>Providers</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Talk to your vault</Text>
            <Text style={styles.emptyBody}>
              {mode === 'none'
                ? 'Choose the on-device model (fully private) or add a cloud provider with your own API key to begin.'
                : mode === 'on-device'
                  ? 'This chat runs entirely on your phone. Relevant memories are added as context and nothing is sent off the device.'
                  : 'Ask anything. Relevant memories are added as context, and everything sent out is masked by the on-device firewall first.'}
            </Text>
            {mode === 'none' ? (
              <Button title="Choose a provider" onPress={() => router.push('/providers')} style={styles.emptyBtn} />
            ) : null}
          </View>
        ) : (
          messages.map((m, i) => (
            <View
              key={i}
              style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.assistantBubble]}
            >
              <Text style={m.role === 'user' ? styles.userText : styles.assistantText}>
                {m.content.length === 0 ? '…' : m.content}
              </Text>
            </View>
          ))
        )}
      </ScrollView>

      <ErrorNote message={error} />

      {hasAudit ? (
        <Pressable
          style={styles.auditLink}
          onPress={() => router.push('/converse-audit')}
          accessibilityRole="button"
        >
          <Ionicons name="shield-checkmark-outline" size={15} color={colors.accent} />
          <Text style={styles.auditLinkText}>What left this device</Text>
        </Pressable>
      ) : null}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={mode === 'none' ? 'Choose a provider first' : 'Message'}
          placeholderTextColor={colors.muted}
          editable={mode !== 'none' && !busy}
          multiline
        />
        {busy ? (
          <Button title="Stop" kind="secondary" onPress={() => abortRef.current?.abort()} style={styles.sendBtn} />
        ) : (
          <Button
            title="Send"
            onPress={() => void onSend()}
            disabled={mode === 'none' || input.trim().length === 0}
            style={styles.sendBtn}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** The invariant-#6 posture line, or null when there is nothing to show. */
function statusBanner(mode: Mode, localReady: boolean): { tone: 'good' | 'warn'; message: string } | null {
  if (mode === 'on-device') {
    return {
      tone: 'good',
      message: 'Private chat. This runs entirely on your phone and nothing is sent off the device.',
    };
  }
  if (mode === 'cloud') {
    return localReady
      ? {
          tone: 'good',
          message:
            'Tier-2 on-device. Names, orgs, and places are pseudonymized on your phone before anything is sent.',
        }
      : {
          tone: 'warn',
          message:
            'Tier-1 only. Secrets are masked before sending, but names and places are not pseudonymized because no on-device model is available.',
        };
  }
  return null;
}

function StatusBanner({ tone, message }: { tone: 'good' | 'warn'; message: string }) {
  return (
    <View style={tone === 'good' ? styles.bannerGood : styles.bannerWarn}>
      <Ionicons
        name={tone === 'good' ? 'lock-closed' : 'alert-circle'}
        size={15}
        color={tone === 'good' ? colors.accent : colors.warnText}
      />
      <Text style={tone === 'good' ? styles.bannerGoodText : styles.bannerWarnText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  bannerGood: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#1c2b23',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bannerGoodText: { color: colors.accent, fontSize: 13, fontWeight: '600', flex: 1, lineHeight: 18 },
  bannerWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: colors.warnBg,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bannerWarnText: { color: colors.warnText, fontSize: 13, fontWeight: '600', flex: 1, lineHeight: 18 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  providerLabel: { color: colors.muted, fontSize: 13, flex: 1, marginRight: 12 },
  headerBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerBtnText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 10 },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 20 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  emptyBtn: { marginTop: 20, alignSelf: 'stretch' },
  bubble: { maxWidth: '86%', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.accentStrong },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  userText: { color: '#ffffff', fontSize: 15, lineHeight: 21 },
  assistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  auditLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  auditLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: { paddingVertical: 10, paddingHorizontal: 16 },
});
