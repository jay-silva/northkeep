import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Redirect, router } from 'expo-router';
import { type MemoryType } from '@northkeep/core';
import { useVaultSession } from '../../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, TypeChips, colors } from '../../src/ui';

/**
 * Add a memory (M6-2). Writes through Vault.remember -> save (serialize ->
 * encrypt -> atomic write + .bak), which appends to the hash chain, then the
 * session pushes with X-Base-Version. Scope is free text (assignment); type is
 * one of the five memory types. Content-only is enough; scope defaults to
 * 'personal' in core when left blank.
 *
 * NEEDS ON-DEVICE VALIDATION: the write + push round trip needs a real vault and
 * sync server; only the pure conflict/state logic is unit-tested.
 */
export default function NewMemory() {
  const session = useVaultSession();
  const [content, setContent] = useState('');
  const [scope, setScope] = useState('personal');
  const [type, setType] = useState<MemoryType>('semantic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;

  async function onSave() {
    setError(null);
    setBusy(true);
    try {
      await session.addMemory({
        content: content.trim(),
        type,
        scope: scope.trim() || 'personal',
        source: 'mobile',
      });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <FieldLabel>Memory</FieldLabel>
        <TextInput
          style={styles.contentInput}
          value={content}
          onChangeText={setContent}
          placeholder="What should NorthKeep remember?"
          placeholderTextColor={colors.muted}
          multiline
          autoFocus
        />

        <FieldLabel>Type</FieldLabel>
        <TypeChips value={type} onChange={setType} />

        <FieldLabel>Scope</FieldLabel>
        <TextInput
          style={styles.input}
          value={scope}
          onChangeText={setScope}
          placeholder="personal"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.hint}>
          Scope groups related memories (for example personal, ems-work, str-business). It is also
          the boundary you would later choose to share.
        </Text>

        <ErrorNote message={error} />
        <Button
          title="Save memory"
          onPress={() => void onSave()}
          busy={busy}
          disabled={content.trim().length === 0}
          style={styles.saveButton}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  contentInput: {
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
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    fontSize: 15,
  },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  saveButton: { marginTop: 24 },
});
