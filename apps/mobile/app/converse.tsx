import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Keyboard,
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
import { pickAttachment, type PickedAttachment } from '../src/lib/attach-file';

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

/**
 * Animated "Thinking…" indicator shown in the assistant bubble until the first
 * token arrives. Without it the empty bubble reads as frozen — the on-device
 * model can spend 30s+ loading into RAM before it streams anything.
 */
function ThinkingDots() {
  const d0 = useRef(new Animated.Value(0.3)).current;
  const d1 = useRef(new Animated.Value(0.3)).current;
  const d2 = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const dots = [d0, d1, d2];
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(d, { toValue: 1, duration: 340, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0.3, duration: 340, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [d0, d1, d2]);
  return (
    <View style={styles.thinkingRow} accessibilityLabel="Thinking">
      <Animated.View style={[styles.thinkingDot, { opacity: d0 }]} />
      <Animated.View style={[styles.thinkingDot, { opacity: d1 }]} />
      <Animated.View style={[styles.thinkingDot, { opacity: d2 }]} />
      <Text style={styles.thinkingLabel}>Thinking…</Text>
    </View>
  );
}

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
  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [hasAudit, setHasAudit] = useState(false);
  // Set when an on-device Tier-2 turn aborted (invariant #6: nothing was sent).
  // Holds the message so the user can explicitly resend at Tier-1 if they choose.
  const [tier1RetryText, setTier1RetryText] = useState<string | null>(null);

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

  async function onAttach() {
    if (busy || mode === 'none') return;
    setError(null);
    const r = await pickAttachment();
    setKbPad(0); // the picker's keyboard events can leave stale padding behind
    if (r.ok) {
      setAttachment(r.attachment);
      return;
    }
    if (r.reason === 'canceled') return;
    if (r.reason === 'unsupported') {
      setError(`Can't read .${r.ext} on the phone yet. Supported: .pdf, .txt, .md, .csv, .json, .log.`);
      return;
    }
    if (r.reason === 'protected') {
      setError('That PDF is password-protected. Remove the password and try again.');
      return;
    }
    if (r.reason === 'no-text') {
      setError('No readable text found in that PDF, even after scanning it for printed text.');
      return;
    }
    setError(r.detail ? `Could not read that file. (${r.detail})` : 'Could not read that file.');
  }

  function onSend() {
    const text = input.trim();
    if ((text.length === 0 && !attachment) || busy || mode === 'none') return;
    setInput('');
    void send(text, false);
  }

  /**
   * One turn. `forceTier1` sends to a cloud provider with the on-device model
   * withheld (the deterministic shield still runs — it is the always-on floor).
   * Used only for the explicit resend after an on-device NER abort.
   */
  async function send(text: string, forceTier1: boolean) {
    setError(null);
    setTier1RetryText(null);
    const att = attachment;
    setAttachment(null);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Compose the outbound message: attached file text is prepended so the
    // on-device Tier-1 firewall redacts it together with the typed note, under
    // the ~32k message cap. The bubble shows the note + your text; the full file
    // dump goes only into the redacted payload ("What left this device").
    let outbound = text;
    let attachNote = '';
    if (att) {
      const CAP = 31000;
      const head = `[Attached file: ${att.name}]\n`;
      const tail = text ? `\n\n${text}` : '';
      let fileText = att.text;
      let trimmed = att.truncatedFrom != null;
      const room = CAP - head.length - tail.length;
      if (fileText.length > room) {
        fileText = fileText.slice(0, Math.max(0, room));
        trimmed = true;
      }
      if (trimmed) fileText += '\n…[truncated]';
      outbound = head + fileText + tail;
      attachNote = `📎 ${att.name}${trimmed ? ' (trimmed to fit)' : ''}`;
    }
    const shownUser = [attachNote, text].filter(Boolean).join('\n') || '(attached file)';

    setMessages((prev) => [...prev, { role: 'user', content: shownUser }, { role: 'assistant', content: '' }]);
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
          message: outbound,
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
        // Local OpenAI-compatible endpoints (e.g. Ollama) need no key, so only
        // Anthropic hard-requires one; others send with no auth header.
        const storedKey = await getProviderKey(provider.id);
        if (storedKey === null && provider.kind === 'anthropic') {
          setError('No API key stored for this provider. Open Providers and re-enter it.');
          setMessages((prev) => prev.slice(0, -2));
          setInput(text); // restore the draft + attachment so nothing is silently lost
          setAttachment(att);
          setBusy(false);
          return;
        }
        const result = await runMobileTurn({
          message: outbound,
          session: convSession.current,
          provider,
          apiKey: storedKey ?? '',
          // Adds the on-device NER net when a model is ready (withheld on an
          // explicit retry); the deterministic shield always runs regardless.
          localModel: !forceTier1 && localReady ? resolution!.model : null,
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
      if (err instanceof TurnError && err.code === 'TIER2_UNAVAILABLE') {
        // On-device pseudonymization failed; runTurn aborted BEFORE sending
        // (invariant #6, nothing left the device). Roll the turn fully back and
        // offer an explicit Tier-1 resend, in phone-true language (no Ollama here).
        setError(
          'Names could not be pseudonymized on-device this turn, so nothing was sent. You can resend with Tier-1 protection (secrets are still masked, but names and places are not).',
        );
        setTier1RetryText(text);
        setMessages((prev) => prev.slice(0, -2));
      } else {
        const msg = err instanceof Error ? err.message : 'The turn failed.';
        setError(msg);
        setMessages((prev) => (prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev));
      }
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

  // Keyboard handling, measured instead of guessed. KeyboardAvoidingView with a
  // hardcoded keyboardVerticalOffset was wrong on device (the offset must equal
  // the BottomNav's height, which varies with safe-area insets), leaving the
  // composer partially under the keyboard. Instead: on every keyboard frame
  // change, measure THIS screen's bottom edge in window coordinates and pad by
  // the exact overlap. Android's adjustResize already resizes the window, so
  // this is iOS-only.
  //
  // HARDENED after build 15: the document picker's own keyboard (Files search
  // bar) fired frame events while the picker's window was frontmost, the
  // measurement returned coordinates from the wrong window, and the stale
  // padding stuck after the picker dismissed — crushing the whole screen. Now:
  // a hide-frame (keyboard off-screen) always hard-resets WITHOUT measuring,
  // keyboardDidHide resets as a belt-and-suspenders, the pad is clamped to
  // half the window, and the attach flow resets after every picker round-trip.
  const rootRef = useRef<View | null>(null);
  const [kbPad, setKbPad] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const onFrame = (e: { endCoordinates: { screenY: number; height: number } }) => {
      const windowH = Dimensions.get('window').height;
      if (e.endCoordinates.screenY >= windowH - 1 || e.endCoordinates.height <= 0) {
        setKbPad(0);
        return;
      }
      rootRef.current?.measureInWindow((_x, y, _w, h) => {
        const overlap = Math.max(0, Math.min(y + h - e.endCoordinates.screenY, windowH * 0.5));
        setKbPad(overlap);
        requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      });
    };
    const s1 = Keyboard.addListener('keyboardWillChangeFrame', onFrame);
    const s2 = Keyboard.addListener('keyboardDidHide', () => setKbPad(0));
    return () => {
      s1.remove();
      s2.remove();
    };
  }, []);

  return (
    <View ref={rootRef} style={[styles.screen, kbPad > 0 ? { paddingBottom: kbPad } : null]}>
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
            <Text style={styles.emptyTitle}>
              {mode === 'cloud'
                ? `Chat with ${cloudProvider!.label}, backed by your vault`
                : mode === 'on-device'
                  ? 'Private chat on this phone'
                  : 'Talk to your vault'}
            </Text>
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
              {m.role === 'assistant' && m.content.length === 0 ? (
                <ThinkingDots />
              ) : (
                <Text style={m.role === 'user' ? styles.userText : styles.assistantText}>
                  {m.content}
                </Text>
              )}
            </View>
          ))
        )}
      </ScrollView>

      <ErrorNote message={error} />

      {tier1RetryText && !busy ? (
        <Pressable
          style={styles.retryLink}
          onPress={() => {
            const t = tier1RetryText;
            setTier1RetryText(null);
            void send(t, true);
          }}
          accessibilityRole="button"
        >
          <Ionicons name="send-outline" size={14} color={colors.warnText} />
          <Text style={styles.retryText}>Resend with Tier-1 only</Text>
        </Pressable>
      ) : null}

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

      {attachment ? (
        <View style={styles.attachChip}>
          <Ionicons name="document-text-outline" size={15} color={colors.accent} />
          <Text style={styles.attachChipText} numberOfLines={1}>
            {attachment.name}
          </Text>
          <Pressable onPress={() => setAttachment(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove attachment">
            <Ionicons name="close" size={16} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.inputRow}>
        <Pressable
          onPress={() => void onAttach()}
          disabled={mode === 'none' || busy}
          hitSlop={8}
          style={styles.attachBtn}
          accessibilityRole="button"
          accessibilityLabel="Attach a file"
        >
          <Ionicons name="attach" size={22} color={mode !== 'none' && !busy ? colors.accent : colors.muted} />
        </Pressable>
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
            onPress={onSend}
            disabled={mode === 'none' || (input.trim().length === 0 && !attachment)}
            style={styles.sendBtn}
          />
        )}
      </View>
    </View>
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
            'On-device shield. Secrets, dates, addresses, and known names are always masked deterministically, and the phone model adds a pseudonymization pass for other names, orgs, and places, before anything is sent. "What left this device" shows the proof for any turn.',
        }
      : {
          tone: 'warn',
          message:
            'Deterministic firewall only. Secrets, every full date, addresses, and dictionary-listed names are masked before sending, but no AI model runs on this phone, so rare or unusual names can slip through. Check "What left this device" after any sensitive message.',
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
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2 },
  thinkingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  thinkingLabel: { color: colors.muted, fontSize: 14, marginLeft: 4 },
  attachBtn: { padding: 6, alignSelf: 'flex-end', marginBottom: 4 },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginHorizontal: 16,
    marginBottom: 6,
    maxWidth: '90%',
  },
  attachChipText: { color: colors.text, fontSize: 13, flexShrink: 1 },
  userText: { color: '#ffffff', fontSize: 15, lineHeight: 21 },
  assistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  auditLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  auditLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  retryLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  retryText: { color: colors.warnText, fontSize: 14, fontWeight: '700' },
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
