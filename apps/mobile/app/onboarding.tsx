import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, ErrorNote, colors } from '../src/ui';
import { useVaultSession } from '../src/lib/vault-session';
import { importVaultFile } from '../src/lib/import-vault';

/**
 * First-run intro (M6-2b). A three-way fork so a phone with no Mac is fully
 * supported, and an App Store reviewer with no device secret can get past this
 * screen:
 *   1. Link my Mac        — the existing QR / paste flow.
 *   2. Start fresh        — create a brand-new vault entirely on this phone.
 *   3. Try a demo         — open a synthetic sample vault instantly, no setup.
 *
 * Copy stance: plain language, honest about what the app can and cannot see.
 * No em dashes in user-facing text.
 */
export default function Onboarding() {
  const session = useVaultSession();
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [startingDemo, setStartingDemo] = useState(false);

  async function onImport() {
    setError(null);
    setImporting(true);
    try {
      const result = await importVaultFile();
      if (result.ok) {
        Alert.alert(
          'Vault file imported',
          'Now link this phone to your Mac so it has the device secret, then unlock with your passphrase.',
          [{ text: 'Link now', onPress: () => router.push('/device-link') }],
        );
      } else if (result.reason === 'not-a-vault') {
        setError('That file is not a NorthKeep vault (.nkv).');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function onTryDemo() {
    setError(null);
    setStartingDemo(true);
    try {
      await session.startDemo();
      router.push('/demo');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingDemo(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>NorthKeep</Text>
      <Text style={styles.tagline}>Your memory. Your keys. Now in your pocket.</Text>
      <Text style={styles.body}>
        Your vault stays encrypted until you unlock it, right here on this phone. Nothing is
        readable without secrets that only you hold. You can bring a vault over from your Mac, or
        start a brand-new one right here.
      </Text>

      <ErrorNote message={error} />

      <View style={styles.option}>
        <Text style={styles.optionTitle}>Start fresh on this phone</Text>
        <Text style={styles.optionBody}>
          Create a brand-new vault here. No Mac needed. You choose a passphrase, and this phone
          generates the second secret and keeps it safe. Back it up later by turning on sync.
        </Text>
        <Button title="Start fresh on this phone" onPress={() => router.push('/create-vault')} />
      </View>

      <View style={styles.option}>
        <Text style={styles.optionTitle}>Already have NorthKeep on a Mac?</Text>
        <Text style={styles.optionBody}>
          Link this phone to the Mac that holds your vault. In NorthKeep on your Mac, choose Link
          mobile device, then scan the code.
        </Text>
        <Button title="Link my Mac" kind="secondary" onPress={() => router.push('/device-link')} />
      </View>

      <View style={styles.option}>
        <Text style={styles.optionTitle}>Just looking?</Text>
        <Text style={styles.optionBody}>
          Try a demo with made-up sample memories. No passphrase, no account, nothing leaves this
          phone. You can start your own vault anytime.
        </Text>
        <Button
          title="Try a demo"
          kind="secondary"
          onPress={() => void onTryDemo()}
          busy={startingDemo}
        />
      </View>

      <Button
        title="Import a vault file instead"
        kind="secondary"
        onPress={() => void onImport()}
        busy={importing}
        style={styles.importButton}
      />
      <Text style={styles.footnote}>
        A vault file alone is not enough to read anything. You will still link this phone and enter
        your passphrase.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, paddingTop: 72, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 40, fontWeight: '700' },
  tagline: { color: colors.accent, fontSize: 16, fontWeight: '600', marginTop: 8, marginBottom: 20 },
  body: { color: colors.text, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  option: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginTop: 16,
  },
  optionTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  optionBody: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 14 },
  importButton: { marginTop: 24 },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 16 },
});
