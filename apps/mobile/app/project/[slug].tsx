import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import {
  FILE_ACCESS_LABELS,
  FILE_TYPE_LABELS,
  projectDetail,
  updatedLabel,
  type TextBlock,
} from '../../src/lib/projects';
import { useVaultSession } from '../../src/lib/vault-session';
import { colors, type } from '../../src/ui';

/**
 * One project, read-only. Every string is rendered as plain selectable text:
 * no Markdown renderer and no tappable links, the same as memory detail.
 */
export default function ProjectDetailScreen() {
  const session = useVaultSession();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const result = useMemo(
    () => projectDetail(session.entries, typeof slug === 'string' ? slug : ''),
    [session.entries, slug],
  );

  if (session.status !== 'unlocked') return <Redirect href="/unlock" />;
  if (!result.ok) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>{result.message}</Text>
      </View>
    );
  }
  const d = result.detail;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: d.name }} />
      <Text style={styles.title} selectable>
        {d.name}
      </Text>
      <Text style={styles.meta}>
        {updatedLabel(d.updatedAt)}
        {d.appName ? ` by ${d.appName}` : ''}
      </Text>
      {d.draft ? <Text style={styles.note}>Draft, not yet confirmed.</Text> : null}

      <Section title="Current Status" blocks={d.status} empty="No status yet." />
      <Section title="Next Actions" blocks={d.nextActions} empty="None recorded." />
      <Section title="Decisions" blocks={d.decisions} empty="None recorded." />
      <Section title="Open Questions" blocks={d.openQuestions} empty="None recorded." />

      <Text style={styles.sectionTitle}>Log</Text>
      {d.log.length === 0 ? (
        <Text style={styles.empty}>No log entries yet.</Text>
      ) : (
        d.log.map((entry, i) => <Item key={i} text={entry} />)
      )}

      {d.files.length > 0 || d.filesText ? (
        <>
          <Text style={styles.sectionTitle}>Files</Text>
          {d.files.map((file, i) => (
            <View key={i} style={styles.file}>
              <Text style={styles.fileLabel} selectable>
                {file.label}
              </Text>
              <Text style={styles.fileMeta}>
                {FILE_TYPE_LABELS[file.type]}, {FILE_ACCESS_LABELS[file.access]}
              </Text>
              <Text style={styles.mono} selectable>
                {file.locator}
              </Text>
              {file.context ? (
                <Text style={styles.body} selectable>
                  {file.context}
                </Text>
              ) : null}
            </View>
          ))}
          {d.filesText ? (
            <Text style={styles.mono} selectable>
              {d.filesText}
            </Text>
          ) : null}
        </>
      ) : null}

      {d.whatWhy.length > 0 ? <Section title="What & Why" blocks={d.whatWhy} empty="" /> : null}
    </ScrollView>
  );
}

function Section({ title, blocks, empty }: { title: string; blocks: TextBlock[]; empty: string }) {
  return (
    <>
      <Text style={styles.sectionTitle}>{title}</Text>
      {blocks.length === 0 ? (
        <Text style={styles.empty}>{empty}</Text>
      ) : (
        blocks.map((block, i) =>
          block.kind === 'item' ? (
            <Item key={i} text={block.text} />
          ) : (
            <Text key={i} style={styles.paragraph} selectable>
              {block.text}
            </Text>
          ),
        )
      )}
    </>
  );
}

function Item({ text }: { text: string }) {
  return (
    <View style={styles.item}>
      <Text style={styles.bullet} accessibilityElementsHidden importantForAccessibility="no">
        {'•'}
      </Text>
      <Text style={styles.itemText} selectable>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.bg },
  missingText: { ...type.body, color: colors.muted, textAlign: 'center' },
  title: { ...type.title, color: colors.text },
  meta: { ...type.footnote, color: colors.muted, marginTop: 4 },
  note: { ...type.footnote, color: colors.warnText, marginTop: 6 },
  sectionTitle: {
    ...type.caption,
    color: colors.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
  },
  empty: { ...type.body, color: colors.muted },
  paragraph: { ...type.body, color: colors.text, marginBottom: 8 },
  body: { ...type.body, color: colors.text, marginTop: 4 },
  item: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  bullet: { ...type.body, color: colors.muted },
  itemText: { ...type.body, color: colors.text, flex: 1 },
  file: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 8,
  },
  fileLabel: { ...type.callout, color: colors.text },
  fileMeta: { ...type.caption, color: colors.muted, fontWeight: '400', marginTop: 2 },
  mono: { ...type.footnote, color: colors.text, fontFamily: 'Menlo', marginTop: 4 },
});
