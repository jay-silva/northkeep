import React from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from './ui';

/**
 * One segment per milestone: filled when passed, half-filled for the current
 * one, empty after it. Decorative only; the text beside it carries the meaning.
 */
export function MilestoneTrack({ passed, total, hasCurrent, compact }: { passed: number; total: number; hasCurrent: boolean; compact?: boolean }) {
  return (
    <View style={[styles.track, compact && styles.compact, compact && total > 10 && styles.tight]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[styles.segment, i < passed ? styles.done : i === passed && hasCurrent ? styles.current : null]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', gap: 4 },
  compact: { width: 80, gap: 3 },
  tight: { gap: 1 },
  segment: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.border },
  done: { backgroundColor: colors.accent },
  current: { backgroundColor: colors.accent, opacity: 0.45 },
});
