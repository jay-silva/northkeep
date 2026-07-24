import React, { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Redirect } from 'expo-router';
import { memzero } from '@northkeep/core';
import { assertConnectorUrl, deriveConnectorToken } from '@northkeep/sync';
import {
  DEFAULT_CONNECTOR_SERVER_URL,
  mcpUrlFor,
  shareIdFromConnectorToken,
} from '../../src/lib/connect-flow';
import {
  loadConnectorServerUrl,
  loadDeviceSecretHex,
  saveConnectorServerUrl,
} from '../../src/lib/secure-store';
import { useVaultSession } from '../../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../../src/ui';

/**
 * Connection details (Wave 3): the connector server, the connector URL for your
 * AI apps, the custom-server "Advanced" option, and your share id. These were at
 * the TOP of the old single Cloud Connect scroll, ahead of the decisions that
 * matter; tucking them onto their own screen calms the hub. The https-or-loopback
 * rule (assertConnectorUrl) and the share-id derivation are unchanged.
 *
 * Entry: /sharing/connection.
 */
export default function ConnectionDetails() {
  const session = useVaultSession();

  const [savedServer, setSavedServer] = useState<string | null>(null);
  const [serverInput, setServerInput] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverNotice, setServerNotice] = useState<string | null>(null);

  const [shareId, setShareId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copiedWhat, setCopiedWhat] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const server = await loadConnectorServerUrl();
      setSavedServer(server);
      setServerInput(server ?? DEFAULT_CONNECTOR_SERVER_URL);
      setShareId(await computeShareId());
      setLoaded(true);
    })();
  }, []);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  const effectiveServer = savedServer ?? DEFAULT_CONNECTOR_SERVER_URL;
  const mcpUrl = mcpUrlFor(effectiveServer);

  function copy(label: string, value: string) {
    void Clipboard.setStringAsync(value);
    setCopiedWhat(label);
  }

  function onSaveServer() {
    setServerError(null);
    setServerNotice(null);
    void (async () => {
      try {
        // Same https-or-loopback rule as desktop (@northkeep/sync).
        const normalized = assertConnectorUrl(serverInput.trim()).toString().replace(/\/$/, '');
        await saveConnectorServerUrl(normalized);
        setSavedServer(normalized);
        setServerInput(normalized);
        setServerNotice('Connector server saved.');
      } catch (err) {
        setServerError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <FieldLabel>Connector server</FieldLabel>
      <Info label="Server" value={effectiveServer} />
      <Info label="Connector URL for your AI apps" value={mcpUrl} />
      <Pressable
        onPress={() => copy('mcp', mcpUrl)}
        accessibilityRole="button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.copyLink}>{copiedWhat === 'mcp' ? 'Copied.' : 'Copy connector URL'}</Text>
      </Pressable>
      <Pressable
        onPress={() => setAdvancedOpen((v) => !v)}
        accessibilityRole="button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.copyLink}>{advancedOpen ? 'Hide advanced' : 'Advanced: use a custom server'}</Text>
      </Pressable>
      {advancedOpen ? (
        <>
          <TextInput
            style={styles.input}
            value={serverInput}
            onChangeText={setServerInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEFAULT_CONNECTOR_SERVER_URL}
            placeholderTextColor={colors.muted}
          />
          <Button
            title="Save connector server"
            kind="secondary"
            onPress={onSaveServer}
            disabled={serverInput.trim().length === 0}
          />
          <ErrorNote message={serverError} />
          {serverNotice ? <Text style={styles.notice}>{serverNotice}</Text> : null}
        </>
      ) : null}

      <FieldLabel>Your share id</FieldLabel>
      <View style={styles.monoCard}>
        <Text style={styles.monoText} selectable>
          {shareId ?? (loaded ? 'Unavailable (no device secret on this phone yet).' : 'Loading...')}
        </Text>
      </View>
      {shareId ? (
        <Pressable
          onPress={() => copy('shareid', shareId)}
          accessibilityRole="button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.copyLink}>{copiedWhat === 'shareid' ? 'Copied.' : 'Copy share id'}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.footnote}>
        Send this to support to join the beta. It identifies your sharing account only; it reveals
        nothing about your vault and cannot decrypt anything.
      </Text>
    </ScrollView>
  );
}

/**
 * The beta "share id": tokenHash(deriveConnectorToken(deviceSecret)), the same
 * value `northkeep share id` prints on desktop and the connector allowlist
 * stores. Derivation goes through the platform seam (BLAKE2b) + noble sha256;
 * the secret buffer is zeroed immediately after.
 */
async function computeShareId(): Promise<string | null> {
  try {
    const hex = await loadDeviceSecretHex();
    if (!hex) return null;
    const secret = Buffer.from(hex, 'hex');
    try {
      return shareIdFromConnectorToken(deriveConnectorToken(secret));
    } finally {
      memzero(secret);
    }
  } catch {
    return null;
  }
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

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    ...type.body,
    marginBottom: 12,
  },
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
  copyLink: { ...type.subhead, color: colors.accent, fontWeight: '600', paddingVertical: 12 },
  monoCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  monoText: { color: colors.text, fontSize: 13, lineHeight: 20, fontFamily: mono },
  footnote: { ...type.footnote, color: colors.muted, marginBottom: 8 },
  notice: { ...type.footnote, color: '#4cc38a', marginVertical: 8 },
});
