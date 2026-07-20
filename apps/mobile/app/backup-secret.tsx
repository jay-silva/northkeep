import React, { useCallback, useEffect, useState } from 'react';
import {
  // Deprecated in RN core but still shipped in 0.83; see CLIPBOARD NOTE below.
  Clipboard,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { formatDeviceSecretGroups } from '../src/lib/backup-flow';
import { loadDeviceSecretHex } from '../src/lib/secure-store';
import { Button, ErrorNote, FieldLabel, colors } from '../src/ui';

/**
 * Back up the recovery secret (Phase A of phone-first onboarding). A person
 * whose ONLY device is this phone loses the vault if the phone is lost before
 * this secret is saved somewhere else, so after create-vault this screen is
 * mandatory: no skip, and Continue requires an explicit "I saved it"
 * confirmation. The secret is shown in the exact 64-hex form the device-link
 * manual paste accepts (grouped for reading; the parser strips whitespace).
 *
 * Reached two ways:
 *  - from=create: immediately after vault creation (first run; no auth gate,
 *    the user typed the passphrase seconds ago).
 *  - from Settings ("Back up recovery secret"): gated behind the OS local
 *    authentication prompt before the secret is revealed.
 *
 * CLIPBOARD NOTE: react-native's core Clipboard is deprecated in favor of the
 * extracted @react-native-clipboard/clipboard package, but it is still shipped
 * and compiled into RN 0.83, so using it costs no new native module and no new
 * dev-client build (a Phase A constraint). The secret Text is also selectable
 * as a fallback. Revisit when RN actually removes it.
 *
 * NEEDS ON-DEVICE VALIDATION: the LocalAuthentication prompt flow (including
 * the no-passcode fallback), Clipboard.setString on a real build, and whether
 * the iOS app-switcher privacy cover (root layout) masks this screen's secret.
 */
export default function BackupSecret() {
  const params = useLocalSearchParams<{ from?: string }>();
  const fromCreate = params.from === 'create';
  const [secretHex, setSecretHex] = useState<string | null>(null);
  const [state, setState] = useState<'checking' | 'ready' | 'denied' | 'missing'>('checking');
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const reveal = useCallback(async () => {
    setState('checking');
    if (!fromCreate) {
      // Settings path: require the OS auth prompt before showing the secret.
      // If the device has no biometrics or passcode enrolled there is nothing
      // to gate with; proceed (the phone itself is the weaker lock then).
      const hardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (hardware && enrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Show your recovery secret',
        });
        if (!result.success) {
          setState('denied');
          return;
        }
      }
    }
    const hex = await loadDeviceSecretHex();
    if (!hex) {
      setState('missing');
      return;
    }
    setSecretHex(hex);
    setState('ready');
  }, [fromCreate]);

  useEffect(() => {
    void reveal();
  }, [reveal]);

  function onCopy() {
    if (!secretHex) return;
    // Copy the RAW 64-hex form (no spaces): guaranteed to paste cleanly into
    // the device-link screen and into password-manager fields.
    Clipboard.setString(secretHex);
    setCopied(true);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* First run is a one-way door: no back-swipe out of the backup step. */}
      <Stack.Screen options={{ headerBackVisible: !fromCreate, gestureEnabled: !fromCreate }} />

      <Text style={styles.title}>Save your recovery secret</Text>
      <Text style={styles.body}>
        This is your recovery secret. It pairs with your passphrase: you need both to open your
        vault on a new phone. NorthKeep never sees either one and cannot recover them for you.
      </Text>
      <Text style={styles.body}>
        Save it in a password manager, or write it down and keep it somewhere safe. If you lose
        this phone without a copy of this secret, your vault is gone.
      </Text>

      {state === 'checking' ? <Text style={styles.body}>Preparing...</Text> : null}

      {state === 'denied' ? (
        <>
          <ErrorNote message="Authentication is required to show the recovery secret." />
          <Button title="Try again" onPress={() => void reveal()} />
        </>
      ) : null}

      {state === 'missing' ? (
        <ErrorNote message="There is no device secret on this phone yet. Create or link a vault first." />
      ) : null}

      {state === 'ready' && secretHex ? (
        <>
          <FieldLabel>Your recovery secret</FieldLabel>
          <View style={styles.secretCard}>
            <Text style={styles.secretText} selectable>
              {formatDeviceSecretGroups(secretHex)}
            </Text>
          </View>
          <Button title="Copy secret" kind="secondary" onPress={onCopy} />
          {copied ? (
            <Text style={styles.notice}>
              Copied. Paste it into your password manager now, then copy something else so the
              secret does not sit on the clipboard.
            </Text>
          ) : null}

          {fromCreate ? (
            <>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>I saved my recovery secret</Text>
                <Switch value={confirmed} onValueChange={setConfirmed} />
              </View>
              <Text style={styles.footnote}>
                Next, you can turn on sync to keep an end-to-end encrypted copy of your vault on
                your account.
              </Text>
              <Button
                title="Turn on sync"
                onPress={() => router.replace({ pathname: '/sync-setup', params: { from: 'onboarding' } })}
                disabled={!confirmed}
                style={styles.stackedButton}
              />
              <Button
                title="Not now"
                kind="secondary"
                onPress={() => router.replace('/memories')}
                disabled={!confirmed}
                style={styles.stackedButton}
              />
            </>
          ) : (
            <Button title="Done" onPress={() => router.back()} style={styles.stackedButton} />
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  secretCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  secretText: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  notice: { color: '#4cc38a', fontSize: 13, lineHeight: 19, marginTop: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 16,
    gap: 12,
  },
  switchLabel: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 20 },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  stackedButton: { marginTop: 12 },
});
