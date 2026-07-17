import React, { useEffect, useRef } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, router } from 'expo-router';
import type { MemoryEntry } from '@northkeep/core';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, colors } from '../src/ui';

/**
 * Demo browser (M6-2b). Shows the synthetic sample vault built by
 * session.startDemo. This is a dedicated, fully self-contained screen so the
 * "this is a demo" label is ALWAYS visible (the real Memories screen is owned by
 * another track and carries no demo affordance). The demo vault is torn down on
 * exit via session.exitDemo, so it can never linger or be mistaken for a real
 * vault.
 *
 * Read-only on purpose: the demo illustrates a populated vault; creating real
 * memories is what "Start my own vault" is for.
 */
export default function Demo() {
  const session = useVaultSession();

  // Tear the demo down when this screen goes away (back gesture pops it, or a
  // CTA replaces it). Held in a ref so the cleanup always calls the latest
  // exitDemo without re-running the effect. Idempotent with the CTA handlers.
  const exitRef = useRef(session.exitDemo);
  exitRef.current = session.exitDemo;
  useEffect(() => {
    return () => {
      void exitRef.current();
    };
  }, []);

  // If we somehow land here without an active demo (e.g. deep link), bounce back.
  if (!session.isDemo) return <Redirect href="/onboarding" />;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Demo', headerBackVisible: false }} />

      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>This is a demo</Text>
        <Text style={styles.bannerBody}>
          These memories are made up, just to show how NorthKeep looks. Nothing here is real and
          nothing leaves this phone. Start your own vault to keep real memories, encrypted and
          yours.
        </Text>
      </View>

      <FlatList
        data={session.entries}
        keyExtractor={(entry) => entry.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <DemoCard entry={item} />}
        ListFooterComponent={
          <View style={styles.footer}>
            <Button
              title="Start my own vault"
              onPress={() => router.replace('/create-vault')}
              style={styles.footerButton}
            />
            <Button
              title="Link my Mac instead"
              kind="secondary"
              onPress={() => router.replace('/device-link')}
              style={styles.footerButton}
            />
            <Button
              title="Back"
              kind="secondary"
              onPress={() => router.replace('/onboarding')}
              style={styles.footerButton}
            />
          </View>
        }
      />
    </View>
  );
}

function DemoCard({ entry }: { entry: MemoryEntry }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardMeta}>
        <Text style={styles.badge}>{entry.type}</Text>
        <Text style={styles.scope}>{entry.scope}</Text>
      </View>
      <Text style={styles.cardContent}>{entry.content}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  banner: {
    backgroundColor: colors.warnBg,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  bannerTitle: { color: colors.warnText, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  bannerBody: { color: colors.warnText, fontSize: 13, lineHeight: 19 },
  listContent: { padding: 16, paddingBottom: 24 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginVertical: 6,
  },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  badge: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scope: { color: colors.muted, fontSize: 12 },
  cardContent: { color: colors.text, fontSize: 15, lineHeight: 21 },
  footer: { marginTop: 16, gap: 12 },
  footerButton: { marginTop: 0 },
});
