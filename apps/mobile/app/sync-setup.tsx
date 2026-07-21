import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { memzero } from '@northkeep/core';
import { assertSyncUrl, deriveSyncCreds } from '@northkeep/sync';
import { loadDeviceSecretHex, loadSyncServerUrl, saveSyncServerUrl } from '../src/lib/secure-store';
import {
  DEFAULT_SYNC_SERVER_URL,
  runEnableSync,
  type EnableSyncOutcome,
} from '../src/lib/sync-setup-flow';
import {
  SYNC_LOCAL_SAFE_REASSURANCE,
  SYNC_MANAGED_OUTSIDE_APP,
  SYNC_SUBSCRIPTION_RECHECK,
  SYNC_SUPPORT_NEXT_STEP,
  SYNC_TURN_ON_LATER,
} from '../src/lib/sync-errors';
import {
  SUPPORT_EMAIL,
  buildSupportMailto,
} from '../src/lib/sync-support-mail';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../src/ui';

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
      // Both blocked outcomes offer the same dignified next step (copy the
      // account id / email support), so derive it for either one.
      if (result.kind === 'private-beta' || result.kind === 'subscription-required') {
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
          <SyncBlockedCard
            headline={outcome.message}
            hint={SYNC_SUBSCRIPTION_RECHECK}
            accountId={accountId}
            onDone={onDone}
          />
        ) : null}

        {outcome?.kind === 'private-beta' ? (
          <SyncBlockedCard headline={outcome.message} hint={null} accountId={accountId} onDone={onDone} />
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

/**
 * The dignified dead-end card for both blocked outcomes (subscription-required
 * and private-beta). It gives the moment a next step without violating App Store
 * steering: it acknowledges the user is already safe locally, explains in
 * neutral terms why sync cannot be turned on in the app (managed from the
 * NorthKeep account), and offers two real actions -- copy the account id, and
 * email support -- neither of which is a purchase. All sentence copy comes from
 * the RN-free constants the steering test covers; nothing sensitive leaves here.
 */
function SyncBlockedCard({
  headline,
  hint,
  accountId,
  onDone,
}: {
  headline: string;
  hint: string | null;
  accountId: string | null;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [mailUnavailable, setMailUnavailable] = useState(false);

  async function onCopy() {
    if (!accountId) return;
    await Clipboard.setStringAsync(accountId);
    setCopied(true);
  }

  async function onEmailSupport() {
    // mailto: is a support contact, not a purchase link (App Store steering
    // allows support). The account id travels in the body because the user is
    // sending it to support to get sync enabled; it reveals nothing about the
    // vault. Guard with canOpenURL and fall back to a selectable address so a
    // device with no mail client still has a path.
    const url = buildSupportMailto(accountId);
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      // fall through to the address fallback
    }
    setMailUnavailable(true);
  }

  return (
    <View style={styles.outcomeCard}>
      <Text style={styles.outcomeTitle}>{headline}</Text>
      {hint ? <Text style={styles.outcomeDetail}>{hint}</Text> : null}

      <Text style={styles.outcomeDetail}>{SYNC_LOCAL_SAFE_REASSURANCE}</Text>
      <Text style={styles.outcomeDetail}>{SYNC_MANAGED_OUTSIDE_APP}</Text>

      {accountId ? (
        <>
          <Text style={styles.outcomeDetail}>
            Your account id (safe to share; it reveals nothing about your vault):
          </Text>
          <Text style={styles.accountId} selectable>
            {accountId}
          </Text>
          <Button
            title={copied ? 'Copied' : 'Copy my account id'}
            kind="secondary"
            onPress={() => void onCopy()}
            style={styles.stackedButton}
          />
        </>
      ) : null}

      <Text style={styles.outcomeDetail}>{SYNC_SUPPORT_NEXT_STEP}</Text>
      <Button
        title="Email support"
        onPress={() => void onEmailSupport()}
        style={styles.stackedButton}
      />
      {mailUnavailable ? (
        <View style={styles.mailFallback}>
          <Ionicons name="mail-outline" size={15} color={colors.muted} />
          <Text style={styles.mailFallbackText} selectable>
            {SUPPORT_EMAIL}
          </Text>
        </View>
      ) : null}

      <Text style={styles.outcomeDetail}>{SYNC_TURN_ON_LATER}</Text>
      <Button title="Not now" kind="secondary" onPress={onDone} style={styles.stackedButton} />
    </View>
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
  title: { ...type.title, color: colors.text, marginBottom: 8 },
  body: { ...type.subhead, color: colors.muted, marginBottom: 8 },
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
  outcomeCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 16,
  },
  outcomeTitle: { ...type.body, color: colors.text, fontWeight: '600' },
  outcomeDetail: { ...type.footnote, color: colors.muted, marginTop: 8 },
  successText: { ...type.body, color: '#4cc38a', fontWeight: '600' },
  accountId: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footnote: { ...type.footnote, color: colors.muted, marginTop: 4 },
  stackedButton: { marginTop: 16 },
  mailFallback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  mailFallbackText: {
    ...type.body,
    color: colors.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
