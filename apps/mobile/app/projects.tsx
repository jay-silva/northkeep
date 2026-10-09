import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { filterProjectRows, projectRows, updatedLabel, type ProjectRow } from '../src/lib/projects';
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
  const allRows = useMemo(() => projectRows(session.entries), [session.entries]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'draft'>('all');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const rows = useMemo(() => filterProjectRows(allRows, query, filter, sort), [allRows, query, filter, sort]);
  const counts = { all: allRows.length, attention: allRows.filter(row => row.conflict).length, draft: allRows.filter(row => row.draft).length };

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
      <View style={styles.toolbar}>
        <Text style={styles.subtitle}>Pick up where you left off.</Text>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search projects" placeholderTextColor={colors.muted}
          accessibilityLabel="Search projects" style={styles.search} autoCorrect={false} />
        <View style={styles.filters}>
          {(['all', 'attention', 'draft'] as const).map(value => (
            <Pressable key={value} onPress={() => setFilter(value)} accessibilityRole="button"
              accessibilityState={{ selected: filter === value }} style={[styles.filter, filter === value && styles.filterSelected]}>
              <Text style={styles.filterText}>{value === 'all' ? 'All' : value === 'attention' ? 'Needs attention' : 'Drafts'} {counts[value]}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.results}>
          <Text style={styles.metaText} accessibilityLiveRegion="polite">{rows.length} {rows.length === 1 ? 'project' : 'projects'}</Text>
          <Pressable onPress={() => setSort(sort === 'recent' ? 'name' : 'recent')} style={styles.sort}
            accessibilityRole="button" accessibilityLabel={`Sort: ${sort === 'recent' ? 'recently updated' : 'name'}. Tap to change.`}>
            <Text style={styles.filterText}>{sort === 'recent' ? 'Recently updated' : 'Name'}</Text>
          </Pressable>
        </View>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.slug}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
        ListEmptyComponent={
          <View>
            <Text style={styles.emptyTitle}>{allRows.length ? 'No matching projects' : 'No projects yet'}</Text>
            <Text style={styles.empty}>
              {allRows.length ? 'Try another search or show all projects.' : 'Saved projects show up here after this phone syncs. Start a project through a connected assistant on your Mac. Pull down on Memories to sync now.'}
            </Text>
            {allRows.length ? <Pressable onPress={() => { setQuery(''); setFilter('all'); }} style={styles.sort} accessibilityRole="button">
              <Text style={styles.filterText}>Clear search and filters</Text>
            </Pressable> : null}
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
      accessibilityLabel={`${row.name}. ${row.statusLine}. Next action: ${row.nextAction}. ${updatedLabel(row.updatedAt)}. ${row.notes.join('. ')}`}
    >
      <Text style={styles.name}>{row.name}</Text>
      <Text style={styles.status} numberOfLines={2}>
        {row.statusLine}
      </Text>
      <Text style={styles.nextLabel}>Next action</Text>
      <Text style={styles.nextAction} numberOfLines={2}>{row.nextAction}</Text>
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
  toolbar: { paddingHorizontal: 20, paddingTop: 16 },
  subtitle: { ...type.body, color: colors.muted, marginTop: 6, marginBottom: 18 },
  search: { ...type.body, color: colors.text, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: 8, minHeight: 44, paddingHorizontal: 12 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 10 },
  filter: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 9, borderRadius: 8 },
  filterSelected: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  filterText: { ...type.footnote, color: colors.text },
  results: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 4 },
  sort: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  nextLabel: { ...type.caption, color: colors.muted, marginTop: 12, marginBottom: 3 },
  nextAction: { ...type.body, color: colors.text },
  listContent: { paddingHorizontal: 20, paddingBottom: 24 },
  emptyContainer: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { ...type.headline, color: colors.text, textAlign: 'center', marginBottom: 8 },
  empty: { ...type.body, color: colors.muted, textAlign: 'center' },
  card: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 20,
    minHeight: 44,
  },
  cardPressed: { opacity: 0.8 },
  name: { ...type.headline, color: colors.text, marginBottom: 4 },
  status: { ...type.body, color: colors.text },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, marginTop: 8 },
  metaText: { ...type.caption, color: colors.muted, fontWeight: '400' },
  note: { ...type.footnote, color: colors.warnText, marginTop: 6 },
});
