import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useVaultSession } from '../../src/lib/vault-session';
import { colors } from '../../src/ui';

/**
 * Memory detail (M6-1): read-only view of one entry with its full
 * provenance. Editing/forget arrive in M6-2.
 */
export default function MemoryDetail() {
  const session = useVaultSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;
  const entry = typeof id === 'string' ? session.getMemory(id) : undefined;
  if (!entry) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>That memory is not in the current list. Go back and refresh.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.metaRow}>
        <Text style={styles.badge}>{entry.type}</Text>
        <Text style={styles.scope}>{entry.scope}</Text>
      </View>
      <Text style={styles.contentText}>{entry.content}</Text>

      <Text style={styles.sectionTitle}>Provenance</Text>
      <Field label="Source" value={entry.source} />
      <Field label="Model" value={entry.source_model ?? 'none'} />
      <Field label="Confidence" value={entry.confidence.toFixed(2)} />
      <Field label="Created" value={entry.created_at} />
      <Field label="Valid from" value={entry.valid_from ?? 'unset'} />
      <Field label="Entry hash" value={entry.entry_hash} mono />
      <Field label="Previous hash" value={entry.prev_hash} mono />
      <Field label="Id" value={entry.id} mono />

      {entry.metadata ? (
        <>
          <Text style={styles.sectionTitle}>Metadata</Text>
          <Text style={styles.mono}>{JSON.stringify(entry.metadata, null, 2)}</Text>
        </>
      ) : null}

      <Text style={styles.footnote}>Editing from the phone arrives in a later update (M6-2).</Text>
    </ScrollView>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.mono]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  badge: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scope: { color: colors.muted, fontSize: 13 },
  contentText: { color: colors.text, fontSize: 17, lineHeight: 25, marginBottom: 24 },
  sectionTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 8,
  },
  field: { marginBottom: 10 },
  fieldLabel: { color: colors.muted, fontSize: 12, marginBottom: 2 },
  fieldValue: { color: colors.text, fontSize: 14, lineHeight: 20 },
  mono: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'Menlo',
    lineHeight: 18,
  },
  footnote: { color: colors.muted, fontSize: 13, marginTop: 24 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.bg },
  missingText: { color: colors.muted, fontSize: 15, textAlign: 'center' },
});
