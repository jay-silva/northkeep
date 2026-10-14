import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import {
  FILE_ACCESS_LABELS,
  FILE_TYPE_LABELS,
  projectDetail,
  updatedLabel,
  type MilestoneLine,
  type MilestonesView,
  type TextBlock,
} from '../../src/lib/projects';
import { MilestoneTrack } from '../../src/MilestoneTrack';
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

      <Milestones view={d.milestones} />
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

/** Read only: the phone shows the plan and never changes it (ADR 0065 Decision 3). */
function Milestones({ view }: { view: MilestonesView }) {
  if (view.kind !== 'plan') {
    const text = view.kind === 'absent' ? 'No plan yet.'
      : view.kind === 'none' ? `No milestones planned: ${view.reason}`
      : 'The milestones in this project cannot be read here. Open NorthKeep on your Mac to repair them.';
    return (
      <>
        <Text style={styles.sectionTitle}>Milestones</Text>
        <Text style={view.kind === 'unreadable' ? styles.warn : styles.empty} selectable>{text}</Text>
      </>
    );
  }
  return (
    <>
      <View style={styles.progressCard} accessible accessibilityLabel={`${view.passed} of ${view.total} milestones passed. ${view.nowOn ? `Now on ${view.nowOn}.` : 'All passed.'}`}>
        <View style={styles.progressTop}>
          <Text style={styles.progressCount}>{view.passed} of {view.total} passed</Text>
          <Text style={styles.progressNow}>{view.nowOn ? `Now on ${view.nowOn}` : 'All passed'}</Text>
        </View>
        <MilestoneTrack passed={view.passed} total={view.total} hasCurrent={view.nowOn !== null} />
      </View>
      <Text style={styles.sectionTitle}>Milestones</Text>
      {view.lines.map((line, i) => <MilestoneRow key={line.id} line={line} last={i === view.lines.length - 1} />)}
    </>
  );
}

function MilestoneRow({ line, last }: { line: MilestoneLine; last: boolean }) {
  const passed = line.mark === 'you' || line.mark === 'agent';
  return (
    <View style={[styles.milestone, line.mark === 'current' && styles.milestoneCurrent, last && styles.milestoneLast]} accessible accessibilityLabel={line.label}>
      <View style={[styles.dot, line.mark === 'you' && styles.dotYou, line.mark === 'agent' && styles.dotAgent, line.mark === 'current' && styles.dotCurrent]}>
        {passed ? <Text style={[styles.check, line.mark === 'agent' && styles.checkAgent]}>{'✓'}</Text> : null}
        {line.mark === 'current' ? <View style={styles.dotInner} /> : null}
      </View>
      <View style={styles.milestoneText}>
        <Text style={[styles.milestoneTitle, passed && styles.milestoneTitlePassed]} selectable>
          {line.id} {line.title}
        </Text>
        {line.sub ? <Text style={styles.milestoneSub} selectable>{line.sub}</Text> : null}
      </View>
    </View>
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
  warn: { ...type.body, color: colors.warnText },
  progressCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, gap: 10, marginTop: 20 },
  progressTop: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  progressCount: { ...type.title, fontWeight: '500', color: colors.text, fontVariant: ['tabular-nums'] },
  progressNow: { ...type.footnote, color: colors.muted },
  milestone: { flexDirection: 'row', gap: 12, paddingVertical: 12, minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.border },
  milestoneLast: { borderBottomWidth: 0 },
  milestoneCurrent: { backgroundColor: colors.card, marginHorizontal: -20, paddingHorizontal: 17, borderLeftWidth: 3, borderLeftColor: colors.accent },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  dotYou: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
  dotAgent: { borderColor: colors.accent },
  dotCurrent: { borderColor: colors.accent },
  dotInner: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
  check: { fontSize: 12, lineHeight: 14, fontWeight: '700', color: '#ffffff' },
  checkAgent: { color: colors.accent },
  milestoneText: { flex: 1 },
  milestoneTitle: { ...type.body, color: colors.text },
  milestoneTitlePassed: { color: colors.muted },
  milestoneSub: { ...type.footnote, color: colors.muted, marginTop: 3 },
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
