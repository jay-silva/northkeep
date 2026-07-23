import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
// expo-clipboard (build 18): the deprecated RN core Clipboard is gone from the
// app. No timed clear here: pairing codes expire on their own TTL, and the
// connector URL is not a secret (backup-secret.tsx is the one screen that
// timed-clears).
import * as Clipboard from 'expo-clipboard';
import { Redirect } from 'expo-router';
import {
  DEFAULT_CONNECTOR_SERVER_URL,
  PAIRING_CODE_TTL_SECONDS,
  classifyConnectorError,
  formatPairingCountdown,
  mcpUrlFor,
  type ConnectorFailure,
} from '../../src/lib/connect-flow';
import { loadConnectorServerUrl } from '../../src/lib/secure-store';
import { useVaultSession } from '../../src/lib/vault-session';
import { Button, ErrorNote, colors, type } from '../../src/ui';

/**
 * Pair an AI app (Wave 3): the one-time pairing code, its countdown, the
 * connector URL, and the phishing warning -- the worst working-memory offender
 * on the old single Cloud Connect screen, now given a calm screen of its own.
 *
 * Pairing is deliberately OUTSIDE the share/unshare/sync busy-lock: it pushes no
 * plaintext, so its own local `pairBusy` is faithful to the original. Pairing
 * logic (session.connectorStartPairing) and the code TTL are unchanged.
 *
 * Entry: /sharing/pair.
 */
export default function PairApp() {
  const session = useVaultSession();

  const [savedServer, setSavedServer] = useState<string | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<ConnectorFailure | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copiedWhat, setCopiedWhat] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setSavedServer(await loadConnectorServerUrl());
    })();
  }, []);

  // 1-second tick for the pairing-code countdown while a code is showing.
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pair]);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  const effectiveServer = savedServer ?? DEFAULT_CONNECTOR_SERVER_URL;
  const mcpUrl = mcpUrlFor(effectiveServer);
  const pairSecondsLeft = pair ? Math.round((pair.expiresAt - nowMs) / 1000) : 0;
  const pairExpired = pair !== null && pairSecondsLeft <= 0;

  function copy(label: string, value: string) {
    void Clipboard.setStringAsync(value);
    setCopiedWhat(label);
  }

  function onPair() {
    setPairBusy(true);
    setPairError(null);
    void (async () => {
      try {
        const code = await session.connectorStartPairing();
        setNowMs(Date.now());
        setPair({ code, expiresAt: Date.now() + PAIRING_CODE_TTL_SECONDS * 1000 });
      } catch (err) {
        setPairError(classifyConnectorError(err));
      } finally {
        setPairBusy(false);
      }
    })();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.footnote}>
        Generate a one-time code, then add NorthKeep as a connector in Claude, ChatGPT, or Manus.
        You only do this once per app.
      </Text>
      <Button
        title={pair ? 'New code' : 'Pair an AI app'}
        kind={pair ? 'secondary' : 'primary'}
        onPress={onPair}
        busy={pairBusy}
        style={styles.stackedButton}
      />
      {pairError ? <ErrorNote message={pairError.message} /> : null}
      {pair ? (
        <View style={styles.pairCard}>
          <Text style={styles.pairLabel}>Pairing code</Text>
          <Text style={styles.pairCode} selectable>
            {pair.code}
          </Text>
          <Text style={styles.pairCountdown}>
            {pairExpired
              ? 'This code expired. Generate a new one.'
              : `Expires in ${formatPairingCountdown(pairSecondsLeft)}`}
          </Text>
          <Pressable
            onPress={() => copy('code', pair.code)}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.copyLink}>{copiedWhat === 'code' ? 'Copied.' : 'Copy code'}</Text>
          </Pressable>
          <Text style={styles.pairLabel}>Connector URL</Text>
          <Text style={styles.monoText} selectable>
            {mcpUrl}
          </Text>
          <Pressable
            onPress={() => copy('mcp2', mcpUrl)}
            accessibilityRole="button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.copyLink}>{copiedWhat === 'mcp2' ? 'Copied.' : 'Copy connector URL'}</Text>
          </Pressable>
          <Text style={styles.confirmBody}>
            In your AI app, add a custom connector (an MCP server) with this URL. When the app
            opens NorthKeep's consent page, enter this code and approve.
          </Text>
          <Text style={styles.pairWarning}>
            Treat this pairing code like a key. Enter it only on the consent page your AI app
            opens. NorthKeep will never ask you for it.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  footnote: { ...type.footnote, color: colors.muted, marginBottom: 8 },
  copyLink: { ...type.subhead, color: colors.accent, fontWeight: '600', paddingVertical: 12 },
  monoText: { color: colors.text, fontSize: 13, lineHeight: 20, fontFamily: mono },
  confirmBody: { ...type.subhead, color: colors.text, marginBottom: 8 },
  stackedButton: { marginTop: 12 },
  pairCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
  },
  pairLabel: {
    ...type.caption,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 4,
  },
  // Bespoke display numeral: the one-time pairing code. Left off the prose scale
  // on purpose (large monospace); stays selectable and non-truncating.
  pairCode: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: mono,
  },
  pairCountdown: { ...type.footnote, color: colors.warnText, fontWeight: '600', marginTop: 4 },
  pairWarning: { ...type.footnote, color: colors.warnText, fontWeight: '600' },
});
