import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { boxWindows, needsShowAll, type AcceptedLine, type NeedsYesItem } from '@northkeep/sync';
import type { ReviewResult, ReviewView } from '../src/lib/review-flow';
import {
  REVIEW_EMPTY_ACCEPTED,
  REVIEW_EMPTY_BODY,
  REVIEW_EMPTY_TITLE,
  REVIEW_FORGET_CONFIRM_BODY,
  REVIEW_FORGET_CONFIRM_TITLE,
  REVIEW_FORGOTTEN_LINE,
  REVIEW_NOTHING_ACCEPTED,
  REVIEW_SECTION_ACCEPTED,
  REVIEW_SECTION_NEEDS,
  REVIEW_TITLE,
  REVIEW_UNDO_CONFIRM_BODY,
  REVIEW_UNDO_CONFIRM_TITLE,
  acceptedLead,
  buttonLabels,
  checkedLine,
  dayLabel,
  hiddenLine,
  reviewHeading,
  sourceLines,
  waitingOnMacLine,
  yesLine,
} from '../src/lib/review-view';
import { classifyConnectorError } from '../src/lib/connect-flow';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, colors, type, useAnnounce } from '../src/ui';

/**
 * The Review tab (ADR 0095): what an AI app asked to change that needs a yes,
 * and what this phone already said yes to, each with an Undo where one
 * exists. Saved text is drawn only inside labelled boxes; every other word is
 * a fixed string from review-view.ts. The decisions live in review-flow.ts.
 */
