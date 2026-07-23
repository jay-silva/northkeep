import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { VaultAuthError } from '@northkeep/core';
import { userFacingSyncError } from '../src/lib/sync-errors';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../src/ui';

/**
 * Unlock (M6-1): passphrase entry derives the master key with the Argon2id
 * params from the vault header; optional biometric unlock reads the cached
 * key from the keychain (Face ID gated). On a fresh phone with no local
 * vault, unlocking first pulls the vault from the sync server (or the user
 * imports a .nkv from Settings/onboarding).
 *
 * NEEDS ON-DEVICE VALIDATION: unlock duration under MODERATE Argon2id (256
 * MiB, synchronous on the JS thread), biometric prompt UX, and the
 * pull-then-unlock path on a fresh phone.
 */
export default function Unlock() {
  const session = useVaultSession();
  const [passphrase, setPassphrase] = useState('');
  const [enableBiometrics, setEnableBiometrics] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const biometricTriedRef = useRef(false);

  // Offer the biometric path immediately when a cached key exists.
  useEffect(() => {
    if (session.biometricCacheEnabled && !biometricTriedRef.current) {
      biometricTriedRef.current = true;
      void tryBiometrics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.biometricCacheEnabled]);

  async function tryBiometrics() {
    setError(null);
    setBusy(true);
    try {
      const ok = await session.unlockWithBiometrics();
      if (ok) router.replace('/memories');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function onUnlock() {
    setError(null);
    setBusy(true);
    try {
      await session.unlockWithPassphrase(passphrase, { enableBiometricCache: enableBiometrics });
      setPassphrase('');
      router.replace('/memories');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Unlock your vault</Text>
        <Text style={styles.body}>
          Decryption happens on this phone. Your passphrase never leaves it.
        </Text>

        <FieldLabel>Passphrase</FieldLabel>
        <TextInput
          style={styles.input}
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          onSubmitEditing={() => void onUnlock()}
          placeholder="Your vault passphrase"
          placeholderTextColor={colors.muted}
        />

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Allow Face ID or fingerprint unlock on this phone</Text>
          <Switch
            value={enableBiometrics}
            onValueChange={setEnableBiometrics}
            accessibilityLabel="Allow Face ID or fingerprint unlock on this phone"
            accessibilityHint="Caches your key so future unlocks can use Face ID or your fingerprint"
          />
        </View>

        <ErrorNote message={error} />
        <Button
          title="Unlock"
          onPress={() => void onUnlock()}
          busy={busy}
          disabled={passphrase.length === 0}
        />
        {session.biometricCacheEnabled ? (
          <Button
            title="Unlock with Face ID or fingerprint"
            kind="secondary"
            onPress={() => void tryBiometrics()}
            style={styles.secondaryButton}
          />
        ) : null}
        <Button
          title="Settings"
          kind="secondary"
          onPress={() => router.push('/settings')}
          style={styles.secondaryButton}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function describe(err: unknown): string {
  if (err instanceof VaultAuthError) {
    return 'That did not unlock the vault. Check your passphrase, and that this phone is linked to the right Mac.';
  }
  // The fresh-phone unlock path pulls from the sync server first, so a 402/403/
  // network failure can surface here; userFacingSyncError maps those to neutral
  // copy (never the server's CLI-flavored 402 text) and passes others through.
  return userFacingSyncError(err);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 40 },
  title: { ...type.title, color: colors.text, marginBottom: 8 },
  body: { ...type.subhead, color: colors.muted, marginBottom: 8 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 14,
    ...type.callout,
    fontWeight: '400',
    marginBottom: 4,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 16,
    gap: 12,
  },
  switchLabel: { ...type.subhead, color: colors.text, flex: 1 },
  secondaryButton: { marginTop: 12 },
});
