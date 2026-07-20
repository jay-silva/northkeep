import React, { useEffect, useState } from 'react';
import {
  // Deprecated in RN core but still shipped in 0.83; same tradeoff as
  // backup-secret.tsx (no new native module).
  Clipboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect, router } from 'expo-router';
import {
  CONVERSATIONS_SCOPE,
  JOURNAL_HONESTY_NOTE,
  JOURNAL_PATTERN_SCHEDULED_TASK,
  JOURNAL_PATTERN_STANDING_INSTRUCTION,
  JOURNAL_SEED_MEMORY,
  hasConversationsScope,
} from '../src/lib/journal-recipe';
import { loadConnectorSharedScopes } from '../src/lib/secure-store';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, colors } from '../src/ui';

/**
 * "Let your AI apps keep a journal" (Phase B WS3): the phone walkthrough of
 * the published northkeep.ai/start step 9 recipe. The strings live in the
 * pure, audited src/lib/journal-recipe.ts.
 *
 * ORDER IS LOAD-BEARING: the connector's memory_remember is fail-closed to
 * scopes that already have at least one shared row, so step 1 seeds a memory
 * BEFORE step 2 shares the scope. The screen keeps that order explicit.
 */
export default function JournalSetup() {
  const session = useVaultSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void loadConnectorSharedScopes().then((scopes) =>
      setShared(scopes.includes(CONVERSATIONS_SCOPE)),
    );
  }, []);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  const scopeExists = hasConversationsScope(session.entries);

  function onCreateScope() {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await session.addMemory({ ...JOURNAL_SEED_MEMORY });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  function copy(label: string, value: string) {
    Clipboard.setString(value);
    setCopied(label);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Let your AI apps keep a journal</Text>
      <Text style={styles.body}>
        With one shared scope and one instruction, Claude, ChatGPT, or Manus can write a short
        summary of each substantive conversation into your vault. Three steps, in this order.
      </Text>

      <Text style={styles.stepTitle}>Step 1: Create the "conversations" scope</Text>
      <Text style={styles.body}>
        Add one memory with a new scope named "conversations". Do this first: the connector only
        accepts app-written memories into a scope that already holds at least one shared memory,
        so the scope needs a memory in it before you share it.
      </Text>
      {scopeExists ? (
        <Text style={styles.done}>Done. The "conversations" scope exists in your vault.</Text>
      ) : (
        <Button title="Create it for me" onPress={onCreateScope} busy={busy} />
      )}
      <ErrorNote message={error} />

      <Text style={styles.stepTitle}>Step 2: Share the "conversations" scope</Text>
      <Text style={styles.body}>
        Sharing copies the scope to NorthKeep's connector so your paired AI apps can write to it.
        You will see a full confirmation of what leaves this phone before anything is shared.
      </Text>
      {shared ? (
        <Text style={styles.done}>Done. The "conversations" scope is shared.</Text>
      ) : (
        <Button
          title="Share the conversations scope"
          kind={scopeExists ? 'primary' : 'secondary'}
          onPress={() =>
            router.push({ pathname: '/sharing', params: { share: CONVERSATIONS_SCOPE } })
          }
        />
      )}

      <Text style={styles.stepTitle}>Step 3: Tell your AI app to write the journal</Text>
      <Text style={styles.body}>
        Paste one of these into your AI app. Pattern 1 is a nightly scheduled task, for apps whose
        tasks can see your session history (Manus, ChatGPT). Pattern 2 is a standing instruction
        stored in your vault, so it travels to every app you pair.
      </Text>

      <Text style={styles.patternLabel}>Pattern 1: nightly scheduled task</Text>
      <View style={styles.patternCard}>
        <Text style={styles.patternText} selectable>
          {JOURNAL_PATTERN_SCHEDULED_TASK}
        </Text>
      </View>
      <Pressable onPress={() => copy('p1', JOURNAL_PATTERN_SCHEDULED_TASK)} accessibilityRole="button">
        <Text style={styles.copyLink}>{copied === 'p1' ? 'Copied.' : 'Copy pattern 1'}</Text>
      </Pressable>

      <Text style={styles.patternLabel}>Pattern 2: standing instruction</Text>
      <View style={styles.patternCard}>
        <Text style={styles.patternText} selectable>
          {JOURNAL_PATTERN_STANDING_INSTRUCTION}
        </Text>
      </View>
      <Pressable
        onPress={() => copy('p2', JOURNAL_PATTERN_STANDING_INSTRUCTION)}
        accessibilityRole="button"
      >
        <Text style={styles.copyLink}>{copied === 'p2' ? 'Copied.' : 'Copy pattern 2'}</Text>
      </Pressable>

      <Text style={styles.noteTitle}>Worth knowing</Text>
      <Text style={styles.body}>{JOURNAL_HONESTY_NOTE}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 8 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  stepTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  done: { color: '#4cc38a', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  patternLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 10,
    marginBottom: 6,
  },
  patternCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  patternText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyLink: { color: colors.accent, fontSize: 14, fontWeight: '600', paddingVertical: 8 },
  noteTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 16, marginBottom: 6 },
});
