import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import type { MemoryEntry, MemoryType } from '@northkeep/core';
import { useVaultSession } from '../../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, TypeChips, colors } from '../../src/ui';

/**
 * Memory detail (M6-2): read-only view of one entry with its full provenance,
 * plus in-place Edit and Forget.
 *
 * Editing supersedes by appending a NEW entry (append-only; ADR 0015), so the
 * edited entry gets a new id and the old one becomes superseded history; forget
 * tombstones it. Either way our own reloadEntries() drops the ORIGINAL id from
 * the live list mid-operation. We therefore render from a STABLE snapshot that
 * only ever updates to a defined entry, so the Edit/Read subtree is not
 * unmounted while its save/push promise is still in flight (which would flash
 * "not in the current list" and warn on setState-after-unmount). On success the
 * handlers navigate back; the chain stays valid and the phone pushes the change.
 */
export default function MemoryDetail() {
  const session = useVaultSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [editing, setEditing] = useState(false);

  const live = typeof id === 'string' ? session.getMemory(id) : undefined;
  // Latch the last defined entry so a supersede/forget of this id does not yank
  // the screen out from under an in-flight save.
  const [shown, setShown] = useState<MemoryEntry | undefined>(live);
  useEffect(() => {
    if (live) setShown(live);
  }, [live]);

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;
  if (!shown) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>That memory is not in the current list. Go back and refresh.</Text>
      </View>
    );
  }

  if (editing) {
    return <EditForm entry={shown} onDone={() => router.back()} onCancel={() => setEditing(false)} />;
  }
  return <ReadView entry={shown} onEdit={() => setEditing(true)} />;
}

function ReadView({ entry, onEdit }: { entry: MemoryEntry; onEdit: () => void }) {
  const session = useVaultSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onForget() {
    Alert.alert(
      'Forget this memory',
      'The content is blanked permanently. The entry stays as a tombstone so the record that it ' +
        'existed and was forgotten remains, and your provenance chain stays intact. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError(null);
            void session
              .forgetMemory(entry.id)
              .then(() => router.back())
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
                setBusy(false);
              });
          },
        },
      ],
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.metaRow}>
        <Text style={styles.badge}>{entry.type}</Text>
        <Text style={styles.scope}>{entry.scope}</Text>
      </View>
      <Text style={styles.contentText}>{entry.content}</Text>

      <View style={styles.actions}>
        <Button title="Edit" onPress={onEdit} style={styles.actionButton} disabled={busy} />
        <Button title="Forget" kind="danger" onPress={onForget} style={styles.actionButton} busy={busy} />
      </View>
      <ErrorNote message={error} />

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
    </ScrollView>
  );
}

function EditForm({
  entry,
  onDone,
  onCancel,
}: {
  entry: MemoryEntry;
  onDone: () => void;
  onCancel: () => void;
}) {
  const session = useVaultSession();
  const [content, setContent] = useState(entry.content);
  const [scope, setScope] = useState(entry.scope);
  const [type, setType] = useState<MemoryType>(entry.type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    setError(null);
    setBusy(true);
    try {
      // Send only the fields that changed; a no-op edit returns the original
      // unchanged (core decides), and a same-values save simply syncs nothing new.
      await session.editMemory(entry.id, {
        content: content.trim() === entry.content ? undefined : content.trim(),
        scope: scope.trim() === entry.scope ? undefined : scope.trim(),
        type: type === entry.type ? undefined : type,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const unchanged =
    content.trim() === entry.content && scope.trim() === entry.scope && type === entry.type;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <FieldLabel>Memory</FieldLabel>
      <TextInput
        style={styles.editContent}
        value={content}
        onChangeText={setContent}
        multiline
        autoFocus
        placeholderTextColor={colors.muted}
      />

      <FieldLabel>Type</FieldLabel>
      <TypeChips value={type} onChange={setType} />

      <FieldLabel>Scope</FieldLabel>
      <TextInput
        style={styles.editScope}
        value={scope}
        onChangeText={setScope}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.muted}
      />
      <Text style={styles.editNote}>
        Editing keeps the original as history and appends a new version, so your provenance chain
        stays verifiable.
      </Text>

      <ErrorNote message={error} />
      <View style={styles.actions}>
        <Button title="Cancel" kind="secondary" onPress={onCancel} style={styles.actionButton} disabled={busy} />
        <Button
          title="Save changes"
          onPress={() => void onSave()}
          style={styles.actionButton}
          busy={busy}
          disabled={unchanged || content.trim().length === 0}
        />
      </View>
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
  contentText: { color: colors.text, fontSize: 17, lineHeight: 25, marginBottom: 20 },
  actions: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  actionButton: { flex: 1 },
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
  editContent: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 14,
    fontSize: 16,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  editScope: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    fontSize: 15,
  },
  editNote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 4 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.bg },
  missingText: { color: colors.muted, fontSize: 15, textAlign: 'center' },
});
