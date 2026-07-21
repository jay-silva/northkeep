import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MEMORY_TYPES, type MemoryType } from '@northkeep/core';
import { announcementFor } from './lib/announce';
import {
  MAX_SCALE_DENSE,
  TYPE_SCALE as type,
  WEIGHTS as weight,
} from './lib/type-scale';

/**
 * Shared UI + design system. Wave 1 polish added: a semantic Dynamic-Type scale
 * (`type` / `weight`, from src/lib/type-scale.ts), VoiceOver announcements on
 * loud state (useAnnounce), a Reduce-Motion hook, one contrast fix, and touch
 * targets >= 44pt.
 */

export const colors = {
  // Matched to the desktop app's dark palette (site/index.html + web GUI): warm
  // near-black background, cream ink, sage-green accent. Replaces the old cold
  // navy/blue. `accent` is the light sage for text/links/badges on the dark bg;
  // `accentStrong` is the darker green used to fill primary buttons so white
  // button text keeps its contrast.
  bg: '#16140f',
  card: '#211e17',
  border: '#38332a',
  text: '#ece7db',
  muted: '#a39a88',
  accent: '#79b394',
  accentStrong: '#2f6a54',
  danger: '#e5484d',
  warnBg: '#3b2f14',
  warnText: '#f5d90a',
  // Coral red for the audit view's strike-through "removed" original. #c0625a
  // (the old value) was 4.07:1 on `card` and failed WCAG; this is 5.76:1 and
  // still reads as removed-red, distinct from the sage accent.
  removed: '#f0716b',
};

// Re-export the semantic scale so screens import roles from the design system.
export { type, weight };

/**
 * Speak `message` to VoiceOver when it appears or changes (iOS: the real
 * mechanism, since accessibilityLiveRegion is Android-only). Fires on
 * mount-with-value AND on change, and de-dupes identical unchanged values via
 * the pure announcementFor helper so the screen reader is never spammed.
 */
export function useAnnounce(message: string | null | undefined) {
  const prev = useRef<string>('');
  useEffect(() => {
    const speak = announcementFor(prev.current, message);
    prev.current = (message ?? '').trim();
    if (speak) AccessibilityInfo.announceForAccessibility(speak);
  }, [message]);
}

/** True when the OS "Reduce Motion" setting is on; live-updates on change. */
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

