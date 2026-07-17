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
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, WarningBanner, colors } from '../src/ui';
import {
  getSelectedProviderId,
  getProviderKey,
  listProviders,
  type ProviderConfig,
} from '../src/lib/providers-store';
import { createSession, runMobileTurn, TurnError, type ConverseSession } from '../src/lib/converse-run';

/**
 * Converse (M6-3): BYOK chat over the REAL runTurn pipeline
 * (packages/converse/src/turn.ts), with vault memory context and the on-device
 * Tier-1 redaction firewall on everything outbound. Tier-2 (Ollama NER) does
 * not exist on the phone, so a persistent loud banner says only Tier-1 protects
 * outbound text (invariant #6, degrade loudly). "What left this device" shows
 * the actual redacted payload after a turn.
 */

type UIMessage = { role: 'user' | 'assistant'; content: string };

const TIER1_ONLY_BANNER =
  'On-device firewall: Tier-1 only. Names/orgs are NOT pseudonymized on your phone (that needs the local model on your Mac). Secrets (emails, cards, SSNs, keys, phones, IPs) are masked before anything is sent.';

export default function Converse() {
  const session = useVaultSession();
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAudit, setHasAudit] = useState(false);

  // The pipeline session persists real-name plaintext history across turns; it
  // is re-redacted every turn before sending (see turn.ts ConverseSession).
  const convSession = useRef<ConverseSession>(createSession());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  // Re-read the selected provider whenever the screen regains focus (the user
  // may have just added one on the Providers screen).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const id = await getSelectedProviderId();
        const all = await listProviders();
        if (!alive) return;
        setProvider(all.find((p) => p.id === id) ?? all[0] ?? null);
        setProviderLoaded(true);
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

  async function onSend() {
    const text = input.trim();
    if (text.length === 0 || busy || !provider) return;
    setError(null);
    setInput('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

    // Read the key immediately before the call; never hold it in React state.
    const apiKey = await getProviderKey(provider.id);
    if (apiKey === null) {
      setError('No API key stored for this provider. Open Providers and re-enter it.');
      setMessages((prev) => prev.slice(0, -2));
      setBusy(false);
      return;
    }

    try {
      const result = await runMobileTurn({
        message: text,
        session: convSession.current,
        provider,
        apiKey,
        retrieve: (q, o) => session.retrieve(q, o),
        signal: controller.signal,
        onToken: (token) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + token };
            return next;
          });
        },
      });
      // Authoritative restored reply (identical to the streamed Tier-1 text).
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: result.reply };
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
      // Drop the empty assistant bubble; keep the user's message visible.
      setMessages((prev) => (prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev));
    } finally {
      setBusy(false);
      abortRef.current = null;
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  }

  const noProvider = providerLoaded && provider === null;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <WarningBanner message={TIER1_ONLY_BANNER} />

      <View style={styles.headerRow}>
        <Text style={styles.providerLabel} numberOfLines={1}>
          {provider ? `${provider.label} · ${provider.model}` : noProvider ? 'No provider set' : ' '}
        </Text>
        <Pressable style={styles.headerBtn} onPress={() => router.push('/providers')} accessibilityRole="button">
          <Ionicons name="key-outline" size={16} color={colors.accent} />
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
              {noProvider
                ? 'Add a model provider with your own API key to begin. Your key stays on this device.'
                : 'Ask anything. Relevant memories are added as context, and everything sent out is masked by the Tier-1 firewall first.'}
            </Text>
            {noProvider ? (
              <Button title="Add a provider" onPress={() => router.push('/providers')} style={styles.emptyBtn} />
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
          placeholder={provider ? 'Message' : 'Add a provider first'}
          placeholderTextColor={colors.muted}
          editable={!!provider && !busy}
          multiline
        />
        {busy ? (
          <Button title="Stop" kind="secondary" onPress={() => abortRef.current?.abort()} style={styles.sendBtn} />
        ) : (
          <Button
            title="Send"
            onPress={() => void onSend()}
            disabled={!provider || input.trim().length === 0}
            style={styles.sendBtn}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
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
