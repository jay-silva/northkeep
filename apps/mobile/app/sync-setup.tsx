import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { memzero } from '@northkeep/core';
import { assertSyncUrl, deriveSyncCreds } from '@northkeep/sync';
import { loadDeviceSecretHex, loadSyncServerUrl, saveSyncServerUrl } from '../src/lib/secure-store';
import {
  DEFAULT_SYNC_SERVER_URL,
  runEnableSync,
  type EnableSyncOutcome,
} from '../src/lib/sync-setup-flow';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors } from '../src/ui';

/**
 * Turn on sync from this phone (Phase A: "this phone is my first device").
 * Accounts are implicit (ADR 0009): saving the server URL and running the
 * existing save-then-push sequence IS enablement; the server creates storage on
 * the first push. All outcome logic lives in the pure, tested
 * src/lib/sync-setup-flow.ts; this screen only renders the outcome.
 *
 * App Store steering (WS4): the subscription-required outcome states the fact
 * neutrally. No link, no price, no website, no purchase instruction, ever.
 *
 * NEEDS ON-DEVICE VALIDATION: the full first push against the production
 * server (402 for non-allowlisted beta accounts is the expected live path).
 */
export default function SyncSetup() {
  const session = useVaultSession();
  const params = useLocalSearchParams<{ from?: string }>();
  const fromOnboarding = params.from === 'onboarding';
  const [serverUrl, setServerUrl] = useState(DEFAULT_SYNC_SERVER_URL);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<EnableSyncOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const saved = await loadSyncServerUrl();
      if (saved) setServerUrl(saved);
    })();
  }, []);

  async function onEnable() {
    setError(null);
    setOutcome(null);
    let normalized: string;
    try {
      // Same https-or-loopback rule as desktop (@northkeep/sync assertSyncUrl).
      normalized = assertSyncUrl(serverUrl.trim()).toString().replace(/\/$/, '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    try {
      const result = await runEnableSync(
        {
          saveServerUrl: (url) => saveSyncServerUrl(url),
          runFirstPush: () => session.pushNow(),
        },
        normalized,
      );
      setServerUrl(normalized);
      setOutcome(result);
      if (result.kind === 'private-beta') {
        setAccountId(await loadFullAccountId());
      }
    } finally {
      setBusy(false);
    }
  }

  function onDone() {
    if (fromOnboarding) router.replace('/memories');
    else router.back();
  }

  const enabled = outcome?.kind === 'enabled';

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Turn on sync</Text>
        <Text style={styles.body}>
          Sync keeps an end-to-end encrypted copy of your vault on your account. The server stores
          only ciphertext; it cannot read your memories. With sync on, losing this phone no longer
          means losing your vault.
        </Text>

        {!enabled ? (
          <>
            <FieldLabel>Sync server</FieldLabel>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder={DEFAULT_SYNC_SERVER_URL}
              placeholderTextColor={colors.muted}
            />
            <ErrorNote message={error} />
            <Button
              title="Turn on sync"
              onPress={() => void onEnable()}
              busy={busy}
              disabled={serverUrl.trim().length === 0}
            />
          </>
        ) : null}

        {outcome?.kind === 'enabled' ? (
          <View style={styles.outcomeCard}>
            <Text style={styles.successText}>
              Sync is on. Your vault is backed up to your account (version {outcome.version}).
            </Text>
            {outcome.recoveredConflict ? (
              <Text style={styles.outcomeDetail}>
                Your account already had a vault from another device. This phone's version is now
                live; the other version was backed up on this phone.
              </Text>
            ) : null}
            <Button title="Done" onPress={onDone} style={styles.stackedButton} />
          </View>
        ) : null}

        {outcome?.kind === 'subscription-required' ? (
          <View style={styles.outcomeCard}>
            <Text style={styles.outcomeTitle}>{outcome.message}</Text>
            <Text style={styles.outcomeDetail}>{outcome.hint}</Text>
            <Text style={styles.outcomeDetail}>Your sync settings are saved on this phone.</Text>
            <Button title="Done" kind="secondary" onPress={onDone} style={styles.stackedButton} />
          </View>
        ) : null}

        {outcome?.kind === 'private-beta' ? (
          <View style={styles.outcomeCard}>
            <Text style={styles.outcomeTitle}>{outcome.message}</Text>
            {accountId ? (
              <>
                <Text style={styles.outcomeDetail}>
                  Your account id (safe to share; it reveals nothing about your vault):
                </Text>
                <Text style={styles.accountId} selectable>
                  {accountId}
                </Text>
                <Text style={styles.outcomeDetail}>Send it to support to get access.</Text>
              </>
            ) : null}
            <Text style={styles.outcomeDetail}>Your sync settings are saved on this phone.</Text>
            <Button title="Done" kind="secondary" onPress={onDone} style={styles.stackedButton} />
          </View>
        ) : null}

        {outcome?.kind === 'failed' ? (
          <>
            <ErrorNote message={outcome.message} />
            <Text style={styles.footnote}>
              Nothing was lost. Your vault is safe on this phone, and sync will also retry after
              your next edit.
            </Text>
          </>
        ) : null}

        {!enabled && fromOnboarding ? (
          <Button
            title="Skip for now"
            kind="secondary"
            onPress={() => router.replace('/memories')}
            style={styles.stackedButton}
          />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Full derived account id for the private-beta support path (not a secret). */
async function loadFullAccountId(): Promise<string | null> {
  try {
    const hex = await loadDeviceSecretHex();
    if (!hex) return null;
    const secret = Buffer.from(hex, 'hex');
    try {
      return deriveSyncCreds(secret).accountId;
    } finally {
      memzero(secret);
    }
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
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
  outcomeCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  },
  outcomeTitle: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  outcomeDetail: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  successText: { color: '#4cc38a', fontSize: 15, fontWeight: '600', lineHeight: 21 },
  accountId: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  stackedButton: { marginTop: 16 },
});
