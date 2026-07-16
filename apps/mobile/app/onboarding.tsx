import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { Button, ErrorNote, colors } from '../src/ui';
import { importVaultFile } from '../src/lib/import-vault';

/**
 * First-run intro. Copy stance: plain language, honest about what the app
 * can and cannot see. No em dashes in user-facing text.
 */
export default function Onboarding() {
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>NorthKeep</Text>
      <Text style={styles.tagline}>Your memory. Your keys. Now in your pocket.</Text>
      <Text style={styles.body}>
        Your vault stays encrypted until you unlock it, right here on this phone. Nothing is
        readable without two things only you hold: the device secret from your Mac and your
        passphrase.
      </Text>
      <Text style={styles.body}>
        Start by linking this phone to the Mac that holds your vault. In NorthKeep on your Mac,
        choose Link mobile device, then scan the code.
      </Text>
      <ErrorNote message={error} />
      <Button title="Link your Mac" onPress={() => router.push('/device-link')} />
      <Button
        title="Import a vault file instead"
        kind="secondary"
        onPress={() => void onImport()}
        busy={importing}
        style={styles.secondaryButton}
      />
      <Text style={styles.footnote}>
        A vault file alone is not enough to read anything. You will still link this phone and
        enter your passphrase.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, paddingTop: 96 },
  title: { color: colors.text, fontSize: 40, fontWeight: '700' },
  tagline: { color: colors.accent, fontSize: 16, fontWeight: '600', marginTop: 8, marginBottom: 24 },
  body: { color: colors.text, fontSize: 15, lineHeight: 22, marginBottom: 16 },
  secondaryButton: { marginTop: 12 },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 16 },
});
