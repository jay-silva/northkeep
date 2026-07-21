import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, router, Stack } from 'expo-router';
import type { MemoryEntry } from '@northkeep/core';
import { hasConversationsScope } from '../src/lib/journal-recipe';
import { filterMemories } from '../src/lib/search';
import {
  loadJournalCardDismissed,
  saveJournalCardDismissed,
} from '../src/lib/secure-store';
import { userFacingSyncError } from '../src/lib/sync-errors';
import { useVaultSession } from '../src/lib/vault-session';
import { ErrorNote, SyncPill, colors, type } from '../src/ui';

/**
 * Memories (M6-2): browse + keyword search over Vault.list(), newest first
 * (mirrors the web GUI). Pull-to-refresh runs a sync pull with
 * verify-before-replace. The header "+ Add" opens the compose screen; each
 * card opens detail where it can be edited or forgotten. The loud SyncPill
 * shows the state of the last save/push (idle / syncing / synced /
 * conflict-recovered / error), invariant #6 style.
 */
export default function Memories() {
  const session = useVaultSession();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null until the persisted flag loads, so the card never flashes in and out.
  const [journalDismissed, setJournalDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    void loadJournalCardDismissed().then(setJournalDismissed);
  }, []);

  const shown = useMemo(
    () => filterMemories(session.entries, query),
    [session.entries, query],
  );

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  // Journal setup card (Phase B WS3): only until the recipe's scope exists or
  // the user dismisses it, and never over a search.
  const showJournalCard =
    journalDismissed === false && !hasConversationsScope(session.entries) && query.trim().length === 0;

  async function onRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const { pulled } = await session.pullAndReload();
      if (!pulled) setError('No vault on the sync server yet. Sync from your computer first.');
    } catch (err) {
      // userFacingSyncError keeps the server's CLI-flavored 402 copy (price +
      // "northkeep sync subscribe") off this screen: neutral activation copy only.
      setError(userFacingSyncError(err));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push('/memory/new')} hitSlop={12} accessibilityLabel="Add memory">
              <Ionicons name="add" size={30} color={colors.accent} />
            </Pressable>
          ),
        }}
      />
      <SyncPill
        status={session.syncState.status}
        detail={session.syncState.detail}
        errorKind={session.syncState.errorKind}
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
        ListHeaderComponent={
          showJournalCard ? (
            <JournalSetupCard
              onOpen={() => router.push('/journal-setup')}
              onDismiss={() => {
                setJournalDismissed(true);
                void saveJournalCardDismissed();
              }}
            />
          ) : null
        }
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

/**
 * Dismissible "set up your journal" card (Phase B WS3). Routes to the guided
 * recipe; the dismissed flag persists in SecureStore alongside the other
 * non-secret app state.
 */
function JournalSetupCard({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, styles.journalCard, pressed && styles.cardPressed]}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel="Set up your journal"
    >
      <View style={styles.journalHeader}>
        <Text style={styles.journalTitle}>Let your AI apps keep a journal</Text>
        <Pressable onPress={onDismiss} hitSlop={12} accessibilityLabel="Dismiss journal setup card">
          <Ionicons name="close" size={18} color={colors.muted} />
        </Pressable>
      </View>
      <Text style={styles.journalBody}>
        Set up a shared scope where Claude, ChatGPT, or Manus writes a short summary of each
        conversation into your vault. Three steps, a few minutes.
      </Text>
      <Text style={styles.journalLink}>Set it up</Text>
    </Pressable>
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
  search: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    margin: 16,
    marginBottom: 8,
    ...type.body,
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyContainer: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  empty: { ...type.body, color: colors.muted, textAlign: 'center', lineHeight: 22 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginVertical: 6,
  },
  cardPressed: { opacity: 0.8 },
  journalCard: { borderColor: colors.accentStrong },
  journalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 6,
  },
  journalTitle: { ...type.body, color: colors.text, fontWeight: '700', flexShrink: 1 },
  journalBody: { ...type.footnote, color: colors.muted, marginBottom: 8 },
  journalLink: { ...type.subhead, color: colors.accent, fontWeight: '600' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  badge: {
    ...type.caption,
    color: colors.accent,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scope: { ...type.caption, color: colors.muted, fontWeight: '400' },
  date: { ...type.caption, color: colors.muted, fontWeight: '400', marginLeft: 'auto' },
  cardContent: { ...type.body, color: colors.text },
});
