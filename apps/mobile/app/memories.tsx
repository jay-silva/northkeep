import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect, router, Stack } from 'expo-router';
import type { MemoryEntry } from '@northkeep/core';
import { filterMemories } from '../src/lib/search';
import { useVaultSession } from '../src/lib/vault-session';
import { ErrorNote, colors } from '../src/ui';

/**
 * Memories (M6-1): read-only browse + keyword search over Vault.list(),
 * newest first (mirrors the web GUI). Pull-to-refresh runs a sync pull with
 * verify-before-replace. Editing arrives in M6-2.
 */
export default function Memories() {
  const session = useVaultSession();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(
    () => filterMemories(session.entries, query),
    [session.entries, query],
  );

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  async function onRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const { pulled } = await session.pullAndReload();
      if (!pulled) setError('No vault on the sync server yet. Sync from your computer first.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerButtons}>
              <Pressable onPress={() => router.push('/converse')} hitSlop={8}>
                <Text style={styles.headerLink}>Converse</Text>
              </Pressable>
              <Pressable onPress={() => router.push('/settings')} hitSlop={8}>
                <Text style={styles.headerLink}>Settings</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Search your memory (keyword search)"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <ErrorNote message={error} />
      <FlatList
        data={shown}
        keyExtractor={(entry) => entry.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.muted} />
        }
        contentContainerStyle={shown.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query.trim().length > 0
              ? 'No memories match that search.'
              : 'No memories in this vault yet. Pull down to sync from your account.'}
          </Text>
        }
        renderItem={({ item }) => <MemoryCard entry={item} />}
      />
    </View>
  );
}

function MemoryCard({ entry }: { entry: MemoryEntry }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => router.push(`/memory/${entry.id}`)}
      accessibilityRole="button"
    >
      <View style={styles.cardMeta}>
        <Text style={styles.badge}>{entry.type}</Text>
        <Text style={styles.scope}>{entry.scope}</Text>
        <Text style={styles.date}>{entry.created_at.slice(0, 10)}</Text>
      </View>
      <Text style={styles.cardContent} numberOfLines={3}>
        {entry.content}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerButtons: { flexDirection: 'row', gap: 18 },
  headerLink: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  search: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    margin: 16,
    marginBottom: 8,
    fontSize: 15,
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyContainer: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  empty: { color: colors.muted, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginVertical: 6,
  },
  cardPressed: { opacity: 0.8 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  badge: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scope: { color: colors.muted, fontSize: 12 },
  date: { color: colors.muted, fontSize: 12, marginLeft: 'auto' },
  cardContent: { color: colors.text, fontSize: 15, lineHeight: 21 },
});