export function Button(props: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const kind = props.kind ?? 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled || props.busy }}
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.buttonSecondary,
        kind === 'danger' && styles.buttonDanger,
        (props.disabled || props.busy) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        props.style,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text
          // Cap so a huge accessibility size cannot overflow the label out of
          // the pill; body-length copy elsewhere still scales freely.
          maxFontSizeMultiplier={MAX_SCALE_DENSE}
          style={[styles.buttonText, kind === 'secondary' && styles.buttonTextSecondary]}
        >
          {props.title}
        </Text>
      )}
    </Pressable>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  // Hard failures: announce assertively so VoiceOver interrupts. The
  // accessibilityLiveRegion is the Android path; useAnnounce is the iOS path.
  useAnnounce(message);
  if (!message) return null;
  return (
    <View
      style={styles.errorBox}
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
    >
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

/** Loud degradation banner (invariant #6). Announces to VoiceOver on appear. */
export function WarningBanner({ message }: { message: string | null }) {
  useAnnounce(message);
  if (!message) return null;
  return (
    <View
      style={styles.warnBox}
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
    >
      <Text style={styles.warnText}>{message}</Text>
    </View>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text style={styles.fieldLabel} maxFontSizeMultiplier={MAX_SCALE_DENSE}>
      {children}
    </Text>
  );
}

/** Single-select chip row over the five memory types (shared by add + edit). */
export function TypeChips({ value, onChange }: { value: MemoryType; onChange: (t: MemoryType) => void }) {
  return (
    <View style={styles.chips}>
      {MEMORY_TYPES.map((t) => {
        const selected = t === value;
        return (
          <Pressable
            key={t}
            onPress={() => onChange(t)}
            // >= 44pt target: the chip is short, so hitSlop bridges the gap
            // without visually enlarging a dense row.
            hitSlop={8}
            style={[styles.chip, selected ? styles.chipSelected : styles.chipIdle]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text
              maxFontSizeMultiplier={MAX_SCALE_DENSE}
              style={selected ? styles.chipTextSelected : styles.chipTextIdle}
            >
              {t}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Loud sync-state indicator (M6-2, invariant #6 style): the sync status is
 * never hidden. 'error' and 'conflict-recovered' additionally show their detail
 * line so the user always knows when an edit did not reach the server or when a
 * two-sided conflict moved the other device's version to a recoverable .bak.
 *
 * `errorKind` (from SyncState.errorKind, set by classifySyncError) selects a
 * distinct presentation for subscription-required: a calm warn-colored state
 * rather than a red failure, with the neutral activation copy in the detail
 * line (WS4; the detail text is already neutral by the time it gets here).
 *
 * Accessibility (Wave 1): the colored dot is invisible to a screen reader, so
 * the row carries an accessibilityLabel that names the status in words, and
 * meaningful transitions (synced / not-synced / subscription / conflict)
 * announce to VoiceOver. Intermediate 'syncing'/'idle' ticks stay silent.
 */
export function SyncPill({
  status,
  detail,
  errorKind,
}: {
  status: 'idle' | 'syncing' | 'synced' | 'conflict-recovered' | 'error';
  detail: string | null;
  errorKind?: 'subscription-required' | 'not-enabled' | 'network' | 'other';
}) {
  const map = {
    idle: { label: 'Idle', dot: colors.muted, fg: colors.muted },
    syncing: { label: 'Syncing...', dot: colors.accent, fg: colors.accent },
    synced: { label: 'Synced', dot: '#4cc38a', fg: '#4cc38a' },
    'conflict-recovered': { label: 'Conflict resolved', dot: colors.warnText, fg: colors.warnText },
    error: { label: 'Not synced', dot: colors.danger, fg: '#ff9599' },
  } as const;
  const s =
    status === 'error' && errorKind === 'subscription-required'
      ? ({ label: 'Subscription required', dot: colors.warnText, fg: colors.warnText } as const)
      : map[status];
  const showDetail = detail && (status === 'error' || status === 'conflict-recovered');

  // Spoken form: only meaningful, settled transitions. 'syncing'/'idle' return
  // null so the screen reader is not narrated on every intermediate tick.
  const spoken =
    status === 'synced' || status === 'error' || status === 'conflict-recovered'
      ? `Sync status: ${s.label}.${showDetail ? ` ${detail}` : ''}`
      : null;
  useAnnounce(spoken);

  // Always-present label so the dot's color is legible to VoiceOver.
  const a11yLabel = `Sync status: ${s.label}.${showDetail ? ` ${detail}` : ''}`;

  return (
    <View style={styles.syncWrap} accessibilityLiveRegion="polite">
      <View style={styles.syncRow} accessible accessibilityLabel={a11yLabel}>
        {status === 'syncing' ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <View style={[styles.syncDot, { backgroundColor: s.dot }]} />
        )}
        <Text
          maxFontSizeMultiplier={MAX_SCALE_DENSE}
          style={[styles.syncLabel, { color: s.fg }]}
        >
          {s.label}
        </Text>
      </View>
      {showDetail ? <Text style={styles.syncDetail}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.accentStrong,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 18,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { ...type.callout, color: '#ffffff' },
  buttonTextSecondary: { color: colors.text },
  errorBox: {
    backgroundColor: '#3b1a1c',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  errorText: { ...type.subhead, color: '#ff9599' },
  warnBox: {
    backgroundColor: colors.warnBg,
    padding: 12,
  },
  warnText: { ...type.footnote, color: colors.warnText, fontWeight: weight.semibold },
  fieldLabel: {
    ...type.caption,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
    marginTop: 16,
  },
  syncWrap: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  syncDot: { width: 8, height: 8, borderRadius: 4 },
  syncLabel: { ...type.footnote, fontWeight: weight.semibold },
  syncDetail: { ...type.caption, color: colors.muted, fontWeight: weight.regular, lineHeight: 17, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipIdle: { borderColor: colors.border, backgroundColor: colors.card },
  // Contrast fix: dark bg text on the sage fill = 7.61:1 (was white-on-accent
  // 2.42:1 and failed WCAG). Matches providers.tsx kindChipOn.
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  chipTextIdle: { ...type.footnote, color: colors.muted, fontWeight: weight.semibold },
  chipTextSelected: { ...type.footnote, color: colors.bg, fontWeight: weight.semibold },
});
