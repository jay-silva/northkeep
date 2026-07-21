import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import {
  DEFAULT_CONNECTOR_SERVER_URL,
  scopeRows,
} from '../../src/lib/connect-flow';
import {
  loadConnectorServerUrl,
  loadConnectorSharedScopes,
} from '../../src/lib/secure-store';
import { useVaultSession } from '../../src/lib/vault-session';
import { Button, FieldLabel, colors, type } from '../../src/ui';

/**
 * Cloud Connect HUB (Wave 3 density polish). The old single screen stacked five
 * jobs on one scroll (connection details, share id, scope toggles + the loud
 * plaintext confirm, pairing, and sync). This hub keeps the orienting intro and
 * the Sharing-vs-Sync banner, shows the current state at a glance (what is
 * shared, which connector), and routes to three focused sub-screens:
 *   - Manage sharing (/sharing/scopes): the per-scope toggles, the LOUD
 *     plaintext confirmation, and Sync app-written memories. Those three share
 *     ONE busy-lock (invariant #1: an unshare must not race a mid-flight sync
 *     and re-upload revoked plaintext), so they stay together on one screen.
 *   - Pair an AI app (/sharing/pair): the one-time code, countdown, connector
 *     URL, and phishing warning -- the worst working-memory offender, given a
 *     calm screen of its own.
 *   - Connection details (/sharing/connection): connector server, custom-server
 *     Advanced, and the share id.
 *
 * All state transitions still live in the pure, tested src/lib/connect-flow.ts;
 * these screens render outcomes. Reached from Settings -> Cloud Connect.
 */
export default function SharingHub() {
  const session = useVaultSession();
  const [savedServer, setSavedServer] = useState<string | null>(null);
  const [sharedScopes, setSharedScopes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Refresh on focus so returning from Manage sharing shows the fresh state.
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        setSavedServer(await loadConnectorServerUrl());
        setSharedScopes(await loadConnectorSharedScopes());
        setLoaded(true);
      })();
    }, []),
  );

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  const effectiveServer = savedServer ?? DEFAULT_CONNECTOR_SERVER_URL;
  const rows = scopeRows(session.entries, sharedScopes);
  const shared = rows.filter((r) => r.shared);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.body}>
        Cloud Connect makes chosen memories usable inside the AI apps you already use (Claude,
        ChatGPT, Manus) by copying them to NorthKeep's connector server. Everything is private by
        default. You share one scope at a time, on purpose, and you can unshare anytime.
      </Text>
      <View style={styles.banner}>
        <Text style={styles.bannerStrong}>
          Sharing is different from Sync. The connector server can read what you share.
        </Text>
        <Text style={styles.bannerBody}>
          Sync stores your vault as encrypted data the server can never read. Sharing copies a
          scope's memories in plain, readable form so your AI apps can reach them. Only scopes you
          turn on here ever leave this phone.
        </Text>
      </View>

      <FieldLabel>What is shared now</FieldLabel>
      {!loaded ? (
        <Text style={styles.footnote}>Loading...</Text>
      ) : shared.length === 0 ? (
        <Text style={styles.footnote}>
          Nothing is shared. Every scope stays on this phone until you turn it on.
        </Text>
      ) : (
        <View style={styles.summaryCard}>
          {shared.map((r) => (
            <View key={r.scope} style={styles.summaryRow}>
              <Text style={styles.summaryScope}>{r.scope}</Text>
              <Text style={styles.summaryCount}>
                {r.count} {r.count === 1 ? 'memory' : 'memories'}  ·  SHARED
              </Text>
            </View>
          ))}
        </View>
      )}

      <FieldLabel>Do</FieldLabel>
      <Button
        title="Manage sharing"
        onPress={() => router.push('/sharing/scopes')}
        style={styles.stackedButton}
      />
      <Text style={styles.footnote}>
        Turn scopes on or off, confirm what leaves this phone, and pull app-written memories back.
      </Text>
      <Button
        title="Pair an AI app"
        kind="secondary"
        onPress={() => router.push('/sharing/pair')}
        style={styles.stackedButton}
      />
      <Text style={styles.footnote}>
        Generate a one-time code and add NorthKeep as a connector in Claude, ChatGPT, or Manus.
      </Text>
      <Button
        title="Connection details"
        kind="secondary"
        onPress={() => router.push('/sharing/connection')}
        style={styles.stackedButton}
      />
      <Text style={styles.footnote}>
        Your connector server, your share id, and the option to use a custom server.
      </Text>

      <FieldLabel>Connector</FieldLabel>
      <Info label="Server" value={effectiveServer} />
    </ScrollView>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  body: { ...type.subhead, color: colors.muted, marginBottom: 8 },
  banner: {
    backgroundColor: colors.warnBg,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  bannerStrong: { ...type.footnote, color: colors.warnText, fontWeight: '700' },
  bannerBody: { ...type.footnote, color: colors.warnText, marginTop: 6 },
  footnote: { ...type.footnote, color: colors.muted, marginBottom: 8 },
  summaryCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  summaryRow: { paddingVertical: 4 },
  summaryScope: { ...type.body, color: colors.text, fontWeight: '600' },
  summaryCount: { ...type.caption, color: colors.muted, fontWeight: '400', marginTop: 2 },
  stackedButton: { marginTop: 12 },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { ...type.subhead, color: colors.muted },
  infoValue: { ...type.footnote, color: colors.text, flexShrink: 1, textAlign: 'right' },
});
