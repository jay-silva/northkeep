import React, { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { projectRows, updatedLabel, type ProjectRow } from '../src/lib/projects';
import { syncAgeLine } from '../src/lib/sync-flow';
import { useVaultSession } from '../src/lib/vault-session';
import { MAX_SCALE_DENSE } from '../src/lib/type-scale';
import { SyncPill, colors, type } from '../src/ui';

/**
 * Projects: read-only list of the project documents in this phone's vault,
 * newest update first. Built from the same live entries the Memories tab
 * shows, so it reads nothing new. No pull-to-refresh here: a manual pull
 * replaces the vault behind a confirm flow that lives on Memories.
 */
export default function Projects() {
  const session = useVaultSession();
  const rows = useMemo(() => projectRows(session.entries), [session.entries]);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  return (
    <View style={styles.screen}>
      <SyncPill
        status={session.syncState.status}
        detail={session.syncState.detail}
        errorKind={session.syncState.errorKind}
        ageLine={syncAgeLine(session.lastSyncedAt)}
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.slug}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <View>
            <Text style={styles.emptyTitle}>No projects yet</Text>
            <Text style={styles.empty}>
              Projects are kept by the AI apps you connect on your Mac. An app resumes a project to
              pick up where you left off, and saves it to your vault when it checkpoints or wraps
              up. Saved projects show up here after this phone syncs: pull down on Memories to sync
              now.
            </Text>
          </View>
        }
        renderItem={({ item }) => <ProjectCard row={item} />}
      />
    </View>
  );
}

function ProjectCard({ row }: { row: ProjectRow }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => router.push(`/project/${row.slug}`)}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}. ${row.statusLine}. ${updatedLabel(row.updatedAt)}`}
    >
      <Text style={styles.name}>{row.name}</Text>
      <Text style={styles.status} numberOfLines={2}>
        {row.statusLine}
      </Text>
      <View style={styles.meta}>
        <Text style={styles.metaText} maxFontSizeMultiplier={MAX_SCALE_DENSE}>
          {updatedLabel(row.updatedAt)}
        </Text>
        {row.appName ? (
          <Text style={styles.metaText} maxFontSizeMultiplier={MAX_SCALE_DENSE} numberOfLines={1}>
            by {row.appName}
          </Text>
        ) : null}
      </View>
      {row.notes.map((note) => (
        <Text key={note} style={styles.note}>
          {note}
        </Text>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  listContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24 },
  emptyContainer: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { ...type.headline, color: colors.text, textAlign: 'center', marginBottom: 8 },
  empty: { ...type.body, color: colors.muted, textAlign: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginVertical: 6,
    minHeight: 44,
  },
  cardPressed: { opacity: 0.8 },
  name: { ...type.headline, color: colors.text, marginBottom: 4 },
  status: { ...type.body, color: colors.text },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, marginTop: 8 },
  metaText: { ...type.caption, color: colors.muted, fontWeight: '400' },
  note: { ...type.footnote, color: colors.warnText, marginTop: 6 },
});
