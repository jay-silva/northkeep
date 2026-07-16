import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/**
 * Minimal shared UI for the M6-1 skeleton: enough visual consistency to
 * review the flow. Real design language (brand/, dark mode audit, dynamic
 * type) is M6-5 polish.
 */

export const colors = {
  bg: '#0f1420',
  card: '#1a2130',
  border: '#2a3346',
  text: '#e8ecf4',
  muted: '#8b94a7',
  accent: '#4f8cff',
  danger: '#e5484d',
  warnBg: '#3b2f14',
  warnText: '#f5d90a',
};

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
        <Text style={[styles.buttonText, kind === 'secondary' && styles.buttonTextSecondary]}>
          {props.title}
        </Text>
      )}
    </Pressable>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

/** Loud degradation banner (invariant #6). */
export function WarningBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.warnBox}>
      <Text style={styles.warnText}>{message}</Text>
    </View>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  buttonTextSecondary: { color: colors.text },
  errorBox: {
    backgroundColor: '#3b1a1c',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  errorText: { color: '#ff9599', fontSize: 14 },
  warnBox: {
    backgroundColor: colors.warnBg,
    padding: 12,
  },
  warnText: { color: colors.warnText, fontSize: 13, fontWeight: '600' },
  fieldLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
    marginTop: 16,
  },
});
