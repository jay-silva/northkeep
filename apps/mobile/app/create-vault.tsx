import React, { useState } from 'react';
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
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../src/ui';

/**
 * Create a brand-new vault on this phone (M6-2b), no Mac required. Passphrase
 * rules mirror the desktop `northkeep init` exactly: minimum 8 characters, and
 * a confirmation that must match. The session generates the device secret on
 * device and creates the vault with core Vault.create; see vault-session
 * createVault.
 *
 * NEEDS ON-DEVICE VALIDATION: create runs two synchronous Argon2id derives at
 * MODERATE cost (create + open), which block the JS thread; the busy spinner
 * covers it, but the real duration is only measurable on hardware.
 */
const MIN_PASSPHRASE = 8;

export default function CreateVault() {
  const session = useVaultSession();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enableBiometrics, setEnableBiometrics] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canSubmit = passphrase.length >= MIN_PASSPHRASE && confirm === passphrase && !busy;

  async function onCreate() {
    if (passphrase.length < MIN_PASSPHRASE) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
      return;
    }
    if (confirm !== passphrase) {
      setError('Passphrases do not match.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await session.createVault(passphrase, { enableBiometricCache: enableBiometrics });
      setPassphrase('');
      setConfirm('');
      // Phase A: the backup step is mandatory for a phone-only user (losing the
      // phone before the secret is saved elsewhere means losing the vault).
      // Onboarding mode is signalled by the session's one-shot justCreatedVault
      // flag (set inside createVault), never by a URL param: params are
      // deep-linkable and must not be able to skip the auth gate.
      router.replace('/backup-secret');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        <Text style={styles.title}>Start a new vault</Text>
        <Text style={styles.body}>
          This creates a brand-new, empty vault on this phone. Your passphrase never leaves the
          device. It is one of two secrets that unlock your vault; this phone generates and safely
          stores the other one for you.
        </Text>

        <FieldLabel>Choose a passphrase</FieldLabel>
        <TextInput
          style={styles.input}
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          placeholder={`At least ${MIN_PASSPHRASE} characters`}
          placeholderTextColor={colors.muted}
        />
        {tooShort ? (
          <Text style={styles.hint}>At least {MIN_PASSPHRASE} characters.</Text>
        ) : null}

        <FieldLabel>Confirm passphrase</FieldLabel>
        <TextInput
          style={styles.input}
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => canSubmit && void onCreate()}
          placeholder="Type it again"
          placeholderTextColor={colors.muted}
        />
        {mismatch ? <Text style={styles.hint}>Those do not match yet.</Text> : null}

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Allow Face ID or fingerprint unlock on this phone</Text>
          <Switch
            value={enableBiometrics}
            onValueChange={setEnableBiometrics}
            accessibilityLabel="Allow Face ID or fingerprint unlock on this phone"
            accessibilityHint="Caches your key in the device keychain so you can unlock without typing your passphrase"
          />
        </View>

        <ErrorNote message={error} />
        <Button title="Create my vault" onPress={() => void onCreate()} busy={busy} disabled={!canSubmit} />

        <Text style={styles.warn}>
          There is no password reset. If you forget this passphrase, the vault cannot be opened.
          That is the point: only you can open it. Next, you will see your recovery secret so you
          can back it up, and you can turn on sync to keep an encrypted copy on your account.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
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
  hint: { ...type.footnote, color: colors.warnText, marginTop: 4, marginBottom: 4 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 16,
    gap: 12,
  },
  switchLabel: { ...type.subhead, color: colors.text, flex: 1 },
  warn: { ...type.footnote, color: colors.muted, marginTop: 20 },
});
