import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { getPlatform } from '@northkeep/core';
import { assertSyncUrl } from '@northkeep/sync';
import { importVaultFile } from '../src/lib/import-vault';
import { vaultPath } from '../src/lib/paths';
import {
  loadLastSyncVersion,
  loadSyncServerUrl,
  saveSyncServerUrl,
} from '../src/lib/secure-store';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors } from '../src/ui';

/**
 * Settings (M6-1): sync server, device info, lock, sign out / wipe local.
 * assertSyncUrl is reused from @northkeep/sync so the https-or-loopback rule
 * matches desktop exactly.
 *
 * NEEDS ON-DEVICE VALIDATION: assertSyncUrl relies on the global URL class;
 * React Native's URL implementation must be confirmed to parse protocol and
 * hostname correctly on Hermes.
 */
export default function Settings() {
  const session = useVaultSession();
  const [serverUrl, setServerUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [lastVersion, setLastVersion] = useState(0);
  const [vaultPresent, setVaultPresent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const url = await loadSyncServerUrl();
      setSavedUrl(url);
      setServerUrl(url ?? '');
      setLastVersion(await loadLastSyncVersion());
      try {
        setVaultPresent(getPlatform().storage.exists(vaultPath()));
      } catch {
        setVaultPresent(null); // platform adapters not wired in yet
      }
    })();
  }, []);

  async function onSaveServer() {
    setError(null);
    setNotice(null);
    try {
      const url = assertSyncUrl(serverUrl.trim());
      const normalized = url.toString().replace(/\/$/, '');
      await saveSyncServerUrl(normalized);
      setSavedUrl(normalized);
      setServerUrl(normalized);
      setNotice('Sync server saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onImport() {
    setError(null);
    setNotice(null);
    try {
      const result = await importVaultFile();
      if (result.ok) {
        setVaultPresent(true);
        setNotice('Vault file imported. Unlock it with your passphrase.');
      } else if (result.reason === 'not-a-vault') {
        setError('That file is not a NorthKeep vault (.nkv).');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onLock() {
    Alert.alert('Lock vault', 'This also turns off Face ID unlock until your next passphrase unlock.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Lock',
        style: 'destructive',
        onPress: () => {
          void session.lock({ clearBiometricCache: true }).then(() => router.replace('/unlock'));
        },
      },
    ]);
  }

  function onWipe() {
    Alert.alert(
      'Sign out and wipe this phone',
      'Deletes the vault copy, the device secret, and all cached keys from this phone. ' +
        'Your vault on your Mac and on the sync server is untouched. You can link again anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe this phone',
          style: 'destructive',
          onPress: () => {
            void session.signOutWipe().then(() => router.replace('/onboarding'));
          },
        },
      ],
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <FieldLabel>Sync</FieldLabel>
      {savedUrl === null ? (
        <>
          <Button title="Enable sync" onPress={() => router.push('/sync-setup')} />
          <Text style={styles.footnote}>
            Keeps an end-to-end encrypted copy of your vault on your account. Or set a custom
            server below.
          </Text>
        </>
      ) : null}
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://sync.northkeep.ai"
        placeholderTextColor={colors.muted}
      />
      <Button title="Save server" kind={savedUrl === null ? 'secondary' : 'primary'} onPress={() => void onSaveServer()} disabled={serverUrl.trim().length === 0} />

      <FieldLabel>Cloud Connect</FieldLabel>
      <Button title="Cloud Connect" kind="secondary" onPress={() => router.push('/sharing')} />
      <Text style={styles.footnote}>
        Make chosen memory scopes readable inside the AI apps you use (Claude, ChatGPT, Manus).
        Private by default: you pick each scope, confirm what leaves this phone, and can unshare
        anytime.
      </Text>

      <FieldLabel>This device</FieldLabel>
      <Info label="Linked" value={session.accountIdShort ? `yes (account ${session.accountIdShort})` : 'no'} />
      <Info label="Vault on this phone" value={vaultPresent === null ? 'unknown' : vaultPresent ? 'yes' : 'no'} />
      <Info label="Last synced version" value={lastVersion > 0 ? String(lastVersion) : 'never'} />
      <Info label="Sync server" value={savedUrl ?? 'not set'} />
      <Info label="Face ID unlock" value={session.biometricCacheEnabled ? 'on' : 'off'} />

      <FieldLabel>Recovery</FieldLabel>
      <Button
        title="Back up recovery secret"
        kind="secondary"
        onPress={() => router.push('/backup-secret')}
      />
      <Text style={styles.footnote}>
        Shows the secret stored on this phone. You need it plus your passphrase to open your vault
        on a new phone. Face ID or your passcode is required to view it.
      </Text>

      <FieldLabel>Vault file</FieldLabel>
      <Button title="Import a vault file (.nkv)" kind="secondary" onPress={() => void onImport()} />

      <ErrorNote message={error} />
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <FieldLabel>Diagnostics</FieldLabel>
      <Button
        title="On-device model eval (Tier-2 gate)"
        kind="secondary"
        onPress={() => router.push('/model-eval')}
        style={styles.stackedButton}
      />

      <FieldLabel>Session</FieldLabel>
      {session.status === 'unlocked' ? (
        <Button title="Lock vault" kind="secondary" onPress={onLock} style={styles.stackedButton} />
      ) : null}
      <Button title="Sign out and wipe this phone" kind="danger" onPress={onWipe} style={styles.stackedButton} />
      <Text style={styles.footnote}>
        Wiping removes everything NorthKeep stored on this phone. It does not touch your Mac or
        the encrypted copy on the sync server.
      </Text>
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
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    fontSize: 15,
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
  infoLabel: { color: colors.muted, fontSize: 14 },
  infoValue: { color: colors.text, fontSize: 14, flexShrink: 1, textAlign: 'right' },
  notice: { color: '#4cc38a', fontSize: 14, marginVertical: 8 },
  stackedButton: { marginBottom: 12 },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