export default function Review() {
  const session = useVaultSession();
  const [view, setView] = useState<ReviewView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Cards whose "Show all" has been opened. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  useAnnounce(notice);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setView(await session.review.refresh());
    } catch (err) {
      const outcome = classifyConnectorError(err);
      setError(outcome.message);
    }
  }, [session.review]);

  useEffect(() => {
    if (session.status === 'unlocked') void refresh();
  }, [session.status, refresh]);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  async function onPull() {
    setRefreshing(true);
    setNotice(null);
    await refresh();
    setRefreshing(false);
  }

  /** Run one decision, show what it said, and read the list again. */
  async function act(id: string, run: () => Promise<ReviewResult | void>) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const result = await run();
      if (result && result.kind !== 'done') setNotice(result.message);
      else if (result && result.note) setNotice(result.note);
      await refresh();
    } catch (err) {
      setError(classifyConnectorError(err).message);
    } finally {
      setBusyId(null);
    }
  }

  function onYes(item: NeedsYesItem) {
    const run = () => act(item.id, () => session.review.yes(item, opened[item.id] === true));
    if (item.kind !== 'forget') return void run();
    Alert.alert(REVIEW_FORGET_CONFIRM_TITLE, REVIEW_FORGET_CONFIRM_BODY, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => void run() },
    ]);
  }

  function onUndo(line: AcceptedLine) {
    Alert.alert(REVIEW_UNDO_CONFIRM_TITLE, REVIEW_UNDO_CONFIRM_BODY, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Undo', onPress: () => void act(line.id, () => session.review.undo(line)) },
    ]);
  }

  const now = new Date();
  const macLine = waitingOnMacLine(view?.waiting_on_mac ?? 0);
  const laterLine = hiddenLine(view?.hidden ?? 0);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onPull()} tintColor={colors.muted} />}
    >
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">{REVIEW_TITLE}</Text>
        <Text style={styles.small}>{checkedLine(view?.checked_at ?? null)}</Text>
      </View>
      <ErrorNote message={error} />
      {notice ? (
        <View style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel} accessibilityRole="header">
          {view && view.items.length > 0 ? `${REVIEW_SECTION_NEEDS} · ${view.items.length}` : REVIEW_SECTION_NEEDS}
        </Text>
        {view && view.items.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{REVIEW_EMPTY_TITLE}</Text>
            <Text style={styles.small}>{REVIEW_EMPTY_BODY}</Text>
            <Text style={styles.small}>{REVIEW_EMPTY_ACCEPTED}</Text>
          </View>
        ) : null}
        {(view?.items ?? []).map((item) => {
          const isOpen = opened[item.id] === true;
          const windows = boxWindows(item.boxes.map((b) => b.text));
          const cut = needsShowAll(item);
          const labels = buttonLabels(item.kind);
          const busy = busyId === item.id;
          return (
            <View key={item.id} style={styles.card}>
              <Text style={styles.cardTitle} accessibilityRole="header">{reviewHeading(item.kind)}</Text>
              {sourceLines(item).map((line) => (
                <Text key={line} style={styles.small}>{line}</Text>
              ))}
              {item.boxes.map((box, i) => {
                const w = windows[i]!;
                const shown = isOpen || !cut ? box.text : `${w.cut_start ? '… ' : ''}${w.text}${w.cut_end ? ' …' : ''}`;
                return (
                  <View key={box.label} style={styles.boxWrap}>
                    <Text style={styles.boxLabel}>{box.label}</Text>
                    <View style={styles.box} accessible accessibilityLabel={`${box.label}: ${shown}`}>
                      <Text style={styles.boxText}>{shown}</Text>
                    </View>
                  </View>
                );
              })}
              {cut && !isOpen ? (
                <Pressable
                  style={styles.showAll}
                  onPress={() => setOpened((o) => ({ ...o, [item.id]: true }))}
                  accessibilityRole="button"
                  accessibilityLabel="Show all of the text"
                >
                  <Text style={styles.showAllText}>Show all</Text>
                </Pressable>
              ) : null}
              <Text style={item.kind === 'forget' ? styles.warnLine : styles.small}>{yesLine(item.kind)}</Text>
              <View style={styles.buttons}>
                <Button
                  title={labels.yes}
                  kind={item.kind === 'forget' ? 'danger' : 'primary'}
                  style={styles.buttonWide}
                  disabled={busyId !== null || (cut && !isOpen)}
                  busy={busy}
                  onPress={() => onYes(item)}
                />
                <Button title={labels.no} kind="secondary" style={styles.button} disabled={busyId !== null} onPress={() => void act(item.id, () => session.review.no(item))} />
                <Button title={labels.later} kind="secondary" style={styles.button} disabled={busyId !== null} onPress={() => void act(item.id, () => session.review.notNow(item))} />
              </View>
            </View>
          );
        })}
        {laterLine ? <Text style={styles.small}>{laterLine}</Text> : null}
        {macLine ? <Text style={styles.small}>{macLine}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel} accessibilityRole="header">{REVIEW_SECTION_ACCEPTED}</Text>
        {view && view.accepted.length === 0 ? <Text style={styles.small}>{REVIEW_NOTHING_ACCEPTED}</Text> : null}
        {(view?.accepted ?? []).map((line) => (
          <View key={`${line.id}:${line.at}`} style={styles.card}>
            <View style={styles.lineHead}>
              <Text style={styles.lineLead}>{acceptedLead(line)}</Text>
              <Text style={styles.small}>{dayLabel(line.at, now)}</Text>
            </View>
            {line.kind === 'forget' ? <Text style={styles.small}>{REVIEW_FORGOTTEN_LINE}</Text> : null}
            {line.box ? (
              <Pressable
                style={styles.box}
                onPress={() => router.push(`/memory/${line.box!.memory_id}`)}
                accessibilityRole="button"
                accessibilityLabel={`New: ${line.box.text}. Opens the memory.`}
              >
                <Text style={styles.boxText} numberOfLines={3}>{line.box.text.length > 120 ? `${line.box.text.slice(0, 120)} …` : line.box.text}</Text>
              </Pressable>
            ) : null}
            {line.retired ? (
              <View style={styles.boxWrap}>
                <Text style={styles.boxLabel}>Retired</Text>
                <View style={styles.box}>
                  <Text style={styles.boxText} numberOfLines={3}>{line.retired.length > 120 ? `${line.retired.slice(0, 120)} …` : line.retired}</Text>
                </View>
              </View>
            ) : null}
            {line.can_undo ? (
              <Button title="Undo" kind="secondary" style={styles.undo} disabled={busyId !== null} busy={busyId === line.id} onPress={() => onUndo(line)} />
            ) : null}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 32, gap: 18 },
  header: { gap: 4 },
  title: { ...type.title, color: colors.text },
  small: { ...type.footnote, color: colors.muted },
  section: { gap: 12 },
  sectionLabel: { ...type.caption, color: colors.muted, letterSpacing: 1, textTransform: 'uppercase' },
  card: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 16, gap: 10 },
  cardTitle: { ...type.headline, color: colors.text },
  boxWrap: { gap: 4 },
  boxLabel: { ...type.caption, color: colors.muted },
  box: { borderLeftWidth: 3, borderLeftColor: colors.border, backgroundColor: colors.bg, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10 },
  boxText: { ...type.body, color: colors.text },
  showAll: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingRight: 12 },
  showAllText: { ...type.callout, color: colors.accent },
  warnLine: { ...type.footnote, color: colors.removed, fontWeight: '600' },
  buttons: { flexDirection: 'row', gap: 8 },
  buttonWide: { flex: 1.3, minHeight: 44 },
  button: { flex: 1, minHeight: 44 },
  undo: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18 },
  lineHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  lineLead: { ...type.callout, color: colors.text },
  notice: { backgroundColor: colors.warnBg, borderRadius: 8, padding: 12 },
  noticeText: { ...type.footnote, color: colors.warnText },
});
